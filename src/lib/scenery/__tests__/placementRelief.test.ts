// #745 VP-25 FR1 — kit props stand on the bank as it climbs with the land.
import { describe, expect, it } from 'vitest';
import { computePlacements, stationSpacingFor } from '../sceneryPlacement';
import { waterHalfWidthAt } from '../waterHalfWidth';
import { resolveSceneryModels } from '../../../components/rower3d/sceneryAssets';
import { SCENERY_PROFILES } from '../../../components/rower3d/sceneryConfig';
import { RouteCurve } from '../../renderer/math/curve';
import { vec3 } from '../../renderer/math/vec3';
import { bankReliefAt } from '../../renderer/plan/bankRelief';
import { buildTerrainProfile, getTerrainReliefForProgress } from '../../services/routeEnrichmentService';
import type { RouteEnrichmentData } from '../../services/routeEnrichmentService';

const elevations = Array.from({ length: 51 }, (_, i) => i * 4); // 200 m climb: 4 m of relief
const enrichment = {
  waterWidthMeters: 45,
  segmentProfiles: [],
  elevations,
  buildings: null,
  crossings: null,
  waterBodyType: 'river',
} as unknown as RouteEnrichmentData;
const curve = new RouteCurve(Array.from({ length: 101 }, (_, i) => vec3(0, 0, -i * 30)));
const resolvedByProfile = new Map([
  ['fallback' as const, resolveSceneryModels('fallback', 'river', SCENERY_PROFILES.fallback.trees.species, null)],
]);

describe('props on a climbing bank (#745 FR1)', () => {
  it('stand at the bank height where they are, lower near the water than up the bank', () => {
    const terrain = buildTerrainProfile(elevations);
    const placements = (['left', 'right'] as const).flatMap((side) =>
      computePlacements({ curve, enrichment, resolvedByProfile, budget: 0.7, side, stationSpacingMetres: stationSpacingFor('medium') }),
    );
    const onBank = placements.filter((p) => p.footing === 'bank' && p.position[1] > 0.2);
    expect(onBank.length).toBeGreaterThan(20);
    for (const p of onBank) {
      const halfWidth = waterHalfWidthAt(enrichment, p.progress, p.position[0] < 0 ? 'left' : 'right');
      const expected = bankReliefAt(getTerrainReliefForProgress(terrain, p.progress), Math.abs(p.position[0]) - halfWidth);
      expect(p.position[1], p.id).toBeCloseTo(expected, 3);
    }
  });
});
