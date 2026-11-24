// #725 VP-07 FR1 — placement stations are spaced by distance, not count,
// so a long route is as densely dressed per kilometre as a short one.
import { describe, expect, it } from 'vitest';
import {
  computePlacements,
  instanceCeilingFor,
  RING_IDS,
  STATION_SPACING_METRES,
  stationSpacingFor,
  type PerformanceMode,
} from '../sceneryPlacement';
import { resolveSceneryModels } from '../../../components/rower3d/sceneryAssets';
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

const straight = (km: number): RouteCurve => {
  const pts = [];
  const n = Math.max(2, Math.round(km * 100));
  for (let i = 0; i <= n; i++) pts.push(vec3(0, 0, -(km * 1000 * i) / n));
  return new RouteCurve(pts);
};

const resolvedByProfile = new Map([['fallback' as const, resolveSceneryModels('fallback', 'river', [], null)]]);

const countFor = (km: number, mode: PerformanceMode): number => {
  const curve = straight(km);
  let n = 0;
  for (const side of ['left', 'right'] as const) {
    n += computePlacements({
      curve, enrichment, resolvedByProfile, budget: 0.7, side,
      stationSpacingMetres: stationSpacingFor(mode),
      // The far ring (#725 FR4) carries on past both ends: a fixed share per route, not per km.
    }).filter((p) => !RING_IDS.has(p.id)).length;
  }
  return n;
};

describe('station spacing (#725 FR1)', () => {
  it('is 60 / 45 / 35 / 28 / 22 m from basic to extra-high', () => {
    expect(STATION_SPACING_METRES).toEqual({ basic: 60, low: 45, medium: 35, high: 28, 'extra-high': 22 });
    expect(stationSpacingFor('medium')).toBe(35);
  });

  it('density per km of bank at medium stays within 10% of the 5 km figure at 2, 10 and 20 km', () => {
    const perKm5 = countFor(5, 'medium') / 5;
    expect(perKm5).toBeGreaterThan(40);
    for (const km of [2, 10, 20]) {
      const perKm = countFor(km, 'medium') / km;
      expect(Math.abs(perKm - perKm5) / perKm5, `${km} km: ${perKm.toFixed(1)}/km vs ${perKm5.toFixed(1)}/km`).toBeLessThanOrEqual(0.1);
    }
  });

  it('denser tiers place more per km', () => {
    const counts = (['basic', 'low', 'medium', 'high', 'extra-high'] as const).map((m) => countFor(5, m));
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]);
  });

  it('the per-route instance ceiling scales with length', () => {
    expect(instanceCeilingFor(40_000, 22)).toBeGreaterThan(instanceCeilingFor(10_000, 22) * 3.5);
    expect(instanceCeilingFor(5_000, 35)).toBeGreaterThanOrEqual(900);
    expect(instanceCeilingFor(1_000, 35)).toBeGreaterThanOrEqual(1);
  });
});
