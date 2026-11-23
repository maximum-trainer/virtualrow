/**
 * #742 VP-22 FR1 — the route's water footprint: the union of the water
 * ribbon's quads along the whole route, so a bank built for one leg can
 * tell when it lies on another leg's water (an out-and-back, a stake race,
 * a lake lap whose legs run side by side).
 *
 * The ribbon comes from `buildWaterStrip`: per station a left and a right
 * edge vertex. Quad i spans stations i and i+1. Quads are bucketed in a
 * uniform XZ grid, so a lookup only tests the few quads near the point.
 */

import type { WaterStripGeometry } from './waterStrip';

export interface WaterFootprint {
  /**
   * Whether (x, z) lies inside the water by at least `margin` metres from a
   * shoreline. A point on the shore (the bank's own inner edge) is not inside.
   */
  contains(x: number, z: number, margin?: number): boolean;
  /** Number of quads in the footprint. */
  readonly quads: number;
}

const DEFAULT_CELL_METRES = 25;
export const FOOTPRINT_EDGE_MARGIN_METRES = 0.5;

const distanceToSegment = (
  px: number, pz: number, ax: number, az: number, bx: number, bz: number,
): number => {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
};

/** Even-odd test against a closed ring given as flat [x0, z0, x1, z1, …]. */
const insideRing = (px: number, pz: number, ring: readonly number[]): boolean => {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const zi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const zj = ring[j * 2 + 1];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

export const routeWaterFootprint = (
  water: Pick<WaterStripGeometry, 'positions'>,
  cellMetres = DEFAULT_CELL_METRES,
): WaterFootprint => {
  const p = water.positions;
  const stations = Math.floor(p.length / 6);
  const rings: number[][] = [];
  const grid = new Map<string, number[]>();
  const key = (ix: number, iz: number) => `${ix},${iz}`;
  for (let i = 0; i + 1 < stations; i += 1) {
    const a = i * 6;
    const b = (i + 1) * 6;
    // L_i, R_i, R_{i+1}, L_{i+1}
    const ring = [p[a], p[a + 2], p[a + 3], p[a + 5], p[b + 3], p[b + 5], p[b], p[b + 2]];
    const q = rings.push(ring) - 1;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < 8; k += 2) {
      minX = Math.min(minX, ring[k]);
      maxX = Math.max(maxX, ring[k]);
      minZ = Math.min(minZ, ring[k + 1]);
      maxZ = Math.max(maxZ, ring[k + 1]);
    }
    for (let ix = Math.floor(minX / cellMetres); ix <= Math.floor(maxX / cellMetres); ix += 1) {
      for (let iz = Math.floor(minZ / cellMetres); iz <= Math.floor(maxZ / cellMetres); iz += 1) {
        const k = key(ix, iz);
        const list = grid.get(k);
        if (list) list.push(q);
        else grid.set(k, [q]);
      }
    }
  }
  return {
    quads: rings.length,
    contains(x, z, margin = FOOTPRINT_EDGE_MARGIN_METRES) {
      const list = grid.get(key(Math.floor(x / cellMetres), Math.floor(z / cellMetres)));
      if (!list) return false;
      for (const q of list) {
        const ring = rings[q];
        if (!insideRing(x, z, ring)) continue;
        // Only the shorelines count for the margin (R_i→R_{i+1}, L_{i+1}→L_i):
        // the cross edges are seams inside the ribbon, not its edge.
        const near = Math.min(
          distanceToSegment(x, z, ring[2], ring[3], ring[4], ring[5]),
          distanceToSegment(x, z, ring[6], ring[7], ring[0], ring[1]),
        );
        if (near >= margin) return true;
      }
      return false;
    },
  };
};

/**
 * #742 FR3 — scenery pools with every instance lying on the route's water
 * taken out: a tree placed for one leg can stand in another leg's water,
 * or in the water joining two legs. Pools that lose nothing are returned
 * as they were; a pool that loses everything is dropped.
 */
export const poolsOffWater = <P extends { positions: Float32Array; metadata?: Uint32Array }>(
  pools: readonly P[],
  footprint: Pick<WaterFootprint, 'contains'>,
  margin = FOOTPRINT_EDGE_MARGIN_METRES,
): { pools: P[]; rejected: number } => {
  let rejected = 0;
  const out: P[] = [];
  for (const pool of pools) {
    const count = Math.floor(pool.positions.length / 3);
    const keep: number[] = [];
    for (let i = 0; i < count; i += 1) {
      if (!footprint.contains(pool.positions[i * 3], pool.positions[i * 3 + 2], margin)) keep.push(i);
    }
    rejected += count - keep.length;
    if (keep.length === count) {
      out.push(pool);
      continue;
    }
    if (keep.length === 0) continue;
    const positions = new Float32Array(keep.length * 3);
    keep.forEach((i, k) => positions.set(pool.positions.subarray(i * 3, i * 3 + 3), k * 3));
    const metadata = pool.metadata ? Uint32Array.from(keep, (i) => pool.metadata![i]) : undefined;
    out.push({ ...pool, positions, ...(metadata ? { metadata } : {}) });
  }
  return { pools: out, rejected };
};
