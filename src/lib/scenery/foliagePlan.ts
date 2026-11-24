/**
 * Three-free port of the parts of `src/components/rower3d/foliagePlan.ts`
 * that produce foliage placements for the WebGPU engine's foliage pools.
 *
 * Where the React version returns a `FoliageTree[]` and a THREE-based batcher
 * for an InstancedMesh, this one skips the matrix build (the engine's
 * instance pools pack centres only + a species/sway metadata u32) and emits
 * one `PoolInput` per (species, chunk). It walks the route the same way:
 * one slot per `FOLIAGE_SLOT_METRES` on each bank, plants with a chance that
 * follows the segment's scenery profile, offsets each tree past the water
 * line + a seeded depth into the band behind. It uses the same `seededRandom`
 * so a route+seed produces the same slot decisions as the React layout — the
 * parity test asserts the slot/species/x/z decisions line up.
 *
 * Per-tree height and yaw aren't carried on the GPU side (the engine's
 * foliage pass takes one billboard size per species via its own uniform),
 * so this port encodes only the sway seed in the pool's metadata — same
 * shape as `buildSmokeFoliagePools`. The scaleRange roll is still consumed
 * on the CPU so the parity test can inspect it.
 */

import type { RouteCurve } from '../renderer/math/curve';
import type { PoolInput, PoolBounds } from '../renderer/plan/instancePools';
import { SCENERY_PROFILES } from '../../components/rower3d/sceneryConfig';
import { getSegmentSceneryProfile } from '../../components/rower3d/segmentScenery';
import type { SceneryTrack } from '../../components/rower3d/sceneryTrack';
import {
  getWaterEdgesSceneUnitsForProgress,
  type RouteEnrichmentData,
  type SceneryProfile,
} from '../services/routeEnrichmentService';
import { seededRandom } from './seededRandom';
import { bandsClearOf } from './sceneryPlacement';
import { DEFAULT_WATER_WIDTH_METERS } from './waterHalfWidth';

export const FOLIAGE_SLOT_METRES = 10;
export const FOLIAGE_BAND_DEPTH_METRES = 60;
/**
 * #725 VP-07 FR3 — sprite cards stand only beyond this distance from the
 * route (and behind the kit-tree band, wherever a wide river pushes that
 * out); everything nearer is a kit tree.
 */
export const SPRITE_NEAR_LIMIT_METRES = 120;
export const FOLIAGE_BUILDING_CLEARANCE_METRES = 10;
const FRONT_BIAS = 1.8;
export const SCENERY_WATER_MARGIN_METRES = 2;

/** Species shapes the renderer knows about, in a fixed order so pool indices are stable. */
export type FoliageShape = 'broadleaf' | 'conifer' | 'willow';
export const FOLIAGE_SHAPES: readonly FoliageShape[] = ['broadleaf', 'conifer', 'willow'];

/** Mirror of `src/components/rower3d/foliageTexture.ts`'s `foliageShapeFor`. */
export const foliageShapeFor = (type: string): FoliageShape => {
  if (type === 'pine' || type === 'cypress') return 'conifer';
  if (type === 'willow') return 'willow';
  return 'broadleaf';
};

export interface FoliageTree {
  position: [number, number, number];
  progress: number;
  species: number;
  height: number;
  yaw: number;
}

export interface FoliageLayoutInput {
  curve: RouteCurve | null;
  enrichment?: RouteEnrichmentData | null;
  track?: SceneryTrack | null;
  /** The species the scene knows about; by convention, FOLIAGE_SHAPES as strings. */
  speciesTypes: readonly string[];
  avoid?: readonly { x: number; z: number }[];
}

const sideOf = (offset: number): 'left' | 'right' => (offset < 0 ? 'left' : 'right');
const nearestBankOffset = (halfWidth: number): number => halfWidth + SCENERY_WATER_MARGIN_METRES;

const waterHalfWidthAt = (
  enrichment: RouteEnrichmentData | null | undefined,
  progress: number,
  side: 'left' | 'right',
): number => {
  const fallback = enrichment?.waterWidthMeters ?? DEFAULT_WATER_WIDTH_METERS;
  return getWaterEdgesSceneUnitsForProgress(enrichment?.segmentProfiles, fallback, progress)[side];
};

/** Nearest a sprite card stands to the route centreline, metres. */
export const spriteInnerOffset = (halfWidth: number): number =>
  Math.max(SPRITE_NEAR_LIMIT_METRES, nearestBankOffset(halfWidth), bandsClearOf(halfWidth).trees[1]);

