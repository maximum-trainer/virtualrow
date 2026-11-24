/**
 * #764 VP-36 FR5 — the inside of a real wood near the course: kit trees at
 * the route profile's density, inside the wood's outline and within 400 m of
 * the course. Beyond that the treeline strips (FR4) and the mask's dark
 * woodland ground carry the wood.
 *
 * Pure. Species follow the wood's `leaf_type` when the map has it, else the
 * route's own tree species (the region default). Nearest trees first, within
 * the tier's budget.
 */
import type { LandCoverFeature, LeafType, ScenePoint } from '../services/landscapeService';
import type { PerformanceMode } from './sceneryPlacement';
import { nearestOnCourse } from './treelinePlan';

/** FR5 — kit trees stand inside woods this near the course. */
export const WOODLAND_TREE_REACH_M = 400;
/** No tree nearer the course line than this: the bank and the water are the bank's. */
export const WOODLAND_TREE_CLEAR_M = 40;
/** Metres between trees at profile density 1 (dense forest). */
export const WOODLAND_TREE_SPACING_M = 12;
/** FR8 — kit trees from woods resident per tier. */
export const WOODLAND_TREE_BUDGET: Record<PerformanceMode, number> = {
  basic: 0,
  low: 100,
  medium: 250,
  high: 500,
  'extra-high': 800,
};

/** The kit trees each leaf type stands for. */
export const LEAF_TYPE_MODELS: Record<LeafType, string[]> = {
  broadleaved: ['e04-english-oak', 'e01-london-plane'],
  needleleaved: ['e08-scots-pine', 'e07-eastern-white-pine'],
  mixed: ['e04-english-oak', 'e08-scots-pine', 'e01-london-plane', 'e07-eastern-white-pine'],
};
/** When a wood has no leaf type and the route names no species. */
const DEFAULT_WOOD_MODELS = LEAF_TYPE_MODELS.mixed;

export interface WoodlandTree {
  id: string;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  distance: number;
}

const WOODLAND = new Set(['wood', 'forest']);

const insideRing = (ring: readonly ScenePoint[], x: number, z: number): boolean => {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xa, za] = ring[a];
    const [xb, zb] = ring[b];
    if (za > z !== zb > z && x < xa + ((z - za) * (xb - xa)) / (zb - za)) inside = !inside;
  }
  return inside;
};

/** A repeatable 0..1 from two integers. */
const hash = (i: number, j: number, salt: number): number => {
  const s = Math.sin(i * 127.1 + j * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

export interface WoodlandTreeInput {
  features: readonly LandCoverFeature[];
  course: readonly ScenePoint[];
  /** The route profile's tree density, 0..1 (`SCENERY_PROFILES[profile].trees.density`). */
  density: number;
  /** The route's own kit tree models: the region default. */
  regionTrees: readonly string[];
  max: number;
}

export const planWoodlandTrees = ({ features, course, density, regionTrees, max }: WoodlandTreeInput): WoodlandTree[] => {
  if (course.length < 2 || max <= 0 || density <= 0) return [];
  const spacing = WOODLAND_TREE_SPACING_M / Math.sqrt(Math.min(1, density));
  const trees: WoodlandTree[] = [];
  for (const wood of features) {
    if (wood.shape !== 'polygon' || !WOODLAND.has(wood.kind)) continue;
    const ring = wood.points;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of ring) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const models = wood.leafType ? LEAF_TYPE_MODELS[wood.leafType] : regionTrees.length > 0 ? regionTrees : DEFAULT_WOOD_MODELS;
    // A jittered lattice anchored to world multiples of the spacing, so the
    // same wood plants the same trees whatever else is on the map.
    for (let j = Math.floor(minZ / spacing); j * spacing <= maxZ; j += 1) {
      for (let i = Math.floor(minX / spacing); i * spacing <= maxX; i += 1) {
        const x = (i + 0.2 + 0.6 * hash(i, j, 1)) * spacing;
        const z = (j + 0.2 + 0.6 * hash(i, j, 2)) * spacing;
        if (!insideRing(ring, x, z)) continue;
        const distance = nearestOnCourse([...course], x, z).distance;
        if (distance > WOODLAND_TREE_REACH_M || distance < WOODLAND_TREE_CLEAR_M) continue;
        trees.push({
          id: models[Math.floor(hash(i, j, 3) * models.length) % models.length],
          x,
          z,
          yaw: hash(i, j, 4) * Math.PI * 2,
          scale: 0.8 + 0.4 * hash(i, j, 5),
          distance,
        });
      }
    }
  }
  trees.sort((a, b) => a.distance - b.distance || a.x - b.x || a.z - b.z);
  return trees.slice(0, max);
};
