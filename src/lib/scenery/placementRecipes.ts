/**
 * #725 VP-07 FR2 — per-profile placement recipes. Each scenery profile
 * (from `SCENERY_PROFILES`) says how many kit trees, understory scatter,
 * bank-edge pieces and water props it plants per 100 m of bank, and how
 * often furniture and buildings come, so the authored biome bands
 * (forest / farmland / scrub / village / wetland) read as different
 * places within a couple of hundred metres of entering each.
 *
 * Rates are at medium; other tiers scale them by station density
 * ({@link tierDensityFactor}).
 */
import { SCENERY_PROFILES } from '../../components/rower3d/sceneryConfig';
import type { SceneryProfile } from '../services/routeEnrichmentService';

export interface PlacementRecipe {
  /** Kit trees per 100 m of one bank. */
  treesPer100m: number;
  /** Understory scatter (bushes, rocks, flowers) per 100 m of one bank. */
  scatterPer100m: number;
  /** Bank-edge pieces (reeds, revetment, steps) per 100 m of one bank. */
  bankEdgePer100m: number;
  /** Water-surface props (lily rafts, weed, moorings) per 100 m of one bank. */
  surfacePer100m: number;
  /** Metres of bank between pieces of furniture (benches, posts, signs). */
  furnitureEveryMetres: number;
  /** Metres of bank between kit buildings; Infinity for none. */
  buildingsEveryMetres: number;
}

/** Kit trees per 100 m at a profile's tree density of 0 and of 1. */
export const TREES_PER_100M_RANGE: readonly [number, number] = [0.3, 2.4];
/** A built-up profile (building probability at or above this) gets a busier waterfront. */
const BUILT_UP_PROBABILITY = 0.3;

const recipeOf = (profile: SceneryProfile): PlacementRecipe => {
  const config = SCENERY_PROFILES[profile] ?? SCENERY_PROFILES.fallback;
  const [tMin, tMax] = TREES_PER_100M_RANGE;
  const reedy = config.groundCover.types.includes('reed');
  const built = config.buildings.probability >= BUILT_UP_PROBABILITY;
  return {
    treesPer100m: tMin + (tMax - tMin) * config.trees.density,
    scatterPer100m: 0.3 + 1.0 * config.groundCover.density,
    // A reed bank is a fringe; a mown or walled bank only has the odd piece.
    bankEdgePer100m: reedy ? 0.2 + 0.8 * config.groundCover.density : 0.35,
    surfacePer100m: reedy ? 0.9 : built ? 0.7 : 0.4,
    furnitureEveryMetres: built ? 400 : 700,
    buildingsEveryMetres:
      config.buildings.probability > 0 ? Math.min(3000, Math.max(250, 150 / config.buildings.probability)) : Infinity,
  };
};

const cache = new Map<SceneryProfile, PlacementRecipe>();

export const placementRecipeFor = (profile: SceneryProfile): PlacementRecipe => {
  let recipe = cache.get(profile);
  if (!recipe) {
    recipe = recipeOf(profile);
    cache.set(profile, recipe);
  }
  return recipe;
};
