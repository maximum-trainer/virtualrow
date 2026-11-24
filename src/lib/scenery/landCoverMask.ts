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
 * water, then built-up, then woodland, then hedge lines, then the rest.
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

