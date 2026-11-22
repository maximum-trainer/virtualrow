/**
 * Hull wake particles (#571 slice: water-wake / foam under the hull).
 *
 * A tiny CPU particle system: spawn a foam patch at the boat's stern every
 * ~`spawnIntervalSec`, let it spread and fade to zero over `lifetimeSec`.
 * Rendered by `passes/wakeParticles.ts` as quads lying flat on the water
 * (#722 VP-04 FR1), sized and faded by `wakeSpriteParams`.
 *
 * The pool is a fixed-size ring buffer so updates and GPU writes are
 * allocation-free each frame. The particle count caps the GPU draw, so a
 * stuck-high spawn rate can only ever waste one frame's slots before the
 * ring overwrites itself.
 *
 * Pure TypeScript — no GPU surface — so the unit tests can exercise
 * spawn, age, fade and world-position maths without a device.
 */

import { WATER_SURFACE_Y } from '../plan/waterStrip';

/** How much state each particle carries. The GPU-side storage buffer
 *  reads particles as pairs of `vec4<f32>` (vertex shader indexes
 *  `particles[ii*2]` + `particles[ii*2+1]`), so the stride is 8 floats
 *  / 32 bytes per instance. Layout:
 *    [0..3]  x, y, z, age
 *    [4..7]  lifetime, size, seed, _pad
 *  `seed` varies the shader's foam break-up per particle; the pad keeps
 *  the vec4-aligned storage buffer happy. */
export const WAKE_FLOATS_PER_PARTICLE = 8;

/** Default pool size — enough for ~2 s of wake at 20 Hz spawn (~40 live
 *  particles at a time), with headroom for a larger window if the spawn
 *  rate ticks up. */
export const WAKE_POOL_SIZE_DEFAULT = 128;

/** How long each particle lives (seconds). The ride-view wake fades out
 *  comfortably inside the fog near-plane, so even on a basic tier the
 *  particle disappears before it enters any read-anomalous region. */
export const WAKE_LIFETIME_SEC_DEFAULT = 1.6;

/** Shortest interval between spawns. Each spawn drops two particles —
 *  one for the port side of the stern, one for starboard — so the real
 *  spawn rate is 2 / spawnInterval. */
export const WAKE_SPAWN_INTERVAL_SEC_DEFAULT = 0.08;

/** Lateral offset either side of the stern where particles emerge. */
export const WAKE_HALF_WIDTH_METRES = 0.45;

/** How far behind the boat origin the stern sits (hull is ~8 m long;
 *  origin is at the midship line in the loaded shell GLB). */
export const WAKE_STERN_OFFSET_METRES = -3.4;

/** FR1: foam lies this far above the water surface, enough to win the
 *  depth test against the water without visibly floating. */
export const WAKE_WATER_BIAS_METRES = 0.02;
export const WAKE_FOAM_Y = WATER_SURFACE_Y + WAKE_WATER_BIAS_METRES;

/** FR2: radius of a patch when it spawns and when it dies. */
export const WAKE_START_RADIUS_METRES = 0.22;
export const WAKE_END_RADIUS_METRES = 0.85;
/** FR2: the most opaque a patch ever gets. */
export const WAKE_PEAK_ALPHA = 0.32;

/** FR3: a jump in boat position longer than this between two frames is a
 *  teleport (lap seam, restart), not travel, so catch-up spawns are not
 *  strung along it. */
export const WAKE_MAX_INTERPOLATION_METRES = 10;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Radius and alpha of a wake patch at `lifeFrac` in [0, 1]. Mirrored by
 * `wakeParticles.wgsl`: fades in over the first 15 % of its life (the
 * boat is still over it), then out from 40 % on.
 */
export const wakeSpriteParams = (lifeFrac: number): { radius: number; alpha: number } => {
  const f = Math.max(0, Math.min(1, lifeFrac));
  const radius = WAKE_START_RADIUS_METRES + (WAKE_END_RADIUS_METRES - WAKE_START_RADIUS_METRES) * f;
  const alpha = smoothstep(0, 0.15, f) * (1 - smoothstep(0.4, 1, f)) * WAKE_PEAK_ALPHA;
  return { radius, alpha };
};

/** Pool state. Mutable in place — never recreate per frame. */
export interface WakeState {
  readonly pool: Float32Array;
  readonly size: number;
  readonly lifetimeSec: number;
  readonly spawnIntervalSec: number;
  /** Ring-buffer write cursor (0..size-1). */
  cursor: number;
  /** Seconds remaining before the next spawn. Advances each `updateWake`. */
  secondsUntilNextSpawn: number;
  /** How many particles have ever been spawned (test helper + telemetry). */
  spawnCount: number;
  /** Boat position at the end of the previous update (FR3); NaN before the first. */
  lastBoatX: number;
  lastBoatZ: number;
}

