/**
 * Oar-blade splash particles (#571 slice: oar-blade splash / puddle at
 * catch/finish, reworked by #722 VP-04). Pairs with the hull wake pass —
 * the wake lays down a continuous foam trail behind the stern; this fires
 * a short burst at each blade tip whenever the stroke phase crosses the
 * catch (phase 0) or finish (phase 0.5) boundary.
 *
 * Each blade burst is a few small drops thrown in a low arc (FR4) plus one
 * flat ring spreading on the water. Drops are back in the water before
 * their lifetime ends, and the shader hides them once they land, so
 * nothing hangs in mid-air.
 *
 * Pool layout per particle (12 floats = three `vec4<f32>` reads in WGSL):
 *   [0..3]   x, y, z, age
 *   [4..7]   lifetime, size, vx, vz (vy comes from the shader-side arc,
 *            `oarSplashDropHeight`, so it isn't stored)
 *   [8..11]  kind (drop / ring), seed, _pad, _pad
 */

import { WATER_SURFACE_Y } from '../plan/waterStrip';

export const OAR_SPLASH_FLOATS_PER_PARTICLE = 12;
export const OAR_SPLASH_POOL_SIZE_DEFAULT = 128;
/** FR4: a splash is gone within 0.45 s. */
export const OAR_SPLASH_LIFETIME_SEC = 0.4;
export const OAR_SPLASH_DROPS_PER_BLADE = 4;
/** Drops plus the one ring, per blade per burst. */
export const OAR_SPLASH_BURST_SIZE = OAR_SPLASH_DROPS_PER_BLADE + 1;
export const OAR_SPLASH_LATERAL_OFFSET_METRES = 2.4; // blade tip offset from hull centreline
export const OAR_SPLASH_HEIGHT_METRES = -0.05; // where a drop leaves the water

export const OAR_SPLASH_KIND_DROP = 0;
export const OAR_SPLASH_KIND_RING = 1;

/** FR4: drop radius cap (the issue's 0.3 m ceiling, with headroom). */
export const OAR_SPLASH_DROP_MAX_SIZE_METRES = 0.14;
const OAR_SPLASH_DROP_MIN_SIZE_METRES = 0.06;
/** FR4 low arc: launch speed. 1.4 m/s tops out ~0.1 m above the blade. */
export const OAR_SPLASH_DROP_INITIAL_UP_MPS = 1.4;
const GRAVITY_MPS2 = 9.8;

/** FR4: the ring lies flat just above the water and spreads to 0.3 m. */
export const OAR_SPLASH_RING_Y = WATER_SURFACE_Y + 0.025;
export const OAR_SPLASH_RING_START_RADIUS_METRES = 0.08;
export const OAR_SPLASH_RING_END_RADIUS_METRES = 0.3;

/** Height of a drop above its launch point `age` seconds after the catch;
 *  mirrors the arc in `oarSplashParticles.wgsl`. */
export const oarSplashDropHeight = (age: number): number =>
  OAR_SPLASH_DROP_INITIAL_UP_MPS * age - 0.5 * GRAVITY_MPS2 * age * age;

export interface OarSplashState {
  readonly pool: Float32Array;
  readonly size: number;
  readonly lifetimeSec: number;
  cursor: number;
  /** Last observed stroke phase in [0, 1); used to detect catch (0) and
   *  finish (0.5) crossings between frames. */
  lastPhase: number;
  spawnCount: number;
}

export const createOarSplashState = (
  size = OAR_SPLASH_POOL_SIZE_DEFAULT,
  lifetimeSec = OAR_SPLASH_LIFETIME_SEC,
): OarSplashState => ({
  pool: new Float32Array(size * OAR_SPLASH_FLOATS_PER_PARTICLE),
  size,
  lifetimeSec,
  cursor: 0,
  lastPhase: 0,
  spawnCount: 0,
});

const ageAll = (state: OarSplashState, dt: number): void => {
  const d = dt > 0 ? dt : 0;
  const stride = OAR_SPLASH_FLOATS_PER_PARTICLE;
  const pool = state.pool;
  for (let i = 0; i < state.size; i += 1) {
    const base = i * stride;
    if (pool[base + 4] <= 0) continue;
    pool[base + 3] += d;
  }
};

const spawnOne = (
  state: OarSplashState,
  kind: number,
  x: number,
  y: number,
  z: number,
  size: number,
  vx: number,
  vz: number,
): void => {
  const base = state.cursor * OAR_SPLASH_FLOATS_PER_PARTICLE;
  state.pool[base + 0] = x;
  state.pool[base + 1] = y;
  state.pool[base + 2] = z;
  state.pool[base + 3] = 0;
  state.pool[base + 4] = state.lifetimeSec;
  state.pool[base + 5] = size;
  state.pool[base + 6] = vx;
  state.pool[base + 7] = vz;
  state.pool[base + 8] = kind;
  state.pool[base + 9] = (state.spawnCount * 0.618034) % 1;
  state.pool[base + 10] = 0;
  state.pool[base + 11] = 0;
  state.cursor = (state.cursor + 1) % state.size;
  state.spawnCount += 1;
};

