/**
 * #742 VP-22 FR2/FR3 — a course that runs back beside itself (an
 * out-and-back, a stake race, a lake lap).
 *
 * Where two legs' shores are closer than a bank is wide, the land drawn
 * between them is a spit of grass a few metres across that is not there:
 * on the real course it is the same sheet of water. So each station's
 * shore on the side facing another leg is pushed out until it meets that
 * leg's water (FR2), unless OSM maps land in the gap (`isLand`, an island).
 *
 * The same search flags the stretches of the route that lie alongside
 * another part of it (`selfParallel`, FR3), whether their waters already
 * touched or had to be joined.
 *
 * Method: the water ribbon from `buildWaterStrip` at the strip's own
 * stations. From each station a ray goes out along the perpendicular on
 * each side, and is tested against the shorelines of every quad more than
 * `window` metres of route away (so a leg never meets itself on a bend).
 * The shorelines are bucketed in a uniform grid.
 */

import type { RouteCurve } from '../math/curve';
import {
  DEFAULT_WATER_HALF_WIDTH_M,
  buildWaterStrip,
  defaultStripDivisions,
  type WaterEdges,
} from './waterStrip';

/** How far the widened shore reaches into the other leg's water, so the two overlap. */
export const PARALLEL_LEG_OVERLAP_METRES = 1;
/** The bank strip's width: a gap narrower than this is joined. */
export const PARALLEL_LEG_GAP_METRES = 60;
/** Step of the land check along a gap. */
const LAND_STEP_METRES = 5;
const CELL_METRES = 25;

export interface BridgeParallelLegsOptions {
  /** Gap between shores below which two legs are joined. */
  gap?: number;
  /** Half-width used when the route has no measured edges. */
  halfWidth?: number;
  /** Stations: defaults to the water strip's own. */
  divisions?: number;
  /** Whether OSM maps land at scene (x, z): a gap over land is kept. */
  isLand?: (x: number, z: number) => boolean;
}

export interface ParallelLegs {
  /** The route's edges with each gap to a parallel leg closed. */
  edgesForProgress: (progress: number) => WaterEdges;
  /** Station sides widened. */
  bridged: number;
  /** Progress ranges [from, to] lying alongside another part of the route. */
  selfParallel: Array<[number, number]>;
}

/** Ray (o + t·d) against segment a→b; the ray's t, or Infinity. */
const raySegment = (
  ox: number, oz: number, dx: number, dz: number,
  ax: number, az: number, bx: number, bz: number,
): number => {
  const ex = bx - ax;
  const ez = bz - az;
  const denom = dx * ez - dz * ex;
  if (Math.abs(denom) < 1e-12) return Infinity;
  const wx = ax - ox;
  const wz = az - oz;
  const t = (wx * ez - wz * ex) / denom;
  const u = (wx * dz - wz * dx) / denom;
  return u >= 0 && u <= 1 && t > 0 ? t : Infinity;
};

