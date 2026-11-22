/**
 * Turn a chain of gate centres into a line a boat can row (#743).
 *
 * A gates-only rownative course arrives as straight legs from gate centre to
 * gate centre. Rowed as-is, the heading changes instantly at every gate: the
 * hull, the chase camera and the water and bank ribbons all pivot on the spot.
 *
 * Two shapes cover it:
 *
 *  - an ordinary turn becomes a FILLET, a circular arc tangent to both legs,
 *    which cuts a little inside the gate centre as a crew would. The engine's
 *    own spline already softens a corner to a radius of 40 m or so, so the
 *    fillet is sized to be gentler than that, limited by how far it may cut
 *    inside the gate ({@link FILLET_MAX_CUT_M});
 *  - a turn sharper than {@link STAKE_TURN_THRESHOLD_DEG} is a stake or buoy
 *    turn. A fillet there would cut hundreds of metres short of the stake, so
 *    the line goes ROUND the gate centre on an arc instead.
 *
 * Dense lines (a traced path, an OSM centreline) are left alone: their legs
 * are shorter than {@link MIN_LEG_FOR_ROUNDING_M}, and they already carry the
 * curvature of the water.
 */

import type { Coordinate } from '../types/index';

/** Turns smaller than this are a straight course with a wobble. */
export const MIN_TURN_DEG = 5;
/** Sharper than this and the crew is rounding a stake, not taking a bend. */
export const STAKE_TURN_THRESHOLD_DEG = 100;
/** Largest fillet radius: a gentle bend at racing speed. */
export const FILLET_MAX_RADIUS_M = 60;
/**
 * How far inside a gate centre a fillet may pass when the caller does not say
 * how wide that gate is. See {@link RoundCourseCornersOptions.maxCutMeters}.
 */
export const FILLET_MAX_CUT_M = 15;
/** A fillet takes at most this share of the shorter leg either side. */
export const FILLET_MAX_LEG_SHARE = 0.33;
/** Stake turns are rowed between these radii about the gate centre. */
export const STAKE_TURN_MIN_RADIUS_M = 12;
export const STAKE_TURN_MAX_RADIUS_M = 20;
/**
 * A gentle turn between legs shorter than this is a vertex of a traced line
 * (an OSM centreline, an uploaded track), which already carries the water's
 * curvature. Sharp turns are rounded whatever the leg length.
 */
export const MIN_LEG_FOR_ROUNDING_M = 24;
export const TRACED_LINE_MAX_TURN_DEG = 45;
/** A stake arc takes at most this share of the shorter leg as its radius. */
const STAKE_MAX_LEG_SHARE = 0.45;
/** Arc points are emitted at most this many degrees of turn apart. */
export const ARC_STEP_DEG = 5;

const METERS_PER_DEGREE_LAT = 111_320;
const RAD = Math.PI / 180;

interface Vec {
  x: number;
  y: number;
}

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
const len = (a: Vec): number => Math.hypot(a.x, a.y);
const unit = (a: Vec): Vec => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
/** Rotate by `angle` radians, counter-clockwise positive (x east, y north). */
const rotate = (a: Vec, angle: number): Vec => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
};

/** Points on a circle about `centre` from `from`, sweeping `sweep` radians. */
const arc = (centre: Vec, from: Vec, sweep: number): Vec[] => {
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (ARC_STEP_DEG * RAD)));
  const out: Vec[] = [];
  for (let i = 0; i <= steps; i += 1) {
    out.push(add(centre, rotate(from, (sweep * i) / steps)));
  }
  return out;
};

export interface RoundCourseCornersOptions {
  /**
   * Per vertex of `chain`: how far inside that corner the fillet may pass.
   * A wide gate lets the line cut further in and so turn on a larger radius;
   * a narrow one keeps it close to the centre. Missing entries use
   * {@link FILLET_MAX_CUT_M}.
   */
  maxCutMeters?: readonly (number | undefined)[];
}

/**
 * Round the corners of a gate chain. Returns the input array itself when
 * there is nothing to round, so callers can tell cheaply.
 */
export function roundCourseCorners(
  chain: Coordinate[],
  options: RoundCourseCornersOptions = {},
): Coordinate[] {
  if (chain.length < 3) return chain;

  // A local tangent plane about the chain's first point: at course scale
  // (tens of kilometres at most) the error is far below a boat length.
  const origin = chain[0];
  const lngScale = METERS_PER_DEGREE_LAT * Math.max(0.01, Math.cos(origin.lat * RAD));
  const toLocal = (c: Coordinate): Vec => ({
    x: (c.lng - origin.lng) * lngScale,
    y: (c.lat - origin.lat) * METERS_PER_DEGREE_LAT,
  });
  const toCoordinate = (v: Vec): Coordinate => ({
    lat: origin.lat + v.y / METERS_PER_DEGREE_LAT,
    lng: origin.lng + v.x / lngScale,
  });

  const pts = chain.map(toLocal);
  const out: Coordinate[] = [chain[0]];
  let changed = false;

  for (let i = 1; i < pts.length - 1; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const legIn = len(sub(b, a));
    const legOut = len(sub(c, b));
    const shorter = Math.min(legIn, legOut);
    const dIn = unit(sub(b, a));
    const dOut = unit(sub(c, b));
    const turn = Math.acos(Math.max(-1, Math.min(1, dot(dIn, dOut))));

    const tracedVertex = shorter < MIN_LEG_FOR_ROUNDING_M && turn < TRACED_LINE_MAX_TURN_DEG * RAD;
    if (shorter <= 0 || tracedVertex || turn < MIN_TURN_DEG * RAD) {
      out.push(chain[i]);
      continue;
    }
    changed = true;
    // +1 for a left (counter-clockwise) turn, -1 for a right turn.
    const side = cross(dIn, dOut) >= 0 ? 1 : -1;

    if (turn > STAKE_TURN_THRESHOLD_DEG * RAD) {
      // Round the stake: an arc about the gate centre, entered travelling
      // along the incoming leg and left travelling along the outgoing one.
      const radius = Math.min(
        STAKE_TURN_MAX_RADIUS_M,
        Math.max(STAKE_TURN_MIN_RADIUS_M, shorter * 0.25),
        shorter * STAKE_MAX_LEG_SHARE,
      );
      const entry = scale(rotate(dIn, (-side * Math.PI) / 2), radius);
      for (const p of arc(b, entry, side * turn)) out.push(toCoordinate(p));
      continue;
    }

    // Fillet: tangent to both legs, `tangent` metres back from the corner.
    const half = turn / 2;
    const maxTangent = shorter * FILLET_MAX_LEG_SHARE;
    // Distance from the corner to the arc is r * (sec(half) - 1); keep it small
    // enough that the line still plainly goes through the gate.
    const allowedCut = options.maxCutMeters?.[i];
    const maxCut = Number.isFinite(allowedCut) && (allowedCut as number) > 0 ? (allowedCut as number) : FILLET_MAX_CUT_M;
    const cutLimitedRadius = maxCut / (1 / Math.cos(half) - 1);
    const wanted = Math.min(FILLET_MAX_RADIUS_M, cutLimitedRadius);
    const tangent = Math.min(wanted * Math.tan(half), maxTangent);
    const radius = tangent / Math.tan(half);
    const start = sub(b, scale(dIn, tangent));
    const centre = add(start, scale(rotate(dIn, (side * Math.PI) / 2), radius));
    for (const p of arc(centre, sub(start, centre), side * turn)) out.push(toCoordinate(p));
  }

  if (!changed) return chain;
  out.push(chain[chain.length - 1]);
  return out;
}
