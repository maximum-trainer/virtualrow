/**
 * Three-free port of `src/components/rower3d/sceneryPlacement.ts`.
 *
 * Walks the route curve (or a flat fallback band) and emits a `Placement[]`
 * list of GLB model instances for every scenery category (bank-edge,
 * scatter, trees, buildings, landform, backdrop, surface, inWater,
 * furniture). The engine's `sceneryMesh` pass consumes the output through
 * the mesh registry — each `Placement.id` is a `SceneryModelId` the engine
 * loaded + registered at attach.
 *
 * The schedule, seeds, band offsets, scaling, yaw convention and
 * thinToCeiling behaviour mirror the React layout tree-for-tree; a parity
 * Vitest asserts the first ~100 placements agree on id, position and
 * rotation for a fixed route + seed.
 */

import type { RouteCurve } from '../renderer/math/curve';
import { vec3 } from '../renderer/math/vec3';
import type { ResolvedScenery, SceneryModelId } from '../../components/rower3d/sceneryAssets';
import { trackProfiles, type SceneryTrack } from '../../components/rower3d/sceneryTrack';
import { getSegmentSceneryProfile } from '../../components/rower3d/segmentScenery';
import {
  buildTerrainProfile,
  getTerrainReliefForProgress,
  type RouteEnrichmentData,
  type SceneryProfile,
} from '../services/routeEnrichmentService';
import { seededRandom } from './seededRandom';
import { placementRecipeFor } from './placementRecipes';
import { waterHalfWidthAt } from './waterHalfWidth';
import { keepClearHalfWidth } from './laneClearance';
import {
  BUILT_IN_FOOTPRINT_LOOKUP,
  footprintRadiusFor,
  type FootprintLookup,
} from './sceneryFootprints';

export const ASSET_SCALE = 0.001;

export type Category = keyof ResolvedScenery;

export const CATEGORY_OFFSET: Record<Category, [number, number]> = {
  surface: [0, 6],
  inWater: [0, 5],
  bankEdge: [6, 11],
  furniture: [8, 15],
  scatter: [15, 35],
  buildings: [45, 95],
  // #725 FR3 — kit trees fill the bank from just behind the scatter out
  // to the sprite limit (`SPRITE_NEAR_LIMIT_METRES`), where cards take over.
  trees: [16, 118],
  landform: [115, 150],
  backdrop: [195, 240],
};

export const LAND_BANDS: readonly Category[] = [
  'bankEdge', 'furniture', 'scatter', 'trees', 'buildings', 'landform', 'backdrop',
];

const MIN_BAND_STEP_METRES = 1;
const SCENERY_WATER_MARGIN_METRES = 2;
/** FR3: every bank footing stands this far clear of the waterline after
 *  accounting for its own footprint radius. */
const BANK_FOOTING_MARGIN_METRES = 1;
/** FR2: surface / in-water items hug the bank at most this far in. */
const WATER_PROP_BANK_INSET_METRES = 4;
/** Minimum clearance between a water prop's near edge and the waterline. */
const WATER_PROP_WATERLINE_MARGIN_METRES = 0.5;

const nearestBankOffset = (halfWidth: number): number => halfWidth + SCENERY_WATER_MARGIN_METRES;
const sideOfOffset = (offset: number): 'left' | 'right' => (offset < 0 ? 'left' : 'right');

export const bandsClearOf = (halfWidth: number): Record<Category, [number, number]> => {
  const bands = { ...CATEGORY_OFFSET };
  let previousInner = Number.NEGATIVE_INFINITY;
  for (const cat of LAND_BANDS) {
    const [oMin, oMax] = CATEGORY_OFFSET[cat];
    const inner = Math.max(oMin, nearestBankOffset(halfWidth), previousInner + MIN_BAND_STEP_METRES);
    bands[cat] = [inner, oMax + (inner - oMin)];
    previousInner = inner;
  }
  return bands;
};

export type Footing = 'bank' | 'water';
const footingOf = (cat: Category): Footing => (cat === 'surface' || cat === 'inWater' ? 'water' : 'bank');

export const CATEGORY_FACE: Record<Category, boolean> = {
  surface: false, inWater: false, bankEdge: true, furniture: true, scatter: false,
  trees: false, landform: true, backdrop: true, buildings: true,
};


export interface Placement {
  id: SceneryModelId;
  position: [number, number, number];
  rotationY: number;
  scale: number;
  progress: number;
  footing: Footing;
}

