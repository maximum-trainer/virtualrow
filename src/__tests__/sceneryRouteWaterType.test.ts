// #755 VP-31 — the water type and width come from the route itself, with no map data.
import { describe, expect, it } from 'vitest';
import lap115 from './fixtures/rownative/115.json';
import { resolveCourseGeometry, type RownativeCourseGeometryInput } from '../lib/services/rownativeGeometry';
import {
  COASTAL_SEA_HALF_WIDTH_METERS,
  LAKE_OPEN_WATER_HALF_WIDTH_METERS,
  SEA_OPEN_WATER_HALF_WIDTH_METERS,
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
import { GROUND_HAZE_END_M } from '../lib/renderer/plan/groundPlane';
import { buildBankStrips } from '../lib/renderer/plan/bankStrip';
import { RouteCurve } from '../lib/renderer/math/curve';
import { vec3 } from '../lib/renderer/math/vec3';

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

describe('a coastal course has land on one side (#755 FR4)', () => {
  const coast = waterRoute('rownative-177', 'CCRC - Catterline to Stonehaven', straight(), ['open_water', 'coastal']);
  const route = toEngineRoute(coast, null, 'high')!;
  const line = route.curvePoints!;
  /** Signed offset from the course line: negative is the rower's left. */
  const signedOffset = (x: number, z: number): number => {
    let best = Infinity;
    let sign = 0;
    for (let i = 0; i + 1 < line.length; i += 1) {
      const [ax, , az] = line[i];
      const [bx, , bz] = line[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      const px = x - (ax + dx * t);
      const pz = z - (az + dz * t);
      const d = Math.hypot(px, pz);
      if (d < best) {
        best = d;
        // perp = tangent × up = (−tz, 0, tx)
        sign = Math.sign(px * -dz + pz * dx);
      }
    }
    return sign * best;
  };

  it('is open water on the sea side out past the land haze', () => {
    expect(route.landSide).toBe('left');
    expect(COASTAL_SEA_HALF_WIDTH_METERS).toBeGreaterThan(GROUND_HAZE_END_M);
    for (let i = 0; i <= 10; i += 1) {
      const e = route.waterEdgesForProgress!(i / 10);
      expect(e.right).toBe(COASTAL_SEA_HALF_WIDTH_METERS);
      expect(e.left).toBe(SEA_OPEN_WATER_HALF_WIDTH_METERS);
    }
  });

  it('places scenery on the land side only, and draws one bank strip', () => {
    const seaSide: string[] = [];
    let placed = 0;
    const check = (what: string, x: number, z: number) => {
      placed += 1;
      if (signedOffset(x, z) > 0) seaSide.push(what);
    };
    for (const pool of route.pools) {
      for (let i = 0; i < pool.positions.length; i += 3) check(pool.kind, pool.positions[i], pool.positions[i + 2]);
    }
    for (const b of route.buildings ?? []) check('building', b.x, b.z);
    for (const g of route.sceneryGlbs ?? []) {
      if (onWaterByDesign(g.id)) continue;
      for (const inst of g.instances) check(g.id, inst.position[0], inst.position[2]);
    }
    expect(placed).toBeGreaterThan(0);
    expect(seaSide.slice(0, 10), `${seaSide.length} on the sea side`).toEqual([]);

    const curve = new RouteCurve(line.map(([x, y, z]) => vec3(x, y, z)), false);
    const bank = buildBankStrips({ curve, edgesForProgress: route.waterEdgesForProgress, landSide: route.landSide, footprint: null });
    const signs = new Set<number>();
    for (const i of bank.indices) signs.add(bank.sides[i * 2]);
    expect([...signs]).toEqual([-1]);
  });

  it('a sea course without the tag keeps both shores', () => {
    const r = toEngineRoute(waterRoute('sea', 'CCRC - Catterline to Stonehaven', straight(), ['open_water']), null)!;
    expect(r.landSide).toBeUndefined();
  });
});
