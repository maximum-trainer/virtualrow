/**
 * Three-free port of `src/components/rower3d/cameraRig.ts` (#550 FR5).
 *
 * The three version damps the camera's *offset* from the boat and reads the
 * boat's own motion exactly; keep the same shape here, with `vec3Damp` as
 * the frame-rate-independent exponential follower.
 */

import { vec3Copy, vec3Damp, vec3Lerp, vec3Set, type Vec3 } from '../math/vec3';
import { vec3 } from '../math/vec3';

export type CameraView = 'chase' | 'side' | 'bow' | 'high';

export const CAMERA_VIEWS: readonly CameraView[] = ['chase', 'side', 'bow', 'high'];

const BOW_METRES = 4.4;

interface ViewOffset {
  back: number;
  up: number;
  side: number;
  ahead: number;
}

const OFFSETS: Record<CameraView, ViewOffset> = {
  chase: { back: 7, up: 2.6, side: 0, ahead: 0 },
  side: { back: 0, up: 3, side: 12, ahead: 0 },
  bow: { back: -(BOW_METRES + 0.8), up: 1.1, side: 0, ahead: 30 },
  high: { back: 18, up: 9, side: 0, ahead: 0 },
};

export const BASE_FOV = 58;
export const FOV_SPEED_RANGE = 10;
export const FOV_FULL_SPEED = 5;
export const POSITION_TAU = 0.35;
export const LOOK_AT_TAU = 0.2;

export interface RigInput {
  boat: Vec3;
  tangent: Vec3;
  velocityMps: number;
  view: CameraView;
  bendSign: number;
  reducedMotion?: boolean;
  /**
   * #724 VP-06 FR4 — the deck underside over world (x, z), +Infinity in
   * open sky. The camera stays `CEILING_CLEARANCE_METRES` below it.
   */
  ceilingAt?: (x: number, z: number) => number;
}

/** How far under a bridge deck the camera keeps (#724 FR4). */
export const CEILING_CLEARANCE_METRES = 1;

export interface RigTarget {
  position: Vec3;
  lookAt: Vec3;
  fov: number;
}

export const createRigTarget = (): RigTarget => ({
  position: vec3(),
  lookAt: vec3(),
  fov: BASE_FOV,
});

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const cameraTarget = (
  { boat, tangent, velocityMps, view, bendSign, reducedMotion = false, ceilingAt }: RigInput,
  out: RigTarget,
): RigTarget => {
  const offset = OFFSETS[view] ?? OFFSETS.chase;
  const perpX = -tangent[2];
  const perpZ = tangent[0];
  const side = offset.side * (bendSign === 0 ? 1 : Math.sign(bendSign));

  vec3Set(
    out.position,
    boat[0] - tangent[0] * offset.back + perpX * side,
    boat[1] + offset.up,
    boat[2] - tangent[2] * offset.back + perpZ * side,
  );
  if (ceilingAt) {
    const ceiling = ceilingAt(out.position[0], out.position[2]) - CEILING_CLEARANCE_METRES;
    if (ceiling < out.position[1]) out.position[1] = ceiling;
  }
  vec3Set(
    out.lookAt,
    boat[0] + tangent[0] * offset.ahead,
    boat[1] + 0.3,
    boat[2] + tangent[2] * offset.ahead,
  );
  out.fov = reducedMotion
    ? BASE_FOV
    : BASE_FOV + FOV_SPEED_RANGE * clamp(velocityMps / FOV_FULL_SPEED, 0, 1);

  return out;
};

export const portraitFov = (baseFov: number, aspect: number): number => {
  if (!Number.isFinite(aspect) || aspect <= 0 || aspect >= 1) return baseFov;
  return Math.min(100, baseFov + (1 - aspect) * 35);
};

export const nextView = (view: CameraView): CameraView => {
  const index = CAMERA_VIEWS.indexOf(view);
  return CAMERA_VIEWS[(index + 1) % CAMERA_VIEWS.length] ?? CAMERA_VIEWS[0];
};

export const isCameraView = (value: unknown): value is CameraView =>
  typeof value === 'string' && (CAMERA_VIEWS as readonly string[]).includes(value);

/**
 * Move `offset` towards the current target offset, then write the world
 * camera position back into `out`. See the three version for why the offset
 * (not the world position) is what gets damped.
 */
export const dampedFollowOffset = (
  offset: Vec3,
  targetOffset: Vec3,
  boat: Vec3,
  tau: number,
  dt: number,
  out: Vec3,
): Vec3 => {
  vec3Damp(offset, offset, targetOffset, tau, dt);
  out[0] = boat[0] + offset[0];
  out[1] = boat[1] + offset[1];
  out[2] = boat[2] + offset[2];
  return out;
};

// ---------------------------------------------------------------------------
// #735 VP-17 — the applied camera. `cameraTarget` says where the rig wants to
// be this frame; the rig below follows it, so a late distance sample or a
// tangent change eases in instead of jolting the whole view.

/** Speed low-pass time constant feeding the FOV (FR2). */
export const FOV_SPEED_TAU = 1.5;
/** The FOV never moves faster than this (FR2). */
export const FOV_MAX_RATE_DEG_PER_S = 4;
/** A V-key view switch blends over this long (FR1). */
export const VIEW_BLEND_SECONDS = 0.4;
/** Longest step the rig integrates: a background-tab resume is not a lurch. */
export const MAX_CAMERA_DT = 0.1;
/** Further than this from its target, the camera snaps (restart, new route). */
export const CAMERA_SNAP_METRES = 50;