/** True when `prev → curr` crosses the given threshold inside [0, 1). */
const crossedBoundary = (prev: number, curr: number, boundary: number): boolean => {
  // Normal case: forward step across boundary.
  if (prev < boundary && curr >= boundary) return true;
  // Wrap case: prev was > curr (crossed 1→0), check whether boundary
  // sits in the wrap. The boundary we care about either lies in
  // (prev, 1] or in [0, curr]. For 0-boundary any wrap counts.
  if (curr < prev) {
    if (boundary === 0) return true;
    if (boundary > prev || boundary <= curr) return true;
  }
  return false;
};

/**
 * Deterministic hash-driven jitter so adjacent bursts don't collapse
 * into the same stamp. Seeds should include the spawn count so each
 * particle gets its own direction.
 */
const jitter = (seed: number): number => {
  const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s); // [0, 1)
};

const burstAt = (
  state: OarSplashState,
  centreX: number,
  centreZ: number,
  perp: { x: number; z: number },
): void => {
  for (let i = 0; i < OAR_SPLASH_DROPS_PER_BLADE; i += 1) {
    // Spread drops in a tight patch around the blade tip.
    const seed = state.spawnCount + i * 0.37;
    const x = centreX + (jitter(seed) - 0.5) * 0.3;
    const z = centreZ + (jitter(seed + 1) - 0.5) * 0.3;
    // Lateral velocity: outward from the blade centre, so the spray
    // reads as water flicked sideways rather than drifting straight back.
    const vMag = 0.3 + jitter(seed + 2) * 0.4;
    const vx = perp.x * vMag + (jitter(seed + 3) - 0.5) * 0.3;
    const vz = perp.z * vMag + (jitter(seed + 4) - 0.5) * 0.3;
    const size =
      OAR_SPLASH_DROP_MIN_SIZE_METRES +
      jitter(seed + 5) * (OAR_SPLASH_DROP_MAX_SIZE_METRES - OAR_SPLASH_DROP_MIN_SIZE_METRES);
    spawnOne(state, OAR_SPLASH_KIND_DROP, x, OAR_SPLASH_HEIGHT_METRES, z, size, vx, vz);
  }
  spawnOne(state, OAR_SPLASH_KIND_RING, centreX, OAR_SPLASH_RING_Y, centreZ, 1, 0, 0);
};

/**
 * Run one frame of the oar-splash sim. Catches both the catch
 * (phase ≈ 0) and the finish (phase ≈ 0.5) via phase-crossing
 * detection, then drops one burst per blade. `isPlaying = false`
 * ages the pool without spawning (the puddle trailing behind the hull
 * dies down when the rower stops).
 */
export const updateOarSplash = (
  state: OarSplashState,
  boatWorldX: number,
  boatWorldZ: number,
  boatHeadingRadians: number,
  strokePhase: number,
  isPlaying: boolean,
  dt: number,
): void => {
  ageAll(state, dt);
  if (!isPlaying) {
    state.lastPhase = strokePhase;
    return;
  }
  const sinH = Math.sin(boatHeadingRadians);
  const cosH = Math.cos(boatHeadingRadians);
  // Local-X in world space (starboard direction after the heading yaw).
  const starboardX = cosH;
  const starboardZ = -sinH;
  const atCatch = crossedBoundary(state.lastPhase, strokePhase, 0);
  const atFinish = crossedBoundary(state.lastPhase, strokePhase, 0.5);
  if (atCatch || atFinish) {
    const port = { x: -starboardX, z: -starboardZ };
    const stbd = { x: starboardX, z: starboardZ };
    const portBladeX = boatWorldX - starboardX * OAR_SPLASH_LATERAL_OFFSET_METRES;
    const portBladeZ = boatWorldZ - starboardZ * OAR_SPLASH_LATERAL_OFFSET_METRES;
    const stbdBladeX = boatWorldX + starboardX * OAR_SPLASH_LATERAL_OFFSET_METRES;
    const stbdBladeZ = boatWorldZ + starboardZ * OAR_SPLASH_LATERAL_OFFSET_METRES;
    burstAt(state, portBladeX, portBladeZ, port);
    burstAt(state, stbdBladeX, stbdBladeZ, stbd);
  }
  state.lastPhase = strokePhase;
};

export const activeOarSplashCount = (state: OarSplashState): number => {
  let n = 0;
  const stride = OAR_SPLASH_FLOATS_PER_PARTICLE;
  for (let i = 0; i < state.size; i += 1) {
    const base = i * stride;
    if (state.pool[base + 4] <= 0) continue;
    if (state.pool[base + 3] < state.pool[base + 4]) n += 1;
  }
  return n;
};