const plantingChance = (density: number): number => 0.3 + 0.5 * density;

/** Species indices (into `speciesTypes`) a profile may plant. */
const speciesFor = (
  profile: SceneryProfile,
  speciesTypes: readonly string[],
): number[] => {
  const named = new Set(SCENERY_PROFILES[profile].trees.species);
  const all = speciesTypes.map((_, i) => i);
  const byName = all.filter((i) => named.has(speciesTypes[i]));
  if (byName.length > 0) return byName;
  const shapes = new Set([...named].map(foliageShapeFor));
  const byShape = all.filter((i) => shapes.has(foliageShapeFor(speciesTypes[i])));
  return byShape.length > 0 ? byShape : all;
};

/**
 * #686 D3b — weighted species pick. Each profile declares a
 * `biomeMix` alongside its allowed species; weights are matched to the
 * profile's `species` list by position and then re-indexed onto the
 * subset we actually plant (`speciesFor` may drop species the theme
 * doesn't carry). An undefined mix, or one that doesn't line up with
 * the resolved subset, falls back to uniform — today's behaviour.
 *
 * `draw` is in [0, 1). The algorithm maps it onto the cumulative weight
 * sum so a mix of `[60, 30, 10]` picks the first species 60 % of the
 * time, the second 30 %, the third 10 %.
 *
 * Exported for direct tests only — production code uses it via
 * `layoutFoliage`.
 */
