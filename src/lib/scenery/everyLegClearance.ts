/**
 * #760 — keep scenery clear of the racing corridor of *every* part of the
 * route, not only the station it was placed from. On a lake lap or stake
 * race the return leg runs 30–60 m from the outbound leg, so a tree placed
 * on the outbound leg's bank can stand in the return leg's lane.
 *
 * `centrelineIndex` buckets the route's centreline segments in a grid so
 * the nearest-centreline distance near a point is a handful of segment
 * tests, and `clearOfEveryLeg` drops placements whose footprint edge comes
 * inside the corridor (less the bend allowance the property test uses).
 */

import { keepClearHalfWidth } from './laneClearance';
import { BUILT_IN_FOOTPRINT_LOOKUP, footprintRadiusFor } from './sceneryFootprints';

/** Nearest-centreline distance on a bend runs a little short of the placement's perpendicular. */
export const EVERY_LEG_BEND_TOLERANCE_METRES = 1;

const CELL_METRES = 25;

export interface CentrelineIndex {
  /** Distance from (x, z) to the nearest centreline segment, or `Infinity` beyond `within`. */
  distance(x: number, z: number, within: number): number;
}

const segmentDistance = (x: number, z: number, ax: number, az: number, bx: number, bz: number): number => {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
};

export const centrelineIndex = (points: readonly (readonly [number, number, number])[]): CentrelineIndex => {
  const grid = new Map<string, number[]>();
  const key = (ix: number, iz: number) => `${ix},${iz}`;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [ax, , az] = points[i];
    const [bx, , bz] = points[i + 1];
    for (let ix = Math.floor(Math.min(ax, bx) / CELL_METRES); ix <= Math.floor(Math.max(ax, bx) / CELL_METRES); ix += 1) {
      for (let iz = Math.floor(Math.min(az, bz) / CELL_METRES); iz <= Math.floor(Math.max(az, bz) / CELL_METRES); iz += 1) {
        const k = key(ix, iz);
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  }
  return {
    distance(x, z, within) {
      let best = Infinity;
      const r = Math.ceil(within / CELL_METRES);
      const cx = Math.floor(x / CELL_METRES);
      const cz = Math.floor(z / CELL_METRES);
      for (let ix = cx - r; ix <= cx + r; ix += 1) {
        for (let iz = cz - r; iz <= cz + r; iz += 1) {
          const list = grid.get(key(ix, iz));
          if (!list) continue;
          for (const i of list) {
            const d = segmentDistance(x, z, points[i][0], points[i][2], points[i + 1][0], points[i + 1][2]);
            if (d < best) best = d;
          }
        }
      }
      return best <= within ? best : Infinity;
    },
  };
};

/** Lane and turn buoys and bridge spans belong on the water. */
const onWaterByDesign = (id: string): boolean => /buoy/.test(id) || /bridge/.test(id);

/**
 * The placements whose footprint edge stays outside every leg's corridor.
 * Buoys and bridges are kept as they are.
 */
export const clearOfEveryLeg = <P extends { id: string; position: readonly [number, number, number] }>(
  placements: readonly P[],
  centreline: CentrelineIndex,
  corridor = keepClearHalfWidth() - EVERY_LEG_BEND_TOLERANCE_METRES,
): P[] =>
  placements.filter((p) => {
    if (onWaterByDesign(p.id)) return true;
    const reach = corridor + footprintRadiusFor(p.id, BUILT_IN_FOOTPRINT_LOOKUP);
    return centreline.distance(p.position[0], p.position[2], reach) >= reach;
  });