export const MAX_INSTANCES_PER_SIDE = 900;
export const MAX_SAMPLE_BANDS = 22;

export const thinToCeiling = (
  placements: Placement[],
  ceiling: number = MAX_INSTANCES_PER_SIDE,
): Placement[] => {
  if (placements.length <= ceiling) return placements;
  const stride = placements.length / ceiling;
  const kept: Placement[] = [];
  for (let i = 0; kept.length < ceiling && Math.floor(i * stride) < placements.length; i += 1) {
    kept.push(placements[Math.floor(i * stride)]);
  }
  return kept;
};

export const pick = (ids: SceneryModelId[], seed: number): SceneryModelId | null =>
  ids.length === 0 ? null : ids[Math.floor(seededRandom(seed) * ids.length)];

/** Mirror of `src/components/rower3d/sceneryPlacement.ts`'s `SCENERY_BUDGET`. */
export type PerformanceMode = 'basic' | 'low' | 'medium' | 'high' | 'extra-high';
const SCENERY_BUDGET: Record<PerformanceMode, number> = {
  basic: 0.4, low: 0.5, medium: 0.7, high: 0.85, 'extra-high': 1,
};
export const budgetFor = (mode: PerformanceMode): number => SCENERY_BUDGET[mode] ?? SCENERY_BUDGET.medium;

/**
 * #725 VP-07 FR1 — one placement station every `S` metres of route, by tier.
 * Before this a route had a fixed ~15 stations at medium whatever its
 * length (one every ~450 m on the demo, every 1.3 km on a 20 km course).
 */
export const STATION_SPACING_METRES: Record<PerformanceMode, number> = {
  basic: 60, low: 45, medium: 35, high: 28, 'extra-high': 22,
};
/** Fewest stations on any route at medium; scaled by spacing on other tiers. */
export const MIN_STATIONS_AT_MEDIUM = 6;
export const stationSpacingFor = (mode: PerformanceMode): number =>
  STATION_SPACING_METRES[mode] ?? STATION_SPACING_METRES.medium;

/**
 * #725 FR1 — the rarer categories come at a distance cadence, so they keep
 * the same density per km on any route length and at any station spacing.
 */
export const CATEGORY_EVERY_METRES = {
  landform: 1200,
  backdrop: 1800,
} as const;

/**
 * #725 FR1 — per-side instance ceiling, scaled with the route's length so
 * a long route is not thinned below the density of a short one. Five
 * placements per station is above what the densest recipe emits (#725 FR2).
 */
export const instanceCeilingFor = (lengthMetres: number, spacingMetres: number): number =>
  Math.max(MAX_INSTANCES_PER_SIDE, Math.ceil((Math.max(0, lengthMetres) / Math.max(1, spacingMetres)) * 5));
/**
 * #623 D2-a (Phase 1) — the kit-tree flora pass is now wired on every
 * tier that draws trees (basic/low included). The old procedural
 * `floraSolidPool` is retired; per-species density on basic/low falls
 * out of `budgetFor` (0.4 / 0.5 of medium) and shadow casting stays
 * gated by `tierCaps.castSceneryShadows` so basic/low kit trees still
 * don't cast.
 */
export const keepsKitTrees = (_mode: PerformanceMode): boolean => true;

export const distinctProfiles = (
  enrichment?: RouteEnrichmentData | null,
  track?: SceneryTrack | null,
): SceneryProfile[] => {
  if (track) return trackProfiles(track);
  const set = new Set<SceneryProfile>();
  for (const s of enrichment?.segmentProfiles ?? []) set.add(s.sceneryProfile);
  if (set.size === 0) set.add('fallback');
  return Array.from(set);
};

export interface PlacementInput {
  curve?: RouteCurve | null;
  enrichment?: RouteEnrichmentData | null;
  resolvedByProfile: Map<SceneryProfile, ResolvedScenery>;
  budget: number;
  side: 'left' | 'right';
  track?: SceneryTrack | null;
  kitTrees?: boolean;
  /** #723 FR3 — footprint radius lookup from the manifest. When null, a
   *  per-tier fallback keeps the keep-clear maths safe. */
  footprintLookup?: FootprintLookup | null;
  /** #725 FR1 — metres between stations along the curve
   *  ({@link stationSpacingFor}). Defaults to medium's. */
  stationSpacingMetres?: number;
}

