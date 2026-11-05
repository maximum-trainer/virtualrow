/**
 * The rowing stroke for the HD rower (#672 follow-up, "full stroke" decision).
 *
 * The crew GLB is a rigid-part model posed at the catch: every body part is
 * its own node, with no skin or bones. This module poses those parts for any
 * oar angle. The legs drive the seat back, the body swings from its forward
 * lean to past upright, and the arms reach the oar handles by two-bone IK.
 * The oar's sweep is the single input, so the body can never drift out of
 * time with the oars.
 *
 * Everything is in scull space (the GLB's own frame: +Y up, +Z toward the
 * rower's feet). The engine multiplies the returned part matrix between
 * the boat transform and each primitive's node matrix.
 *
 * The joint tables mirror `skeleton()` in `scripts/crew_body.py`, and the oar
 * numbers mirror `OARLOCK` / `GATE_OFFSET` / `OAR_DROOP_DEG` in
 * `scripts/build_crew.py`. `crewStrokeGlbContract.test.ts` checks both
 * against the shipped GLBs, so a regenerate that moves a joint fails there.
 *
 * Pure and GPU-free.
 */

import type { Crew } from '../../../components/rower3d/crewModel';

export type Vec3 = readonly [number, number, number];
export type Side = 'left' | 'right';

interface LimbJoints {
  readonly shoulder: Vec3;
  readonly elbow: Vec3;
  /** Grip: the centre of the fist, on the handle. The forearm ends 6 cm short of it. */
  readonly hand: Vec3;
  readonly hip: Vec3;
  readonly knee: Vec3;
  readonly ankle: Vec3;
}

export interface CrewRig {
  readonly pelvis: Vec3;
  /** Trunk lean from vertical at the catch, toward the feet. */
  readonly leanDeg: number;
  readonly left: LimbJoints;
  readonly right: LimbJoints;
}

const mirror = (j: LimbJoints): LimbJoints => {
  const m = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];
  return {
    shoulder: m(j.shoulder),
    elbow: m(j.elbow),
    hand: m(j.hand),
    hip: m(j.hip),
    knee: m(j.knee),
    ankle: m(j.ankle),
  };
};

const MALE_LEFT: LimbJoints = {
  shoulder: [-0.205, 0.73445, 0.2509],
  elbow: [-0.17116, 0.53927, 0.52106],
  hand: [-0.125, 0.34, 0.8],
  hip: [-0.092, 0.275, 0],
  knee: [-0.17992, 0.44413, 0.43507],
  ankle: [-0.105, 0.165, 0.78],
};

const FEMALE_LEFT: LimbJoints = {
  shoulder: [-0.188, 0.70355, 0.23447],
  elbow: [-0.16209, 0.53575, 0.49385],
  hand: [-0.12, 0.34, 0.8],
  hip: [-0.094, 0.275, 0],
  knee: [-0.15947, 0.38476, 0.42625],
  ankle: [-0.105, 0.165, 0.78],
};

/** Rest (catch) joints, from `skeleton(MALE)` / `skeleton(FEMALE)`. */
export const CREW_RIGS: Record<Crew, CrewRig> = {
  male: { pelvis: [0, 0.275, 0], leanDeg: 28, left: MALE_LEFT, right: mirror(MALE_LEFT) },
  female: { pelvis: [0, 0.275, 0], leanDeg: 28, left: FEMALE_LEFT, right: mirror(FEMALE_LEFT) },
};

/** The oar as `build_crew.py` rigs it: right gate at `gate`, left mirrored. */
export const OAR_RIG = {
  gate: [0.8, 0.34, 0.5] as Vec3,
  droopDeg: 10,
} as const;

/** How far the trunk leans back past vertical at the finish. */
const LEAN_FINISH_DEG = -12;
/** The hands come in to just below the ribs at the finish: grip z at the finish. */
const FINISH_GRIP_Z = 0.12;
/** Keep a little knee bend at full slide so the legs never lock straight. */
const LEG_EXTENSION = 0.97;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l < 1e-12 ? [0, 0, 0] : scale(a, 1 / l);
};
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const gateOf = (side: Side): Vec3 =>
  side === 'left' ? [-OAR_RIG.gate[0], OAR_RIG.gate[1], OAR_RIG.gate[2]] : OAR_RIG.gate;
/** The engine sweeps the left oar by +sweep about Y and the right by -sweep. */
const oarSign = (side: Side): number => (side === 'left' ? 1 : -1);

/** Horizontal distance from the gate to where the hand grips the shaft. */
const gripRadius = (crew: Crew): number => {
  const hand = CREW_RIGS[crew].left.hand;
  const gate = gateOf('left');
  return Math.hypot(hand[0] - gate[0], hand[2] - gate[2]);
};