export const bridgeParallelLegs = (
  curve: RouteCurve | null,
  edgesForProgress: ((progress: number) => WaterEdges) | undefined,
  options: BridgeParallelLegsOptions = {},
): ParallelLegs => {
  const halfWidth = options.halfWidth ?? DEFAULT_WATER_HALF_WIDTH_M;
  const base = edgesForProgress ?? ((): WaterEdges => ({ left: halfWidth, right: halfWidth }));
  if (!curve || curve.length < 2) return { edgesForProgress: base, bridged: 0, selfParallel: [] };

  const gap = options.gap ?? PARALLEL_LEG_GAP_METRES;
  const divisions = Math.max(2, options.divisions ?? defaultStripDivisions(curve));
  const stations = divisions + 1;
  const p = buildWaterStrip(curve, { edgesForProgress: base, divisions }).positions;

  // Per station: centre, unit left→right direction, the two edge widths,
  // and distance along the route.
  const cx = new Float64Array(stations);
  const cz = new Float64Array(stations);
  const ux = new Float64Array(stations);
  const uz = new Float64Array(stations);
  const left = new Float64Array(stations);
  const right = new Float64Array(stations);
  const along = new Float64Array(stations);
  let widest = 0;
  for (let i = 0; i < stations; i += 1) {
    const e = base(i / divisions);
    left[i] = e.left;
    right[i] = e.right;
    const lx = p[i * 6];
    const lz = p[i * 6 + 2];
    const rx = p[i * 6 + 3];
    const rz = p[i * 6 + 5];
    const span = e.left + e.right;
    const len = Math.hypot(rx - lx, rz - lz);
    ux[i] = len > 0 ? (rx - lx) / len : 1;
    uz[i] = len > 0 ? (rz - lz) / len : 0;
    const f = span > 0 ? e.left / span : 0.5;
    cx[i] = lx + (rx - lx) * f;
    cz[i] = lz + (rz - lz) * f;
    if (i > 0) along[i] = along[i - 1] + Math.hypot(cx[i] - cx[i - 1], cz[i] - cz[i - 1]);
    widest = Math.max(widest, e.left, e.right);
  }
  // A leg never meets itself within this much route.
  const window = gap + 2 * widest;

  // Shoreline segments (quad j's left and right edges), bucketed.
  const grid = new Map<string, number[]>();
  const key = (ix: number, iz: number) => `${ix},${iz}`;
  const segEnds = (s: number): [number, number, number, number] => {
    const j = s >> 1;
    const o = s & 1 ? 3 : 0;
    return [p[j * 6 + o], p[j * 6 + o + 2], p[(j + 1) * 6 + o], p[(j + 1) * 6 + o + 2]];
  };
  for (let s = 0; s < divisions * 2; s += 1) {
    const [ax, az, bx, bz] = segEnds(s);
    for (let ix = Math.floor(Math.min(ax, bx) / CELL_METRES); ix <= Math.floor(Math.max(ax, bx) / CELL_METRES); ix += 1) {
      for (let iz = Math.floor(Math.min(az, bz) / CELL_METRES); iz <= Math.floor(Math.max(az, bz) / CELL_METRES); iz += 1) {
        const k = key(ix, iz);
        const list = grid.get(k);
        if (list) list.push(s);
        else grid.set(k, [s]);
      }
    }
  }

  const seen = new Int32Array(divisions * 2).fill(-1);
  let stamp = 0;
  /** Nearest other-leg shoreline along the ray, within `reach`. */
  const nearestShore = (i: number, dx: number, dz: number, reach: number): number => {
    stamp += 1;
    const ox = cx[i];
    const oz = cz[i];
    const ex = ox + dx * reach;
    const ez = oz + dz * reach;
    let best = Infinity;
    for (let ix = Math.floor(Math.min(ox, ex) / CELL_METRES); ix <= Math.floor(Math.max(ox, ex) / CELL_METRES); ix += 1) {
      for (let iz = Math.floor(Math.min(oz, ez) / CELL_METRES); iz <= Math.floor(Math.max(oz, ez) / CELL_METRES); iz += 1) {
        const list = grid.get(key(ix, iz));
        if (!list) continue;
        for (const s of list) {
          if (seen[s] === stamp) continue;
          seen[s] = stamp;
          const j = s >> 1;
          const near = Math.min(Math.abs(along[j] - along[i]), Math.abs(along[j + 1] - along[i]));
          if (near < window) continue;
          const [ax, az, bx, bz] = segEnds(s);
          const t = raySegment(ox, oz, dx, dz, ax, az, bx, bz);
          if (t <= reach && t < best) best = t;
        }
      }
    }
    return best;
  };

  const landBetween = (i: number, dx: number, dz: number, from: number, to: number): boolean => {
    if (!options.isLand) return false;
    for (let t = from; t <= to; t += LAND_STEP_METRES) {
      if (options.isLand(cx[i] + dx * t, cz[i] + dz * t)) return true;
    }
    return options.isLand(cx[i] + dx * to, cz[i] + dz * to);
  };

  const outLeft = Float64Array.from(left);
  const outRight = Float64Array.from(right);
  const parallel = new Uint8Array(stations);
  let bridged = 0;
  for (let i = 0; i < stations; i += 1) {
    for (const side of [-1, 1] as const) {
      const edge = side < 0 ? left[i] : right[i];
      const dx = ux[i] * side;
      const dz = uz[i] * side;
      const hit = nearestShore(i, dx, dz, edge + gap);
      if (!Number.isFinite(hit)) continue;
      parallel[i] = 1;
      if (hit <= edge || landBetween(i, dx, dz, edge, hit)) continue;
      const widened = hit + PARALLEL_LEG_OVERLAP_METRES;
      if (side < 0) outLeft[i] = widened;
      else outRight[i] = widened;
      bridged += 1;
    }
  }

  const selfParallel: Array<[number, number]> = [];
  for (let i = 0; i < stations; i += 1) {
    if (!parallel[i]) continue;
    let j = i;
    while (j + 1 < stations && parallel[j + 1]) j += 1;
    selfParallel.push([i / divisions, j / divisions]);
    i = j;
  }

  if (bridged === 0) return { edgesForProgress: base, bridged, selfParallel };
  const at = (edges: Float64Array, progress: number): number => {
    const x = Math.max(0, Math.min(1, progress)) * divisions;
    const i = Math.min(divisions - 1, Math.floor(x));
    const f = x - i;
    return edges[i] + (edges[i + 1] - edges[i]) * f;
  };
  return {
    edgesForProgress: (progress) => ({ left: at(outLeft, progress), right: at(outRight, progress) }),
    bridged,
    selfParallel,
  };
};

/**
 * Land from the route's lake polygons: inside any island (a hole in a
 * lake). Undefined when the route carries no islands.
 */
export const islandLand = (
  lakes: ReadonlyArray<{ holes: ReadonlyArray<ReadonlyArray<{ x: number; z: number }>> }> | undefined,
): ((x: number, z: number) => boolean) | undefined => {
  const rings = (lakes ?? []).flatMap((l) => l.holes).filter((r) => r.length >= 3);
  if (rings.length === 0) return undefined;
  return (x, z) => rings.some((ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
  });
};
