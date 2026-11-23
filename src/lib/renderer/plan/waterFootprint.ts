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
  /**
   * #737 VP-19 FR4 — metres from (x, z) to the nearer shoreline of the
   * ribbon quad it lies in (the larger, where two quads overlap at a seam
   * or where legs meet), or null when the point is not on the ribbon.
   */
  shoreDistance(x: number, z: number): number | null;
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
  // Only the shorelines count (R_i→R_{i+1}, L_{i+1}→L_i): the cross
  // edges are seams inside the ribbon, not its edge.
  const shoreOf = (x: number, z: number, ring: readonly number[]): number => Math.min(
    distanceToSegment(x, z, ring[2], ring[3], ring[4], ring[5]),
    distanceToSegment(x, z, ring[6], ring[7], ring[0], ring[1]),
  );
  const shoreDistance = (x: number, z: number): number | null => {
    const list = grid.get(key(Math.floor(x / cellMetres), Math.floor(z / cellMetres)));
    if (!list) return null;
    let best: number | null = null;
    for (const q of list) {
      const ring = rings[q];
      if (!insideRing(x, z, ring)) continue;
      const near = shoreOf(x, z, ring);
      if (best === null || near > best) best = near;
    }
    return best;
  };
  return {
    quads: rings.length,
    contains(x, z, margin = FOOTPRINT_EDGE_MARGIN_METRES) {
      const near = shoreDistance(x, z);
      return near !== null && near >= margin;
    },
    shoreDistance,
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

type LakeRing = ReadonlyArray<{ x: number; z: number }>;
export interface LakeOutline {
  outer: LakeRing;
  holes: ReadonlyArray<LakeRing>;
}

const LAKE_BAND_METRES = 10;

/**
 * Even-odd point-in-polygon over many rings at once, with each ring edge
 * bucketed in the z-bands it spans, so a test reads only the few edges in
 * its band (a simplified lake can still carry thousands of vertices, and
 * the bank asks once per vertex and triangle).
 */
const ringTest = (rings: ReadonlyArray<LakeRing>): ((x: number, z: number) => boolean) => {
  const bands = new Map<number, number[]>(); // flat [ax, az, bx, bz, ring] per edge
  rings.forEach((ring, r) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.z === b.z) continue;
      const lo = Math.floor(Math.min(a.z, b.z) / LAKE_BAND_METRES);
      const hi = Math.floor(Math.max(a.z, b.z) / LAKE_BAND_METRES);
      for (let k = lo; k <= hi; k += 1) {
        const list = bands.get(k);
        if (list) list.push(a.x, a.z, b.x, b.z, r);
        else bands.set(k, [a.x, a.z, b.x, b.z, r]);
      }
    }
  });
  const parity = new Uint8Array(rings.length);
  return (x, z) => {
    const list = bands.get(Math.floor(z / LAKE_BAND_METRES));
    if (!list) return false;
    parity.fill(0);
    for (let e = 0; e < list.length; e += 5) {
      const ax = list[e];
      const az = list[e + 1];
      const bx = list[e + 2];
      const bz = list[e + 3];
      if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) parity[list[e + 4]] ^= 1;
    }
    return parity.some((p) => p === 1);
  };
};

/**
 * Whether scene (x, z) is on a lake: inside some lake's outer ring and
 * none of its islands. Undefined when there are no lakes.
 */
export const lakeWater = (
  lakes: ReadonlyArray<LakeOutline>,
): ((x: number, z: number) => boolean) | undefined => {
  if (lakes.length === 0) return undefined;
  const tests = lakes.map((l) => ({ outer: ringTest([l.outer]), holes: l.holes.length ? ringTest(l.holes) : null }));
  return (x, z) => tests.some((t) => t.outer(x, z) && !(t.holes?.(x, z) ?? false));
};

export type SurfaceKind = 'water' | 'land';

const HULL_PROBE: ReadonlyArray<readonly [number, number]> = [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]];

/**
 * #742 FR6 — what lies under the boat at (x, z): water when the route's
 * ribbon is within half a metre of it, or it is on a lake (`inLake`, from
 * `lakeWater`); land otherwise.
 */
export const surfaceAt = (
  footprint: Pick<WaterFootprint, 'contains'>,
  inLake: ((x: number, z: number) => boolean) | undefined,
  x: number,
  z: number,
): SurfaceKind => {
  // The hull is metres long: a point on the ribbon's own end (the start
  // line, where the boat waits) counts when water is within half a metre.
  for (const [dx, dz] of HULL_PROBE) if (footprint.contains(x + dx, z + dz, 0)) return 'water';
  return inLake?.(x, z) ? 'water' : 'land';
};

/**
 * #742 FR5 — the route's water with its lake polygons added, for the bank
 * strips to give way to: where a lake is drawn, the lake's own shore is the
 * bank, not a strip laid along the racing line. A point on an island is
 * not water.
 */
export const withLakes = (footprint: WaterFootprint, lakes: ReadonlyArray<LakeOutline>): WaterFootprint => {
  const inLake = lakeWater(lakes);
  if (!inLake) return footprint;
  return {
    quads: footprint.quads,
    contains: (x, z, margin) => footprint.contains(x, z, margin) || inLake(x, z),
    // A lake's own shore is not measured: open lake water has no ribbon edge.
    shoreDistance: (x, z) => footprint.shoreDistance(x, z),
  };
};
