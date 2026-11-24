/**
 * #764 VP-36 FR1 / FR3 — the land-cover class mask: the #762 land-cover
 * polygons and hedge lines rasterised into one byte per texel over the
 * landscape area, for `bank.wgsl` to sample by world XZ.
 *
 * Pure: no GPU here. The texture is `r8uint`, at least `LAND_COVER_TEXEL_M`
 * per texel and never more than `LAND_COVER_MAX_TEXELS` on a side; a larger
 * area takes coarser texels rather than more memory (FR8: 4 MB at most).
 *
 * Where shapes overlap the higher class in `LAND_COVER_PRIORITY` wins:
 * the sea, then water, then built-up, then woodland, then hedge lines, then
 * the rest. The sea is whatever lies seaward of the map's coastline (FR6).
 */
import type { LandCoverFeature, LandCoverKind, ScenePoint } from '../services/landscapeService';

export const LandCoverClass = {
  unknown: 0,
  pasture: 1,
  arable: 2,
  woodland: 3,
  scrub: 4,
  wetland: 5,
  bare: 6,
  sand: 7,
  built: 8,
  water: 9,
  hedge: 10,
  /** FR6 — seaward of `natural=coastline`: no ground is drawn there. */
  sea: 11,
} as const;
export type LandCoverClassId = (typeof LandCoverClass)[keyof typeof LandCoverClass];

/** Higher wins where shapes overlap. */
export const LAND_COVER_PRIORITY: Record<LandCoverClassId, number> = {
  [LandCoverClass.unknown]: 0,
  [LandCoverClass.pasture]: 1,
  [LandCoverClass.arable]: 1,
  [LandCoverClass.scrub]: 1,
  [LandCoverClass.wetland]: 1,
  [LandCoverClass.bare]: 1,
  [LandCoverClass.sand]: 1,
  [LandCoverClass.hedge]: 2,
  [LandCoverClass.woodland]: 3,
  [LandCoverClass.built]: 4,
  [LandCoverClass.water]: 5,
  [LandCoverClass.sea]: 6,
};

export const LAND_COVER_TEXEL_M = 8;
/** FR3 — the invented hedge grid is dropped this close to a real hedge. */
export const REAL_HEDGE_REACH_M = 500;
/** Bit set on a texel within `REAL_HEDGE_REACH_M` of a real hedge; the class is the low 4 bits. */
export const REAL_HEDGE_NEAR_BIT = 0x80;
/** Coarse cells the hedge reach is worked out on, in texels a side. */
const HEDGE_CELL_TEXELS = 8;
export const LAND_COVER_MAX_TEXELS = 2048;

/** The class an OSM land-cover kind paints. Coastline is not an area: null. */
export const classForKind = (kind: LandCoverKind): LandCoverClassId | null => {
  switch (kind) {
    case 'meadow':
      return LandCoverClass.pasture;
    case 'farmland':
    case 'orchard':
    case 'vineyard':
      return LandCoverClass.arable;
    case 'wood':
    case 'forest':
      return LandCoverClass.woodland;
    case 'scrub':
    case 'heath':
      return LandCoverClass.scrub;
    case 'wetland':
      return LandCoverClass.wetland;
    case 'bare_rock':
      return LandCoverClass.bare;
    case 'beach':
    case 'sand':
      return LandCoverClass.sand;
    case 'residential':
    case 'industrial':
    case 'commercial':
    case 'retail':
      return LandCoverClass.built;
    case 'hedge':
    case 'tree_row':
      return LandCoverClass.hedge;
    default:
      return null;
  }
};

export interface LandCoverMask {
  /** World X, Z of texel (0, 0)'s corner; texel (i, j) spans x + i*texelM .. +texelM. */
  originX: number;
  originZ: number;
  texelM: number;
  width: number;
  height: number;
  /** Row-major, row j = z from originZ upward. */
  data: Uint8Array;
  classesPresent: LandCoverClassId[];
  /** Total length of hedge and tree-row lines, metres (#764 FR10). */
  hedgeMetres: number;
}

