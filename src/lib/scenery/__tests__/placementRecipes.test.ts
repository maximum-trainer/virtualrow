// #725 VP-07 FR2 — per-profile recipes make the biome bands read as
// different places; FR3 — kit trees near the route, sprite cards beyond.
import { describe, expect, it } from 'vitest';
import { computePlacements, bandsClearOf, stationSpacingFor, type Placement } from '../sceneryPlacement';
import { placementRecipeFor } from '../placementRecipes';
import { layoutFoliage, SPRITE_NEAR_LIMIT_METRES, spriteInnerOffset, FOLIAGE_SHAPES } from '../foliagePlan';
import { resolveSceneryModels } from '../../../components/rower3d/sceneryAssets';
import { SCENERY_PROFILES } from '../../../components/rower3d/sceneryConfig';
import { WILLOWBROOK_SCENERY_TRACK, trackProfiles } from '../../../components/rower3d/sceneryTrack';
import { sceneryDrawDistanceFor, TREE_DRAW_METRES } from '../../renderer/plan/sceneryDrawDistance';
import { RouteCurve } from '../../renderer/math/curve';
import { vec3 } from '../../renderer/math/vec3';
import type { RouteEnrichmentData } from '../../services/routeEnrichmentService';

const enrichment = {
  waterWidthMeters: 45,
  segmentProfiles: [],
  elevations: null,
  buildings: null,
  crossings: null,
  waterBodyType: 'river',
} as unknown as RouteEnrichmentData;

const LENGTH_KM = 5;
const curve = (() => {
  const pts = [];
  for (let i = 0; i <= 500; i++) pts.push(vec3(0, 0, -(LENGTH_KM * 1000 * i) / 500));
  return new RouteCurve(pts);
})();

const track = WILLOWBROOK_SCENERY_TRACK;
const resolvedByProfile = new Map(
  trackProfiles(track).map((p) => [p, resolveSceneryModels(p, 'river', SCENERY_PROFILES[p].trees.species, null)]),
);

const placeBoth = (): Placement[] =>
  (['left', 'right'] as const).flatMap((side) =>
    computePlacements({
      curve, enrichment, resolvedByProfile, budget: 0.7, side, track,
      stationSpacingMetres: stationSpacingFor('medium'),
    }),
  );

const isKitTree = (id: string): boolean => sceneryDrawDistanceFor(id) === TREE_DRAW_METRES;

describe('placement recipes (#725 FR2)', () => {
  it('follow the profile: a forest bank is thicker with trees than meadow, and a village has buildings', () => {
    const forest = placementRecipeFor('forest');
    const farmland = placementRecipeFor('farmland');
    const residential = placementRecipeFor('residential');
    const wetland = placementRecipeFor('wetland');
    expect(forest.treesPer100m).toBeGreaterThan(2 * farmland.treesPer100m);
    expect(wetland.bankEdgePer100m).toBeGreaterThan(residential.bankEdgePer100m);
    expect(residential.buildingsEveryMetres).toBeLessThan(forest.buildingsEveryMetres);
    expect(residential.furnitureEveryMetres).toBeLessThan(farmland.furnitureEveryMetres);
    expect(placementRecipeFor('scrub').buildingsEveryMetres).toBe(Infinity);
  });

  it('the Willowbrook bands differ in kit-tree density by at least 30% from their neighbours', () => {
    const trees = placeBoth().filter((p) => isKitTree(p.id));
    const bands = track.bands.map((band, i) => {
      const from = i === 0 ? 0 : track.bands[i - 1].untilProgress;
      const km = (band.untilProgress - from) * LENGTH_KM;
      // Leave the first and last 100 m of a band out, where stations straddle it.
      const margin = 0.1 / LENGTH_KM;
      const n = trees.filter((p) => p.progress >= from + margin && p.progress < band.untilProgress - margin).length;
      return { profile: band.profile, perKm: n / (km - 0.2) };
    });
    for (let i = 1; i < bands.length; i++) {
      const [a, b] = [bands[i - 1].perKm, bands[i].perKm];
      expect(Math.max(a, b) / Math.min(a, b), `${bands[i - 1].profile} ${a.toFixed(1)}/km vs ${bands[i].profile} ${b.toFixed(1)}/km`).toBeGreaterThanOrEqual(1.3);
    }
  });

  it('within 200 m of entering a band its density has already changed', () => {
    const trees = placeBoth().filter((p) => isKitTree(p.id));
    // Forest (0-20%) into farmland (20-40%): the first 200 m of farmland
    // already sits nearer farmland's rate than forest's.
    const metresAt = (p: Placement) => p.progress * LENGTH_KM * 1000;
    const forestRate = placementRecipeFor('forest').treesPer100m * 2;
    const farmRate = placementRecipeFor('farmland').treesPer100m * 2;
    const first200 = trees.filter((p) => metresAt(p) >= 1000 && metresAt(p) < 1200).length / 2;
    expect(Math.abs(first200 - farmRate)).toBeLessThan(Math.abs(first200 - forestRate));
  });
});

describe('kit trees near, sprite cards far (#725 FR3)', () => {
  it('every kit tree stands within the kit band and every sprite card beyond it', () => {
    const halfWidth = 22.5;
    const kitOuter = bandsClearOf(halfWidth).trees[1];
    expect(kitOuter).toBeLessThanOrEqual(SPRITE_NEAR_LIMIT_METRES + 10);
    for (const p of placeBoth().filter((q) => isKitTree(q.id))) {
      expect(Math.abs(p.position[0]), p.id).toBeLessThanOrEqual(kitOuter + 1);
    }
    const sprites = layoutFoliage({ curve, enrichment, track, speciesTypes: [...FOLIAGE_SHAPES] });
    expect(sprites.length).toBeGreaterThan(0);
    for (const s of sprites) expect(Math.abs(s.position[0])).toBeGreaterThanOrEqual(SPRITE_NEAR_LIMIT_METRES);
  });

  it('a wide river pushes the sprites out behind the kit band', () => {
    expect(spriteInnerOffset(10)).toBe(SPRITE_NEAR_LIMIT_METRES);
    expect(spriteInnerOffset(150)).toBeGreaterThanOrEqual(bandsClearOf(150).trees[1]);
  });
});
