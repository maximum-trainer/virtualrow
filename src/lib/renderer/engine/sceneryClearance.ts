/**
 * #761 — how close any drawn scenery model comes to the racing line,
 * published as `__ROWER3D_SCENERY_CLEARANCE`. For each drawn instance the
 * distance is from the route centreline to the nearest edge of the model's
 * footprint (centre distance less footprint radius). The scenery-clearance
 * spec asserts `min` stays at or above `thresholdM` over the whole route.
 *
 * Not `__ROWER3D_CLEARANCE`: that one is the oar blades' clearance (#737).
 */

import { keepClearHalfWidth } from '../../scenery/laneClearance';
import { BUILT_IN_FOOTPRINT_LOOKUP, footprintRadiusFor } from '../../scenery/sceneryFootprints';
import { BRIDGE_SPANS } from '../../scenery/bridgeSpans.generated';

/**
 * Same allowance as the placement property test (`clearanceProperty.test.ts`):
 * the nearest-centreline distance on a bend is a little shorter than the
 * perpendicular the placement used.
 */
export const BEND_TOLERANCE_METRES = 1;

/** The corridor every drawn model's footprint edge stays outside (D, Dan 2026-11-23). */
export const sceneryClearanceThreshold = (): number => keepClearHalfWidth() - BEND_TOLERANCE_METRES;

/**
 * Models that belong on or at the water's edge by design: lane and turn
 * buoys, bridge spans, the start pontoon, the finish-line flagpoles and
 * the distance posts that line the course.
 */
export const onWaterByDesign = (id: string): boolean =>
  id in BRIDGE_SPANS ||
  /bridge/.test(id) ||
  /buoy/.test(id) ||
  id.startsWith('a03-pontoon') ||
  id.startsWith('a07-distance-marker') ||
  id.startsWith('a12-regatta-flagpole');

export interface SceneryClearance {
  /** Drawn instances measured (on-water-by-design models excluded). */
  samples: number;
  /** Smallest footprint-edge distance to the centreline, metres; null before any sample. */
  min: number | null;
  /** The model id that set `min`. */
  minId: string | null;
  /** Distance along the route (metres) of the centreline point nearest that instance. */
  minProgress: number | null;
  thresholdM: number;
}

export const emptySceneryClearance = (): SceneryClearance => ({
  samples: 0,
  min: null,
  minId: null,
  minProgress: null,
  thresholdM: sceneryClearanceThreshold(),
});

/** Nearest point on the XZ polyline: distance to it and arc length to it. */
export const nearestOnPolyline = (
  points: readonly (readonly [number, number, number])[],
  x: number,
  z: number,
): { distance: number; progress: number } => {
  let best = Infinity;
  let bestProgress = 0;
  let walked = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const ax = points[i][0];
    const az = points[i][2];
    const dx = points[i + 1][0] - ax;
    const dz = points[i + 1][2] - az;
    const len2 = dx * dx + dz * dz;
    const len = Math.sqrt(len2);
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d < best) {
      best = d;
      bestProgress = walked + t * len;
    }
    walked += len;
  }
  if (points.length === 1) return { distance: Math.hypot(x - points[0][0], z - points[0][2]), progress: 0 };
  return { distance: best, progress: bestProgress };
};

/**
 * Measure every drawn instance. `instances` maps model id to its instance
 * matrices (column-major, translation in 12/14).
 */
export const measureSceneryClearance = (
  out: SceneryClearance,
  centreline: readonly (readonly [number, number, number])[],
  drawn: Iterable<string>,
  instances: ReadonlyMap<string, readonly Float32Array[]>,
  skip: (id: string) => boolean = () => false,
): SceneryClearance => {
  out.samples = 0;
  out.min = null;
  out.minId = null;
  out.minProgress = null;
  if (centreline.length === 0) return out;
  for (const id of drawn) {
    if (onWaterByDesign(id) || skip(id)) continue;
    const mats = instances.get(id);
    if (!mats || mats.length === 0) continue;
    const radius = footprintRadiusFor(id, BUILT_IN_FOOTPRINT_LOOKUP);
    for (const m of mats) {
      const near = nearestOnPolyline(centreline, m[12], m[14]);
      const edge = near.distance - radius;
      out.samples += 1;
      if (out.min === null || edge < out.min) {
        out.min = edge;
        out.minId = id;
        out.minProgress = near.progress;
      }
    }
  }
  return out;
};