export interface LandCoverMaskInput {
  /** World-XZ box the mask covers: min x, min z, max x, max z. */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  features: LandCoverFeature[];
  /** Water areas (lakes, river polygons) in world XZ, closed or open rings. */
  water?: ScenePoint[][];
}

export const buildLandCoverMask = (input: LandCoverMaskInput): LandCoverMask => {
  const { minX, minZ, maxX, maxZ } = input.bounds;
  const span = Math.max(maxX - minX, maxZ - minZ, 1);
  const texelM = Math.max(LAND_COVER_TEXEL_M, span / LAND_COVER_MAX_TEXELS);
  const width = Math.min(LAND_COVER_MAX_TEXELS, Math.max(1, Math.ceil((maxX - minX) / texelM)));
  const height = Math.min(LAND_COVER_MAX_TEXELS, Math.max(1, Math.ceil((maxZ - minZ) / texelM)));
  const data = new Uint8Array(width * height);
  const present = new Set<LandCoverClassId>();

  const paint = (index: number, cls: LandCoverClassId) => {
    if (LAND_COVER_PRIORITY[cls] > LAND_COVER_PRIORITY[data[index] as LandCoverClassId]) data[index] = cls;
  };

  const fillPolygon = (ring: ScenePoint[], cls: LandCoverClassId) => {
    if (ring.length < 3) return;
    let rMinX = Infinity;
    let rMaxX = -Infinity;
    let rMinZ = Infinity;
    let rMaxZ = -Infinity;
    for (const [x, z] of ring) {
      rMinX = Math.min(rMinX, x);
      rMaxX = Math.max(rMaxX, x);
      rMinZ = Math.min(rMinZ, z);
      rMaxZ = Math.max(rMaxZ, z);
    }
    const j0 = Math.max(0, Math.floor((rMinZ - minZ) / texelM));
    const j1 = Math.min(height - 1, Math.ceil((rMaxZ - minZ) / texelM));
    const i0 = Math.max(0, Math.floor((rMinX - minX) / texelM));
    const i1 = Math.min(width - 1, Math.ceil((rMaxX - minX) / texelM));
    for (let j = j0; j <= j1; j += 1) {
      const z = minZ + (j + 0.5) * texelM;
      // Scanline: the ring's crossings of this row, sorted.
      const xs: number[] = [];
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xa, za] = ring[a];
        const [xb, zb] = ring[b];
        if (za > z !== zb > z) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(i0, Math.ceil((xs[k] - minX) / texelM - 0.5));
        const to = Math.min(i1, Math.floor((xs[k + 1] - minX) / texelM - 0.5));
        for (let i = from; i <= to; i += 1) paint(j * width + i, cls);
      }
    }
    present.add(cls);
  };

  let hedgeMetres = 0;
  const cellsX = Math.ceil(width / HEDGE_CELL_TEXELS);
  const cellsZ = Math.ceil(height / HEDGE_CELL_TEXELS);
  const hedgeCells = new Uint8Array(cellsX * cellsZ);
  const drawLine = (points: ScenePoint[], cls: LandCoverClassId) => {
    for (let s = 1; s < points.length; s += 1) {
      const [x0, z0] = points[s - 1];
      const [x1, z1] = points[s];
      const length = Math.hypot(x1 - x0, z1 - z0);
      hedgeMetres += length;
      const steps = Math.max(1, Math.ceil(length / (texelM * 0.5)));
      for (let t = 0; t <= steps; t += 1) {
        const x = x0 + ((x1 - x0) * t) / steps;
        const z = z0 + ((z1 - z0) * t) / steps;
        const i = Math.floor((x - minX) / texelM);
        const j = Math.floor((z - minZ) / texelM);
        if (i >= 0 && i < width && j >= 0 && j < height) {
          paint(j * width + i, cls);
          hedgeCells[Math.floor(j / HEDGE_CELL_TEXELS) * cellsX + Math.floor(i / HEDGE_CELL_TEXELS)] = 1;
        }
      }
    }
    present.add(cls);
  };

  for (const feature of input.features) {
    const cls = classForKind(feature.kind);
    if (cls === null) continue;
    if (feature.shape === 'line') {
      if (cls === LandCoverClass.hedge) drawLine(feature.points, cls);
      continue;
    }
    fillPolygon(feature.points, cls);
  }
  for (const ring of input.water ?? []) fillPolygon(ring, LandCoverClass.water);
  const coast = coastSegments(input.features);
  if (coast.length > 0 && paintSea(data, width, height, minX, minZ, texelM, coast)) present.add(LandCoverClass.sea);
  markRealHedgeReach(data, width, height, texelM, hedgeCells);

  return {
    originX: minX,
    originZ: minZ,
    texelM,
    width,
    height,
    data,
    classesPresent: [...present].sort((a, b) => a - b),
    hedgeMetres,
  };
};