/**
 * The point on the shaft the hand holds, in scull space, at an oar sweep
 * (radians, the angle the engine rotates the oar about +Y; `mat4FromRotationY`).
 */
export const gripPoint = (crew: Crew, side: Side, sweep: number): Vec3 => {
  const gate = gateOf(side);
  const h = gripRadius(crew);
  const droop = (OAR_RIG.droopDeg * Math.PI) / 180;
  // The inboard shaft at sweep 0 points across the boat (+X for the left oar)
  // and up by the droop.
  const gx = (side === 'left' ? 1 : -1) * h;
  const gy = h * Math.tan(droop);
  const a = sweep * oarSign(side);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [gate[0] + c * gx, gate[1] + gy, gate[2] - s * gx];
};

/** The sweep at which the grip is under the authored (catch) hand. */
export const catchSweep = (crew: Crew): number => {
  const hand = CREW_RIGS[crew].left.hand;
  const gate = gateOf('left');
  return Math.atan2(-(hand[2] - gate[2]), hand[0] - gate[0]);
};

/** The sweep at which the hands have come in to the body. */
export const finishSweep = (crew: Crew): number =>
  Math.asin((OAR_RIG.gate[2] - FINISH_GRIP_Z) / gripRadius(crew));

/**
 * The oar angle for a stroke phase (0 = catch, 0.5 = finish) and amplitude
 * (0 = idle, 1 = full stroke). An idle oar rests midway.
 */
export const oarSweep = (crew: Crew, phase: number, amplitude: number): number => {
  const c = catchSweep(crew);
  const f = finishSweep(crew);
  const mid = (c + f) / 2;
  const half = (c - f) / 2;
  return mid + half * Math.cos(2 * Math.PI * phase) * amplitude;
};

/** 1 at the catch, 0 at the finish. */
const strokeProgress = (crew: Crew, sweep: number): number => {
  const c = catchSweep(crew);
  const f = finishSweep(crew);
  return Math.min(1, Math.max(0, (sweep - f) / (c - f)));
};

