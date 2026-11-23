// #755 VP-31 — the water type and width come from the route itself, with no map data.
import { describe, expect, it } from 'vitest';
import lap115 from './fixtures/rownative/115.json';
import { resolveCourseGeometry, type RownativeCourseGeometryInput } from '../lib/services/rownativeGeometry';
import {
  LAKE_OPEN_WATER_HALF_WIDTH_METERS,
  resolveWaterType,
  waterWidthForType,
} from '../lib/scenery/waterType';
import { toEngineRoute } from '../lib/ui/sceneryRoute';
import { nearestOnPolyline, onWaterByDesign } from '../lib/renderer/engine/sceneryClearance';
import { routeTotalDistanceMeters } from '../lib/utils/geoUtils';
import { willowbrookRiverCoordinates } from '../data/seedRouteCoordinates';
import { WILLOWBROOK_ROUTE_ID } from '../components/rower3d/sceneryTrack';
import { createFallbackRouteEnrichment } from '../lib/services/routeEnrichmentService';
import type { Coordinate, WaterRoute } from '../lib/types';

const waterRoute = (id: string, name: string, coordinates: Coordinate[], tags: string[] = []): WaterRoute => ({
  id,
  name,
  description: '',
  distance: routeTotalDistanceMeters(coordinates) / 1000,
  difficulty: 'easy',
  location: '',
  coordinates,
  elevationGain: 0,
  estimatedTime: 0,
  tags,
  createdAt: new Date('2026-01-01'),
});

/** A straight 2 km course heading north. */
const straight = (): Coordinate[] => {
  const pts: Coordinate[] = [];
  for (let n = 0; n <= 2000; n += 50) pts.push({ lat: 52.95 + n / 111_320, lng: 5.92 });
  return pts;
};

const halfWidthsAlong = (route: ReturnType<typeof toEngineRoute>): number[] => {
  const out: number[] = [];
  for (let i = 0; i <= 20; i += 1) {
    const e = route!.waterEdgesForProgress!(i / 20);
    out.push(e.left, e.right);
  }
  return out;
};

describe('resolveWaterType (#755 FR1)', () => {
  it('takes the enrichment when it knows, then the tag, then the name', () => {
    expect(resolveWaterType({ name: 'Lake Street Sprint' }, { waterBodyType: 'river' })).toEqual({
      waterType: 'river',
      typeSource: 'enrichment',
    });
    expect(resolveWaterType({ name: 'Lake Street Sprint', tags: ['canal'] }, { waterBodyType: 'unknown' })).toEqual({
      waterType: 'canal',
      typeSource: 'tag',
    });
    expect(resolveWaterType({ name: '9K Heerenveens Kanaal' })).toEqual({ waterType: 'canal', typeSource: 'name' });
    expect(resolveWaterType({ name: 'Sunday 5K' })).toEqual({ waterType: 'unknown', typeSource: 'default' });
  });

  it('is the one the fallback enrichment uses', () => {
    const r = waterRoute('r', 'Griggs Reservoir', straight());
    expect(createFallbackRouteEnrichment(r).waterBodyType).toBe('reservoir');
  });
});

describe('widths by type without map data (#755 FR2/FR3)', () => {
  it('a canal is narrower than a river: half-width 7.5 m', () => {
    const route = toEngineRoute(waterRoute('c', '9K Heerenveens Kanaal', straight()), null);
    expect(route!.waterDetectionSummary).toMatchObject({ waterType: 'canal', typeSource: 'name' });
    for (const w of halfWidthsAlong(route)) expect(w).toBe(7.5);
    expect(waterWidthForType('river')).toBe(55);
  });

  it('enrichment still wins', () => {
    const r = waterRoute('s', 'Lake Street Sprint', straight());
    const enrichment = { ...createFallbackRouteEnrichment(r), waterBodyType: 'river' as const, source: 'network' as const };
    expect(toEngineRoute(r, enrichment)!.waterDetectionSummary).toMatchObject({
      waterType: 'river',
      typeSource: 'enrichment',
    });
  });

  it('an unknown course keeps the 20 m channel', () => {
    const route = toEngineRoute(waterRoute('u', 'Sunday 5K', straight()), null);
    expect(route!.waterDetectionSummary).toMatchObject({ waterType: 'unknown', typeSource: 'default' });
    for (const w of halfWidthsAlong(route)) expect(w).toBe(10);
  });

  it('the Willowbrook demo keeps its authored channel', () => {
    const route = toEngineRoute(
      waterRoute(WILLOWBROOK_ROUTE_ID, 'Willowbrook River', willowbrookRiverCoordinates, ['river', 'lake']),
      null,
    );
    for (const w of halfWidthsAlong(route)) expect(w).toBe(10);
  });
});

describe('a lake course looks like a lake before any map data arrives (#755 FR3/FR5)', () => {
  it('Lake Quinsigamond lap: 300 m of water each side, nothing on the bank inside it', async () => {
    const input = lap115 as unknown as RownativeCourseGeometryInput;
    const resolved = await resolveCourseGeometry(input);
    const route = toEngineRoute(waterRoute('rownative-115', input.name ?? '', resolved.coordinates), null, 'high')!;
    expect(route.waterDetectionSummary).toMatchObject({ waterType: 'lake', typeSource: 'name' });
    for (const w of halfWidthsAlong(route)) expect(w).toBeGreaterThanOrEqual(LAKE_OPEN_WATER_HALF_WIDTH_METERS);

    const line = route.curvePoints!;
    const tooClose: string[] = [];
    const check = (what: string, x: number, z: number) => {
      const d = nearestOnPolyline(line, x, z).distance;
      if (d < LAKE_OPEN_WATER_HALF_WIDTH_METERS) tooClose.push(`${what} ${d.toFixed(0)} m`);
    };
    for (const pool of route.pools) {
      for (let i = 0; i < pool.positions.length; i += 3) check(`${pool.kind}:${pool.speciesIndex}`, pool.positions[i], pool.positions[i + 2]);
    }
    for (const b of route.buildings ?? []) check('building', b.x, b.z);
    let furniture = 0;
    for (const g of route.sceneryGlbs ?? []) {
      if (onWaterByDesign(g.id)) {
        furniture += g.instances.length;
        continue;
      }
      for (const inst of g.instances) check(g.id, inst.position[0], inst.position[2]);
    }
    expect(tooClose.slice(0, 20), `${tooClose.length} placements inside the lake`).toEqual([]);
    // FR5 — course furniture stays on the course line: the lane buoys the
    // course lays out every 250 m are still within a few metres of it.
    expect(furniture).toBeGreaterThan(0);
    const laneBuoys = (route.sceneryGlbs ?? [])
      .filter((g) => g.id === 'a01-buoy-lane-sphere')
      .flatMap((g) => g.instances)
      .filter((inst) => nearestOnPolyline(line, inst.position[0], inst.position[2]).distance < 10);
    expect(laneBuoys.length).toBeGreaterThanOrEqual(2 * Math.floor(routeTotalDistanceMeters(resolved.coordinates) / 250));
  });
});