/**
 * FR3 — set `REAL_HEDGE_NEAR_BIT` on every texel whose coarse cell lies within
 * `REAL_HEDGE_REACH_M` of a cell a hedge crosses (centre to centre, plus a
 * cell's half-diagonal so no texel in reach is missed).
 */
const markRealHedgeReach = (data: Uint8Array, width: number, height: number, texelM: number, cells: Uint8Array) => {
  const cellsX = Math.ceil(width / HEDGE_CELL_TEXELS);
  const cellsZ = Math.ceil(height / HEDGE_CELL_TEXELS);
  const cellM = HEDGE_CELL_TEXELS * texelM;
  const reach = Math.ceil((REAL_HEDGE_REACH_M + cellM * Math.SQRT2) / cellM);
  const near = new Uint8Array(cells.length);
  for (let cz = 0; cz < cellsZ; cz += 1) {
    for (let cx = 0; cx < cellsX; cx += 1) {
      if (!cells[cz * cellsX + cx]) continue;
      for (let dz = -reach; dz <= reach; dz += 1) {
        const z = cz + dz;
        if (z < 0 || z >= cellsZ) continue;
        for (let dx = -reach; dx <= reach; dx += 1) {
          const x = cx + dx;
          if (x < 0 || x >= cellsX || Math.hypot(dx, dz) * cellM > REAL_HEDGE_REACH_M + cellM * Math.SQRT2) continue;
          near[z * cellsX + x] = 1;
        }
      }
    }
  }
  for (let j = 0; j < height; j += 1) {
    const row = Math.floor(j / HEDGE_CELL_TEXELS) * cellsX;
    for (let i = 0; i < width; i += 1) {
      if (near[row + Math.floor(i / HEDGE_CELL_TEXELS)]) data[j * width + i] |= REAL_HEDGE_NEAR_BIT;
    }
  }
};

type Segment = [number, number, number, number];

const coastSegments = (features: LandCoverFeature[]): Segment[] => {
  const segments: Segment[] = [];
  for (const f of features) {
    if (f.kind !== 'coastline' || f.shape !== 'line') continue;
    for (let s = 1; s < f.points.length; s += 1) {
      const [x0, z0] = f.points[s - 1];
      const [x1, z1] = f.points[s];
      if (x0 !== x1 || z0 !== z1) segments.push([x0, z0, x1, z1]);
    }
  }
  return segments;
};

/**
 * Squared distance from (x, z) to a segment, written to `out[0]`, and how far
 * off the segment's line the point is, signed (> 0 land), to `out[1]`.
 */
const segmentSide = ([x0, z0, x1, z1]: Segment, x: number, z: number, out: Float64Array): void => {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const px = x - x0;
  const pz = z - z0;
  const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / (dx * dx + dz * dz)));
  const ex = px - t * dx;
  const ez = pz - t * dz;
  out[0] = ex * ex + ez * ez;
  // OSM draws coastline with the land on its left. Scene z is -north, so the
  // left of a heading (dx, dz) is where dz*px - dx*pz is positive.
  out[1] = (dz * px - dx * pz) / Math.hypot(dx, dz);
};

const scratch = new Float64Array(2);