/** Planar two-bone IK, as in `crew_body.two_bone`: the middle joint. */
const twoBone = (root: Vec3, end: Vec3, l1: number, l2: number, pole: Vec3): Vec3 => {
  const d = sub(end, root);
  const L = Math.min(len(d), l1 + l2 - 1e-6);
  const u = unit(d);
  const a = (l1 * l1 - l2 * l2 + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
  const perp = unit(sub(pole, scale(u, dot(pole, u))));
  return add(add(root, scale(u, a)), scale(perp, h));
};

/** Column-major mat4 helpers, local so the module stays self-contained. */
const identity = (): Float32Array => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

/** 3x3 rotation turning unit `a` onto unit `b` (Rodrigues), row-major. */
const rotationBetween = (a: Vec3, b: Vec3): number[] => {
  const ua = unit(a);
  const ub = unit(b);
  const k = cross(ua, ub);
  const s = len(k);
  const c = dot(ua, ub);
  if (s < 1e-9) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = scale(k, 1 / s);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
};

/** Rotation about +X by `rad` (y toward z), row-major. */
const rotationX = (rad: number): number[] => {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};

const mul3 = (r: number[], v: Vec3): Vec3 => [
  r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
  r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
  r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
];

/** The affine map p -> to + R (p - from), as a column-major mat4. */
const pivotMatrix = (r: number[], from: Vec3, to: Vec3): Float32Array => {
  const m = identity();
  m[0] = r[0]; m[4] = r[1]; m[8] = r[2];
  m[1] = r[3]; m[5] = r[4]; m[9] = r[5];
  m[2] = r[6]; m[6] = r[7]; m[10] = r[8];
  const t = sub(to, mul3(r, from));
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
};

interface PosedLimb {
  readonly shoulder: Vec3;
  readonly elbow: Vec3;
  /** Where the fist is, on the handle. */
  readonly grip: Vec3;
  readonly hip: Vec3;
  readonly knee: Vec3;
  readonly upper: Float32Array;
  readonly fore: Float32Array;
  readonly thigh: Float32Array;
  readonly kneeCap: Float32Array;
  readonly shin: Float32Array;
}

export interface CrewStrokePose {
  /** How far the seat has rolled back from the catch, metres. */
  readonly slide: number;
  /** Trunk lean from vertical, degrees; negative leans back. */
  readonly leanDeg: number;
  readonly torso: Float32Array;
  readonly seat: Float32Array;
  readonly left: PosedLimb;
  readonly right: PosedLimb;
}

/** Seat travel that leaves the knees `LEG_EXTENSION` short of straight. */
const maxSlide = (rig: CrewRig): number => {
  const { hip, ankle, knee } = rig.left;
  const reach = LEG_EXTENSION * (len(sub(knee, hip)) + len(sub(ankle, knee)));
  const dx = ankle[0] - hip[0];
  const dy = ankle[1] - hip[1];
  return Math.sqrt(Math.max(reach * reach - dx * dx - dy * dy, 0)) - (ankle[2] - hip[2]);
};

/** Pose every moving part of the rower for one oar sweep. */
export const crewStrokePose = (crew: Crew, sweep: number): CrewStrokePose => {
  const rig = CREW_RIGS[crew];
  const u = strokeProgress(crew, sweep);
  // The drive is legs, then body, then arms: the legs are done by u = 0.3 and
  // the body swing starts at u = 0.7. The arms are whatever reaches the handle.
  const legs = smoothstep(0.3, 1, u);
  const body = smoothstep(0, 0.6, u);
  const slide = maxSlide(rig) * (1 - legs);
  const leanDeg = LEAN_FINISH_DEG + (rig.leanDeg - LEAN_FINISH_DEG) * body;

  const pelvisNow: Vec3 = [rig.pelvis[0], rig.pelvis[1], rig.pelvis[2] - slide];
  const torsoR = rotationX(((leanDeg - rig.leanDeg) * Math.PI) / 180);
  const torso = pivotMatrix(torsoR, rig.pelvis, pelvisNow);
  const seat = pivotMatrix([1, 0, 0, 0, 1, 0, 0, 0, 1], rig.pelvis, pelvisNow);

  const limb = (side: Side): PosedLimb => {
    const r = rig[side];
    const s = side === 'left' ? -1 : 1;
    const shoulder = add(pelvisNow, mul3(torsoR, sub(r.shoulder, rig.pelvis)));
    const l1 = len(sub(r.elbow, r.shoulder));
    const l2 = len(sub(r.hand, r.elbow));
    // The fist holds the shaft. The authored catch has it lower than the
    // raised oarlock puts the handle, so the arms lift to it from the start.
    const target = gripPoint(crew, side, sweep);
    const elbow = twoBone(shoulder, target, l1, l2, [s, -0.2, 0]);
    const grip = add(elbow, scale(unit(sub(target, elbow)), l2));
    const upper = pivotMatrix(rotationBetween(sub(r.elbow, r.shoulder), sub(elbow, shoulder)), r.shoulder, shoulder);
    const foreR = rotationBetween(sub(r.hand, r.elbow), sub(grip, elbow));
    const fore = pivotMatrix(foreR, r.elbow, elbow);

    const hip: Vec3 = [r.hip[0], r.hip[1], r.hip[2] - slide];
    const t1 = len(sub(r.knee, r.hip));
    const t2 = len(sub(r.ankle, r.knee));
    const knee = twoBone(hip, r.ankle, t1, t2, [s * 0.35, 1, 0]);
    const thighR = rotationBetween(sub(r.knee, r.hip), sub(knee, hip));
    const thigh = pivotMatrix(thighR, r.hip, hip);
    const kneeCap = pivotMatrix(thighR, r.knee, knee);
    const shin = pivotMatrix(rotationBetween(sub(r.ankle, r.knee), sub(r.ankle, knee)), r.knee, knee);
    return { shoulder, elbow, grip, hip, knee, upper, fore, thigh, kneeCap, shin };
  };

  return { slide, leanDeg, torso, seat, left: limb('left'), right: limb('right') };
};

const LIMB_PART = /^(Left|Right)(Arm_Upper|Arm_Fore|Hand|Thigh|Knee|Shin)$/;
const TORSO_PART = /^(Torso_|Neck$|Head|Hair_|Hat_)/;

/**
 * The scull-space matrix that moves a GLB node for this pose, or `undefined`
 * for nodes that stay where the GLB put them (hull, oars, feet, rails).
 */
export const crewPartTransform = (
  nodeName: string | undefined,
  pose: CrewStrokePose,
): Float32Array | undefined => {
  if (!nodeName) return undefined;
  if (nodeName === 'Seat_Pan') return pose.seat;
  if (TORSO_PART.test(nodeName)) return pose.torso;
  const m = LIMB_PART.exec(nodeName);
  if (!m) return undefined;
  const limb = m[1] === 'Left' ? pose.left : pose.right;
  switch (m[2]) {
    case 'Arm_Upper': return limb.upper;
    case 'Arm_Fore':
    case 'Hand': return limb.fore;
    case 'Thigh': return limb.thigh;
    case 'Knee': return limb.kneeCap;
    default: return limb.shin;
  }
};