/**
 * Compute the |offset| range along a side's perpendicular where a model
 * of radius `radius` (scene m) may be placed without breaking FR1 (the
 * racing-line keep-clear corridor), FR2 (surface/in-water items hug the
 * bank) or FR3 (bank footings sit wholly on land). Returns `null` when
 * the river is too narrow for the category at this progress.
 */
export const placementOffsetRange = (
  cat: Category,
  halfWidth: number,
  radius: number,
  bandOuter: number,
): { inner: number; outer: number } | null => {
  const corridor = keepClearHalfWidth();
  if (cat === 'surface' || cat === 'inWater') {
    // FR2 — place within WATER_PROP_BANK_INSET_METRES of the bank.
    const outerBank = halfWidth - radius - WATER_PROP_WATERLINE_MARGIN_METRES;
    const innerBank = Math.max(
      halfWidth - WATER_PROP_BANK_INSET_METRES - radius,
      corridor + radius + WATER_PROP_WATERLINE_MARGIN_METRES,
    );
    if (innerBank > outerBank) return null;
    return { inner: innerBank, outer: outerBank };
  }
  // Bank footings (bankEdge, furniture, scatter, trees, buildings, landform, backdrop).
  // FR3: nearest edge of the footprint must lie `BANK_FOOTING_MARGIN_METRES`
  // past the waterline. FR1: it must also be clear of the racing corridor
  // — the bank case is always the stricter test on a non-degenerate river.
  const inner = Math.max(
    halfWidth + BANK_FOOTING_MARGIN_METRES + radius,
    corridor + radius,
  );
  const outer = Math.max(inner + MIN_BAND_STEP_METRES, bandOuter);
  return { inner, outer };
};

