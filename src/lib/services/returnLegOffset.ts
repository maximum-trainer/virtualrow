/**
 * #751 FR3 — out-and-back legs on one centreline.
 *
 * When a course turns at a stake and comes back the way it went, the waterway
 * walk gives the return leg the same edges as the outbound one, and the two
 * lines coincide (#742's overlap). Here the return leg is shifted sideways by
 * {@link returnLegOffsetMeters} to the side the course's gates sit on, easing
 * in and out over {@link OFFSET_TAPER_M} so it still starts and ends on the
 * line it joins.
 */
import type { Coordinate } from '../types/index';
import { cumulativeLengths, projectPointOntoPolyline } from '../utils/polylineGeometry';
import { localFrame } from './waterAreaCentreline';

/** The return leg moves at most this far off the centreline. */
export const MAX_RETURN_OFFSET_M = 15;
/** ...and at most this share of the water's width. */
export const RETURN_OFFSET_WIDTH_SHARE = 0.3;
/** The shift eases in and out over this distance at each end of the leg. */
export const OFFSET_TAPER_M = 60;
/** A return leg retraces the outbound one when this share of it lies within {@link RETRACE_TOLERANCE_M}. */
export const RETRACE_SHARE = 0.8;
export const RETRACE_TOLERANCE_M = 10;
const RETRACE_SAMPLE_M = 10;

export const returnLegOffsetMeters = (widthMeters: number): number =>
  Math.max(0, Math.min(MAX_RETURN_OFFSET_M, RETURN_OFFSET_WIDTH_SHARE * widthMeters));

/** Points every {@link RETRACE_SAMPLE_M} along a line (its vertices included). */
const samples = (line: Coordinate[]): Coordinate[] => {
  const out: Coordinate[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const { toLocal } = localFrame(a);
    const v = toLocal(b);
    const steps = Math.max(1, Math.ceil(Math.hypot(v.x, v.y) / RETRACE_SAMPLE_M));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
    }
  }
  if (line.length > 0) out.push(line[line.length - 1]);
  return out;
};

/** Does `back` mostly run along `outbound` (either direction)? */
export const retracesLeg = (outbound: Coordinate[], back: Coordinate[]): boolean => {
  if (outbound.length < 2 || back.length < 2) return false;
  const points = samples(back);
  const near = points.filter((p) => projectPointOntoPolyline(p, outbound).offsetMeters <= RETRACE_TOLERANCE_M);
  return near.length >= points.length * RETRACE_SHARE;
};

/** Unit right-hand normal of a line at vertex i, in the frame of `toLocal`. */
const rightNormal = (pts: { x: number; y: number }[], i: number) => {
  const a = pts[Math.max(0, i - 1)];
  const b = pts[Math.min(pts.length - 1, i + 1)];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dy / len, y: -dx / len };
};

/**
 * Which side of `leg` (travelling along it) the gates sit on: +1 right, -1
 * left. Gates within a metre of the line say nothing; when none say anything
 * the leg keeps to the right, the usual rule of the river.
 */
export const gateSide = (leg: Coordinate[], gates: readonly Coordinate[]): 1 | -1 => {
  if (leg.length < 2) return 1;
  const { toLocal } = localFrame(leg[0]);
  const pts = leg.map(toLocal);
  let sum = 0;
  for (const gate of gates) {
    const projection = projectPointOntoPolyline(gate, leg);
    if (projection.offsetMeters < 1) continue;
    const i = Math.min(pts.length - 1, projection.segmentIndex);
    const n = rightNormal(pts, i);
    const g = toLocal(gate);
    const p = toLocal(projection.point);
    sum += Math.sign((g.x - p.x) * n.x + (g.y - p.y) * n.y);
  }
  return sum < 0 ? -1 : 1;
};

/**
 * `leg` shifted `distanceMeters` to `side`, easing in from 0 at the first
 * vertex and back to 0 at the last over {@link OFFSET_TAPER_M} (or a third of
 * the leg, if shorter).
 */
export const offsetLeg = (leg: Coordinate[], distanceMeters: number, side: 1 | -1): Coordinate[] => {
  if (leg.length < 2 || distanceMeters <= 0) return leg;
  const along = cumulativeLengths(leg);
  const total = along[along.length - 1];
  const taper = Math.min(OFFSET_TAPER_M, total / 3);
  if (taper <= 0) return leg;

  // Put a vertex where each taper ends, so a long straight segment still
  // carries the full offset through its middle.
  const knots = [...new Set([taper, total - taper])].filter((d) => d > 0 && d < total);
  const dense: Coordinate[] = [];
  const denseAlong: number[] = [];
  for (let i = 0; i < leg.length; i++) {
    if (i > 0) {
      for (const d of knots) {
        if (d > along[i - 1] && d < along[i]) {
          const t = (d - along[i - 1]) / (along[i] - along[i - 1]);
          dense.push({
            lat: leg[i - 1].lat + (leg[i].lat - leg[i - 1].lat) * t,
            lng: leg[i - 1].lng + (leg[i].lng - leg[i - 1].lng) * t,
          });
          denseAlong.push(d);
        }
      }
    }
    dense.push(leg[i]);
    denseAlong.push(along[i]);
  }

  const { toLocal, toCoordinate } = localFrame(dense[0]);
  const pts = dense.map(toLocal);
  return pts.map((p, i) => {
    const s = denseAlong[i];
    const ease = Math.min(1, s / taper, (total - s) / taper);
    const n = rightNormal(pts, i);
    const shift = side * distanceMeters * ease;
    return toCoordinate({ x: p.x + n.x * shift, y: p.y + n.y * shift });
  });
};