export const pickWeightedSpecies = (
  profile: SceneryProfile,
  speciesTypes: readonly string[],
  choices: readonly number[],
  draw: number,
): number => {
  if (choices.length === 0) return 0;
  const profileSpecies = SCENERY_PROFILES[profile].trees.species;
  const mix = SCENERY_PROFILES[profile].trees.biomeMix;
  if (!mix || mix.length !== profileSpecies.length) {
    return choices[Math.floor(draw * choices.length)];
  }
  // Translate each resolved choice into the weight for its species
  // name on the profile's own list. A choice whose species name isn't
  // on the list (shape-fallback branch of `speciesFor`) gets weight 0;
  // if every weight is zero we fall back to uniform.
  const weights = choices.map((i) => {
    const name = speciesTypes[i];
    const idx = profileSpecies.indexOf(name);
    return idx >= 0 ? Math.max(0, mix[idx]) : 0;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return choices[Math.floor(draw * choices.length)];
  let acc = 0;
  const pick = draw * total;
  for (let i = 0; i < weights.length; i += 1) {
    acc += weights[i];
    if (pick < acc) return choices[i];
  }
  return choices[choices.length - 1];
};

const SHAPE_HEIGHT: Record<FoliageShape, number> = {
  broadleaf: 14,
  conifer: 17,
  willow: 12,
};

/**
 * Plant both banks of a route, deterministically. Matches the slot/side/seed
 * schedule of `src/components/rower3d/foliagePlan.ts` `layoutFoliage` so the
 * parity test can diff tree-by-tree against the React originals.
 */
export const layoutFoliage = ({
  curve,
  enrichment,
  track = null,
  speciesTypes,
  avoid = [],
}: FoliageLayoutInput): FoliageTree[] => {
  if (!curve) return [];
  const length = curve.approximateLength(128);
  if (!(length > 0)) return [];
  const slots = Math.floor(length / FOLIAGE_SLOT_METRES);
  const clearOfHouses = (x: number, z: number): boolean =>
    avoid.every((h) => Math.hypot(h.x - x, h.z - z) >= FOLIAGE_BUILDING_CLEARANCE_METRES);

  const trees: FoliageTree[] = [];
  const sample = { position: [0, 0, 0] as [number, number, number], tangent: [0, 0, -1] as [number, number, number], angle: 0 };
  for (let slot = 0; slot < slots; slot += 1) {
    for (const side of [-1, 1] as const) {
      const seed = slot * 13 + (side < 0 ? 1 : 7);
      const draw = (k: number): number => seededRandom(seed * 11 + k);

      const metres = (slot + 0.5 + (draw(1) - 0.5) * 0.8) * FOLIAGE_SLOT_METRES;
      const t = Math.min(1, metres / length);
      const rawProfile = getSegmentSceneryProfile(enrichment, t, track, sideOf(side));
      const profile: SceneryProfile = SCENERY_PROFILES[rawProfile] ? rawProfile : 'fallback';
      const { density, scaleRange } = SCENERY_PROFILES[profile].trees;
      if (draw(2) >= plantingChance(density)) continue;

      const curveSample = curve.sample(t);
      // tangent × up with up = (0, 1, 0) → perp = (−tz, 0, tx). Matches
      // `crossVectors(tangent, UP)` in React's `foliagePlan.ts`.
      const px = -curveSample.tangent[2];
      const pz = curveSample.tangent[0];
      const perpLen = Math.hypot(px, pz) || 1;
      const perpX = px / perpLen;
      const perpZ = pz / perpLen;
      const offset =
        spriteInnerOffset(waterHalfWidthAt(enrichment, t, sideOf(side))) +
        FOLIAGE_BAND_DEPTH_METRES * Math.pow(draw(3), FRONT_BIAS);
      const x = curveSample.position[0] + perpX * side * offset;
      const z = curveSample.position[2] + perpZ * side * offset;
      if (!clearOfHouses(x, z)) continue;

      const choices = speciesFor(profile, speciesTypes);
      const pick = pickWeightedSpecies(profile, speciesTypes, choices, draw(4));
      const [scaleMin, scaleMax] = scaleRange;
      const shape = foliageShapeFor(speciesTypes[pick]);
      sample.position = [x, 0, z];
      trees.push({
        position: [x, 0, z],
        progress: t,
        species: pick,
        height: SHAPE_HEIGHT[shape] * (scaleMin + draw(5) * (scaleMax - scaleMin)),
        yaw: draw(6) * Math.PI,
      });
    }
  }
  return trees;
};

/**
 * Group `trees` by (species, chunk) into `PoolInput`s. One pool per
 * (species, chunk) matches the engine's `createInstancePool` → cull → draw
 * path and keeps the per-chunk bounding spheres so Chromium can skip whole
 * chunks that aren't visible.
 */
export const batchFoliagePools = (
  trees: readonly FoliageTree[],
  speciesCount: number,
  routeLengthMetres: number,
  chunkMetres: number,
): PoolInput[] => {
  const chunkCount = Math.max(1, Math.ceil(routeLengthMetres / chunkMetres));
  const indexFor = (species: number, chunkIndex: number): number => species * chunkCount + chunkIndex;
  const buckets: FoliageTree[][] = Array.from({ length: speciesCount * chunkCount }, () => []);
  for (const tree of trees) {
    const ch = Math.min(chunkCount - 1, Math.max(0, Math.floor(tree.progress * chunkCount)));
    buckets[indexFor(tree.species, ch)].push(tree);
  }

  const pools: PoolInput[] = [];
  for (let s = 0; s < speciesCount; s += 1) {
    for (let c = 0; c < chunkCount; c += 1) {
      const own = buckets[indexFor(s, c)];
      if (own.length === 0) continue;
      const positions = new Float32Array(own.length * 3);
      const metadata = new Uint32Array(own.length);
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sumY = 0, maxHeight = 0;
      for (let i = 0; i < own.length; i += 1) {
        const t = own[i];
        positions[i * 3 + 0] = t.position[0];
        positions[i * 3 + 1] = t.position[1];
        positions[i * 3 + 2] = t.position[2];
        // Match `buildSmokeFoliagePools`'s metadata packing (top 16 = sway
        // seed, bottom 16 = species) so the GPU-side sway + species-index
        // code paths see what they already know how to read.
        const sway = (Math.floor(t.yaw * 10430.218) & 0xffff) >>> 0;
        metadata[i] = ((sway << 16) | (s & 0xffff)) >>> 0;
        if (t.position[0] < minX) minX = t.position[0];
        if (t.position[0] > maxX) maxX = t.position[0];
        if (t.position[2] < minZ) minZ = t.position[2];
        if (t.position[2] > maxZ) maxZ = t.position[2];
        sumY += t.position[1];
        if (t.height > maxHeight) maxHeight = t.height;
      }
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const cy = sumY / own.length;
      const half = Math.max(maxX - cx, maxZ - cz);
      const radius = Math.hypot(half, maxHeight) + maxHeight;
      const bounds: PoolBounds = { cx, cy, cz, radius };
      pools.push({
        kind: 'foliage',
        speciesIndex: s,
        chunkIndex: c,
        positions,
        metadata,
        bounds,
      });
    }
  }
  return pools;
};