export interface CameraStepInput extends RigInput {
  /** Seconds since the last step; clamped to {@link MAX_CAMERA_DT}. */
  dt: number;
  /** Canvas width / height, for the portrait widening (FR3). */
  aspect: number;
  /** Jump straight to the target this frame (a spec's seek is a teleport). */
  snap?: boolean;
}

export interface CameraRigState {
  /** What the renderer uses this frame. */
  readonly applied: RigTarget;
  /** Where the rig wanted to be this frame. */
  readonly target: RigTarget;
  initialised: boolean;
  view: CameraView | null;
  readonly damped: { position: Vec3; lookAt: Vec3 };
  readonly blendFrom: { position: Vec3; lookAt: Vec3 };
  blendElapsed: number;
  filteredSpeed: number;
  /** Rate-limited landscape FOV, before the portrait widening. */
  fov: number;
}

export const createCameraRig = (): CameraRigState => ({
  applied: createRigTarget(),
  target: createRigTarget(),
  initialised: false,
  view: null,
  damped: { position: vec3(), lookAt: vec3() },
  blendFrom: { position: vec3(), lookAt: vec3() },
  blendElapsed: VIEW_BLEND_SECONDS,
  filteredSpeed: 0,
  fov: BASE_FOV,
});

const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

const distanceBetween = (a: Vec3, b: Vec3): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Advance the camera one frame towards this frame's rig target and return
 * the camera to draw with (`rig.applied`).
 */
export const stepCameraRig = (rig: CameraRigState, input: CameraStepInput): RigTarget => {
  const reducedMotion = input.reducedMotion ?? false;
  const dt = clamp(Number.isFinite(input.dt) ? input.dt : 0, 0, MAX_CAMERA_DT);
  // The target's FOV is ignored: the rig derives its own from filtered speed.
  cameraTarget(input, rig.target);
  const speed = Math.max(0, Number.isFinite(input.velocityMps) ? input.velocityMps : 0);

  const snap =
    !rig.initialised ||
    input.snap === true || distanceBetween(rig.damped.position, rig.target.position) > CAMERA_SNAP_METRES;
  if (snap) {
    vec3Copy(rig.damped.position, rig.target.position);
    vec3Copy(rig.damped.lookAt, rig.target.lookAt);
    rig.blendElapsed = VIEW_BLEND_SECONDS;
    rig.filteredSpeed = speed;
    rig.fov = reducedMotion ? BASE_FOV : fovForSpeed(speed);
    rig.view = input.view;
    rig.initialised = true;
  } else {
    if (input.view !== rig.view) {
      // Blend from what is on screen now to the new view's damped follow,
      // which starts on its own target so the blend is the only motion.
      vec3Copy(rig.blendFrom.position, rig.applied.position);
      vec3Copy(rig.blendFrom.lookAt, rig.applied.lookAt);
      vec3Copy(rig.damped.position, rig.target.position);
      vec3Copy(rig.damped.lookAt, rig.target.lookAt);
      rig.blendElapsed = 0;
      rig.view = input.view;
    }
    const lagScale = reducedMotion ? 0.5 : 1;
    vec3Damp(rig.damped.position, rig.damped.position, rig.target.position, POSITION_TAU * lagScale, dt);
    vec3Damp(rig.damped.lookAt, rig.damped.lookAt, rig.target.lookAt, LOOK_AT_TAU * lagScale, dt);
    rig.blendElapsed = Math.min(VIEW_BLEND_SECONDS, rig.blendElapsed + dt);

    rig.filteredSpeed += (speed - rig.filteredSpeed) * (1 - Math.exp(-dt / FOV_SPEED_TAU));
    const wanted = reducedMotion ? BASE_FOV : fovForSpeed(rig.filteredSpeed);
    if (reducedMotion) {
      rig.fov = BASE_FOV;
    } else {
      const maxStep = FOV_MAX_RATE_DEG_PER_S * dt;
      rig.fov += clamp(wanted - rig.fov, -maxStep, maxStep);
    }
  }

  const s = smoothstep(rig.blendElapsed / VIEW_BLEND_SECONDS);
  vec3Lerp(rig.applied.position, rig.blendFrom.position, rig.damped.position, s);
  vec3Lerp(rig.applied.lookAt, rig.blendFrom.lookAt, rig.damped.lookAt, s);
  if (input.ceilingAt) {
    // The damped camera trails its target, so it can still be where the
    // target was before the deck: keep it under the deck too (#724 FR4).
    const ceiling = input.ceilingAt(rig.applied.position[0], rig.applied.position[2]) - CEILING_CLEARANCE_METRES;
    if (ceiling < rig.applied.position[1]) rig.applied.position[1] = ceiling;
  }
  rig.applied.fov = portraitFov(rig.fov, input.aspect);
  return rig.applied;
};

const fovForSpeed = (speed: number): number =>
  BASE_FOV + FOV_SPEED_RANGE * clamp(speed / FOV_FULL_SPEED, 0, 1);

/** A bend smaller than this (tangent change, unit vectors) keeps the side. */
export const BEND_SIGN_THRESHOLD = 0.02;

/**
 * FR5 — which side the side camera sits on: the outside of the bend between
 * the boat's tangent `t0` and the tangent a little way ahead `t1`. Returns
 * `previous` on a straight or barely curved reach so the camera does not
 * swap sides on every wiggle.
 */
export const bendSignFromTangents = (t0: Vec3, t1: Vec3, previous: number): number => {
  const perpX = -t0[2];
  const perpZ = t0[0];
  const turn = (t1[0] - t0[0]) * perpX + (t1[2] - t0[2]) * perpZ;
  if (Math.abs(turn) < BEND_SIGN_THRESHOLD) return previous;
  return turn > 0 ? -1 : 1;
};