/**
 * The nearest segment's squared distance and side at (x, z). Where two
 * segments are equally near (a shared vertex) the one the point is further
 * off the line of decides, which settles convex and concave corners.
 */
const nearestSide = (segments: readonly Segment[], x: number, z: number): { d2: number; side: number } => {
  let best = Infinity;
  let side = 0;
  for (const seg of segments) {
    segmentSide(seg, x, z, scratch);
    if (scratch[0] < best - 1e-6) {
      best = scratch[0];
      side = scratch[1];
    } else if (scratch[0] <= best + 1e-6 && Math.abs(scratch[1]) > Math.abs(side)) {
      side = scratch[1];
    }
  }
  return { d2: best, side };
};

const seaward = (segments: readonly Segment[], x: number, z: number): boolean => nearestSide(segments, x, z).side < 0;

/** Whether world (x, z) is seaward of the map's coastline; false with none (FR6). */
export const seawardOfCoast = (features: LandCoverFeature[], x: number, z: number): boolean => {
  const segments = coastSegments(features);
  return segments.length > 0 && seaward(segments, x, z);
};

/** Cells either side of the coastline settled against the segments themselves. */
const COAST_BAND_CELLS = 2;

/**
 * FR6 — the sea class on every texel seaward of the coastline. The coarse
 * cells within `COAST_BAND_CELLS` of the coastline are settled against the
 * segments near them (texel by texel where the coast crosses the cell); every
 * other cell takes the side of the nearest band cell it connects to, which is
 * linear in the mask's size however long the coast. True if any texel is sea.
 */