export const computePlacements = (input: PlacementInput): Placement[] => {
  const {
    curve, enrichment, resolvedByProfile, budget, side, track = null,
    kitTrees = true, footprintLookup = BUILT_IN_FOOTPRINT_LOOKUP,
  } = input;
  const out: Placement[] = [];
  let ceiling = MAX_INSTANCES_PER_SIDE;
  const firstResolved = resolvedByProfile.values().next().value as ResolvedScenery | undefined;
  const fallback = resolvedByProfile.get('fallback') ?? firstResolved;

  const noPlace = (..._args: Parameters<typeof place>) => {};

  const place = (
    cat: Category, sign: number, t: number,
    px: number, pz: number, perpX: number, perpZ: number, py: number,
    baseRot: number, seed: number, resolved: ResolvedScenery,
  ) => {
    const id = pick(resolved[cat] as SceneryModelId[], seed);
    if (!id) return;
    const halfWidth = waterHalfWidthAt(enrichment, t, sideOfOffset(sign));
    const radius = footprintRadiusFor(id, footprintLookup);
    const bandOuter = bandsClearOf(halfWidth)[cat][1];
    const range = placementOffsetRange(cat, halfWidth, radius, bandOuter);
    // FR2: drop the item when the river is too narrow for a corridor-safe
    // bank-side placement. For bank footings this is near-impossible
    // (the band already pushes outward on a narrow river), so it only
    // ever drops a surface/in-water item at a pinch point.
    if (!range) return;
    const offset = sign * (range.inner + seededRandom(seed + 1) * (range.outer - range.inner));
    const x = px + perpX * offset;
    const z = pz + perpZ * offset;
    const y = cat === 'surface' ? 0.15 : py;
    const faceWater = sign < 0 ? Math.PI / 2 : -Math.PI / 2;
    const rotationY = CATEGORY_FACE[cat]
      ? baseRot + faceWater + (seededRandom(seed + 2) - 0.5) * 0.4
      : seededRandom(seed + 2) * Math.PI * 2;
    const scale = ASSET_SCALE * (0.8 + seededRandom(seed + 3) * 0.5);
    out.push({ id, position: [x, y, z], rotationY, scale, progress: t, footing: footingOf(cat) });
  };

  if (curve) {
    const terrain = buildTerrainProfile(enrichment?.elevations);
    const wantSign = side === 'left' ? -1 : 1;
    const spacing = input.stationSpacingMetres ?? STATION_SPACING_METRES.medium;
    const lengthMetres = curve.lengthMeters;
    // #725 FR1 — stations by distance, not by count.
    // A short route still gets a handful of stations, more on denser tiers.
    const minSteps = Math.ceil((MIN_STATIONS_AT_MEDIUM * STATION_SPACING_METRES.medium) / spacing);
    const stepCount = Math.max(minSteps, Math.round(lengthMetres / spacing));
    const stepMetres = lengthMetres / stepCount;
    const every = (metres: number): number => Math.max(1, Math.round(metres / Math.max(1, stepMetres)));
    const landformEvery = every(CATEGORY_EVERY_METRES.landform);
    const backdropEvery = every(CATEGORY_EVERY_METRES.backdrop);
    // #725 FR2 — the profile's recipe sets how much of each category a
    // stretch of bank gets; a running count per side carries the fraction
    // from one station to the next, so the rate holds at any spacing.
    const density = STATION_SPACING_METRES.medium / spacing;
    const owed = new Map<string, number>();
    const due = (sign: number, cat: Category, per100m: number): number => {
      const key = `${sign}${cat}`;
      const total = (owed.get(key) ?? 0) + (per100m * density * stepMetres) / 100;
      const n = Math.floor(total);
      owed.set(key, total - n);
      return n;
    };
    const dueEvery = (sign: number, cat: Category, everyMetres: number): number =>
      Number.isFinite(everyMetres) ? due(sign, cat, 100 / everyMetres / density) : 0;
    ceiling = instanceCeilingFor(lengthMetres, spacing);
    const sample = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };
    let seed = 100;
    for (let i = 0; i <= stepCount; i++) {
      const t = i / stepCount;
      curve.sample(Math.min(0.999, t), sample);
      // Left-hand perpendicular (tangent × up) = (−tz, 0, tx).
      const perpX = -sample.tangent[2];
      const perpZ = sample.tangent[0];
      const perpLen = Math.hypot(perpX, perpZ) || 1;
      const px = perpX / perpLen;
      const pz = perpZ / perpLen;
      const tx = sample.tangent[0];
      const tz = sample.tangent[2];
      const y = getTerrainReliefForProgress(terrain, t);
      const baseRot = Math.atan2(sample.tangent[0], sample.tangent[2]);
      for (const sign of [-1, 1]) {
        const profile = getSegmentSceneryProfile(enrichment, t, track, sideOfOffset(sign));
        const resolved = resolvedByProfile.get(profile) ?? fallback;
        if (!resolved) continue;
        const recipe = placementRecipeFor(profile);
        const put = sign === wantSign ? place : noPlace;
        const putTree = kitTrees ? put : noPlace;
        // Several of one category at a station spread along the bank
        // rather than stacking on the station's line.
        const putN = (cat: Category, n: number, fn: typeof place) => {
          for (let k = 0; k < n; k++) {
            seed += 5;
            const along = (seededRandom(seed + 4) - 0.5) * stepMetres;
            fn(cat, sign, t, sample.position[0] + tx * along, sample.position[2] + tz * along, px, pz, y, baseRot, seed, resolved);
          }
        };
        putN('trees', due(sign, 'trees', recipe.treesPer100m), putTree);
        putN('scatter', due(sign, 'scatter', recipe.scatterPer100m), put);
        putN('bankEdge', due(sign, 'bankEdge', recipe.bankEdgePer100m), put);
        putN('surface', due(sign, 'surface', recipe.surfacePer100m), put);
        putN('furniture', dueEvery(sign, 'furniture', recipe.furnitureEveryMetres), put);
        putN('buildings', dueEvery(sign, 'buildings', recipe.buildingsEveryMetres), put);
        if (i % landformEvery === 0 && sign < 0) { seed += 5; put('landform', sign, t, sample.position[0], sample.position[2], px, pz, y, baseRot, seed, resolved); }
        if (i % backdropEvery === 0 && sign > 0) { seed += 5; put('backdrop', sign, t, sample.position[0], sample.position[2], px, pz, y, baseRot, seed, resolved); }
      }
    }
  } else if (fallback) {
    const sign = side === 'left' ? -1 : 1;
    let seed = side === 'left' ? 1000 : 5000;
    const bands: Array<[Category, number]> = [
      ['surface', 4], ['bankEdge', 7], ['furniture', 5],
      ['scatter', 9], ['trees', 7], ['landform', 3], ['backdrop', 2],
    ];
    for (const [cat, baseCount] of bands) {
      const count = Math.max(1, Math.round(baseCount * budget));
      const step = 760 / count;
      for (let i = 0; i < count; i++) {
        seed += 5;
        const z = -380 + i * step + (seededRandom(seed) - 0.5) * step * 0.6;
        place(cat, sign, (z + 400) / 800, 0, z, 1, 0, 0, 0, seed, fallback);
      }
    }
  }
  return thinToCeiling(out, ceiling);
};