export const createWakeState = (
  size = WAKE_POOL_SIZE_DEFAULT,
  lifetimeSec = WAKE_LIFETIME_SEC_DEFAULT,
  spawnIntervalSec = WAKE_SPAWN_INTERVAL_SEC_DEFAULT,
): WakeState => ({
  pool: new Float32Array(size * WAKE_FLOATS_PER_PARTICLE),
  size,
  lifetimeSec,
  spawnIntervalSec,
  cursor: 0,
  // Prime the clock to the full interval so the first `updateWake` with
  // `dt = spawnIntervalSec` fires exactly one spawn (2 particles), not two.
  secondsUntilNextSpawn: spawnIntervalSec,
  spawnCount: 0,
  lastBoatX: Number.NaN,
  lastBoatZ: Number.NaN,
});

/** Advance every particle's `age` by `dt`. Negative dt is clamped to 0. */
const ageAll = (state: WakeState, dt: number): void => {
  const d = dt > 0 ? dt : 0;
  const stride = WAKE_FLOATS_PER_PARTICLE;
  const pool = state.pool;
  for (let i = 0; i < state.size; i += 1) {
    const base = i * stride;
    const lifetime = pool[base + 4];
    if (lifetime <= 0) continue; // never spawned
    pool[base + 3] += d; // age
  }
};

/** Spawn one particle at the given world XZ, already `age` seconds old. */
const spawnOne = (state: WakeState, x: number, z: number, age: number): void => {
  const base = state.cursor * WAKE_FLOATS_PER_PARTICLE;
  state.pool[base + 0] = x;
  state.pool[base + 1] = WAKE_FOAM_Y;
  state.pool[base + 2] = z;
  state.pool[base + 3] = age;
  state.pool[base + 4] = state.lifetimeSec;
  state.pool[base + 5] = 1; // size multiplier on wakeSpriteParams' radius
  state.pool[base + 6] = (state.spawnCount * 0.618034) % 1; // break-up seed
  state.pool[base + 7] = 0; // pad
  state.cursor = (state.cursor + 1) % state.size;
  state.spawnCount += 1;
};

/**
 * Run one frame of the wake system. Idle (`isMoving = false`) ages
 * particles but spawns nothing — the trail dies down behind a stationary
 * boat. Call once per frame from the ride loop.
 *
 * FR3: when a frame is long enough to owe several spawns, each one is
 * placed where the stern was at its own moment in the frame (a straight
 * interpolation from last frame's boat position) and given the age it
 * would have had, so a hitch spreads the foam along the track instead of
 * stacking it into one bright blob.
 */
export const updateWake = (
  state: WakeState,
  boatWorldX: number,
  boatWorldZ: number,
  boatHeadingRadians: number,
  isMoving: boolean,
  dt: number,
): void => {
  const d = dt > 0 ? dt : 0;
  ageAll(state, d);
  const prevX = state.lastBoatX;
  const prevZ = state.lastBoatZ;
  state.lastBoatX = boatWorldX;
  state.lastBoatZ = boatWorldZ;
  if (!isMoving) return;
  const interpolate =
    Number.isFinite(prevX) && Math.hypot(boatWorldX - prevX, boatWorldZ - prevZ) <= WAKE_MAX_INTERPOLATION_METRES;
  const fromX = interpolate ? prevX : boatWorldX;
  const fromZ = interpolate ? prevZ : boatWorldZ;

  // Local-space stern offset: along -Z in boat local, with ±X for port/
  // starboard. World-rotate by the boat's Y heading (same convention as
  // `mat4FromRotationY` — `angle = atan2(tangent.x, tangent.z)`).
  const sinH = Math.sin(boatHeadingRadians);
  const cosH = Math.cos(boatHeadingRadians);
  const sternDx = WAKE_STERN_OFFSET_METRES * sinH;
  const sternDz = WAKE_STERN_OFFSET_METRES * cosH;
  const sideDx = WAKE_HALF_WIDTH_METRES * cosH;
  const sideDz = -WAKE_HALF_WIDTH_METRES * sinH;

  // Spawn k falls `t` seconds into this frame; it is `d - t` old by now.
  let t = state.secondsUntilNextSpawn;
  while (t <= d) {
    const age = d - t;
    // A spawn that would already be dead is only a clock tick.
    if (age < state.lifetimeSec) {
      const f = d > 0 ? t / d : 1;
      const sternX = fromX + (boatWorldX - fromX) * f + sternDx;
      const sternZ = fromZ + (boatWorldZ - fromZ) * f + sternDz;
      spawnOne(state, sternX + sideDx, sternZ + sideDz, age);
      spawnOne(state, sternX - sideDx, sternZ - sideDz, age);
    }
    t += state.spawnIntervalSec;
  }
  state.secondsUntilNextSpawn = t - d;
};

/**
 * How many particles are currently alive (age < lifetime). O(size), used
 * by the GPU pass to shrink the instanced draw and by the tests to
 * check lifecycle.
 */
export const activeWakeCount = (state: WakeState): number => {
  let n = 0;
  const stride = WAKE_FLOATS_PER_PARTICLE;
  for (let i = 0; i < state.size; i += 1) {
    const base = i * stride;
    const lifetime = state.pool[base + 4];
    if (lifetime <= 0) continue;
    if (state.pool[base + 3] < lifetime) n += 1;
  }
  return n;
};