const paintSea = (
  data: Uint8Array,
  width: number,
  height: number,
  minX: number,
  minZ: number,
  texelM: number,
  segments: Segment[],
): boolean => {
  const cellM = HEDGE_CELL_TEXELS * texelM;
  const halfDiag = (cellM * Math.SQRT2) / 2;
  const cellsX = Math.ceil(width / HEDGE_CELL_TEXELS);
  const cellsZ = Math.ceil(height / HEDGE_CELL_TEXELS);
  const cellCount = cellsX * cellsZ;
  // The segments that pass through each cell.
  const through = new Map<number, number[]>();
  segments.forEach(([x0, z0, x1, z1], k) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (cellM * 0.5)));
    for (let t = 0; t <= steps; t += 1) {
      const cx = Math.floor((x0 + ((x1 - x0) * t) / steps - minX) / cellM);
      const cz = Math.floor((z0 + ((z1 - z0) * t) / steps - minZ) / cellM);
      if (cx < 0 || cz < 0 || cx >= cellsX || cz >= cellsZ) continue;
      const list = through.get(cz * cellsX + cx);
      if (!list) through.set(cz * cellsX + cx, [k]);
      else if (list[list.length - 1] !== k) list.push(k);
    }
  });
  // 0 not yet known, 1 land, 2 sea.
  const label = new Uint8Array(cellCount);
  let any = false;
  const fillCell = (cx: number, cz: number) => {
    const j1 = Math.min(height, (cz + 1) * HEDGE_CELL_TEXELS);
    const i1 = Math.min(width, (cx + 1) * HEDGE_CELL_TEXELS);
    for (let j = cz * HEDGE_CELL_TEXELS; j < j1; j += 1) {
      for (let i = cx * HEDGE_CELL_TEXELS; i < i1; i += 1) data[j * width + i] = LandCoverClass.sea;
    }
    any = true;
  };
  if (through.size === 0) {
    // The coast lies wholly outside the mask: the mask is on one side of it.
    if (!seaward(segments, minX + (width * texelM) / 2, minZ + (height * texelM) / 2)) return false;
    for (let cz = 0; cz < cellsZ; cz += 1) for (let cx = 0; cx < cellsX; cx += 1) fillCell(cx, cz);
    return any;
  }
  const queue: number[] = [];
  const reach = COAST_BAND_CELLS + 1;
  const isBand = new Uint8Array(cellCount);
  for (const key of through.keys()) {
    const kx = key % cellsX;
    const kz = (key - kx) / cellsX;
    for (let z = Math.max(0, kz - COAST_BAND_CELLS); z <= Math.min(cellsZ - 1, kz + COAST_BAND_CELLS); z += 1) {
      for (let x = Math.max(0, kx - COAST_BAND_CELLS); x <= Math.min(cellsX - 1, kx + COAST_BAND_CELLS); x += 1) {
        isBand[z * cellsX + x] = 1;
      }
    }
  }
  for (let cz = 0; cz < cellsZ; cz += 1) {
    for (let cx = 0; cx < cellsX; cx += 1) {
      if (!isBand[cz * cellsX + cx]) continue;
      // Any segment nearest to a point in this cell passes within `reach` cells.
      const near = new Set<number>();
      for (let z = Math.max(0, cz - reach); z <= Math.min(cellsZ - 1, cz + reach); z += 1) {
        for (let x = Math.max(0, cx - reach); x <= Math.min(cellsX - 1, cx + reach); x += 1) {
          for (const k of through.get(z * cellsX + x) ?? []) near.add(k);
        }
      }
      const candidates = [...near].map((k) => segments[k]);
      const i0 = cx * HEDGE_CELL_TEXELS;
      const j0 = cz * HEDGE_CELL_TEXELS;
      const i1 = Math.min(width, i0 + HEDGE_CELL_TEXELS);
      const j1 = Math.min(height, j0 + HEDGE_CELL_TEXELS);
      const centre = nearestSide(candidates, minX + ((i0 + i1) / 2) * texelM, minZ + ((j0 + j1) / 2) * texelM);
      label[cz * cellsX + cx] = centre.side < 0 ? 2 : 1;
      queue.push(cz * cellsX + cx);
      if (Math.sqrt(centre.d2) > halfDiag * 1.01) {
        // No coastline crosses this cell, so every texel shares its side.
        if (centre.side < 0) fillCell(cx, cz);
        continue;
      }
      for (let j = j0; j < j1; j += 1) {
        const z = minZ + (j + 0.5) * texelM;
        for (let i = i0; i < i1; i += 1) {
          if (seaward(candidates, minX + (i + 0.5) * texelM, z)) {
            data[j * width + i] = LandCoverClass.sea;
            any = true;
          }
        }
      }
    }
  }
  // Every other cell takes the side of the band it is reached from first.
  for (let q = 0; q < queue.length; q += 1) {
    const key = queue[q];
    const kx = key % cellsX;
    const kz = (key - kx) / cellsX;
    const neighbours = [
      kx > 0 ? key - 1 : -1,
      kx < cellsX - 1 ? key + 1 : -1,
      kz > 0 ? key - cellsX : -1,
      kz < cellsZ - 1 ? key + cellsX : -1,
    ];
    for (const n of neighbours) {
      if (n < 0 || label[n]) continue;
      label[n] = label[key];
      queue.push(n);
      if (label[n] === 2) fillCell(n % cellsX, Math.floor(n / cellsX));
    }
  }
  return any;
};

/** Whether a real hedge lies within `REAL_HEDGE_REACH_M` of world (x, z) (FR3). */
export const realHedgeNear = (mask: LandCoverMask, x: number, z: number): boolean => {
  const i = Math.floor((x - mask.originX) / mask.texelM);
  const j = Math.floor((z - mask.originZ) / mask.texelM);
  if (i < 0 || j < 0 || i >= mask.width || j >= mask.height) return false;
  return (mask.data[j * mask.width + i] & REAL_HEDGE_NEAR_BIT) !== 0;
};

/** The class at world (x, z); unknown outside the mask. */
export const classAt = (mask: LandCoverMask, x: number, z: number): LandCoverClassId => {
  const i = Math.floor((x - mask.originX) / mask.texelM);
  const j = Math.floor((z - mask.originZ) / mask.texelM);
  if (i < 0 || j < 0 || i >= mask.width || j >= mask.height) return LandCoverClass.unknown;
  return (mask.data[j * mask.width + i] & 0x0f) as LandCoverClassId;
};

