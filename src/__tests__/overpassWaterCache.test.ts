import { describe, it, expect } from 'vitest';

import {
  OverpassWaterCache,
  boxContains,
  buildWaterQueryForBox,
  type WaterBox,
} from '../lib/services/overpassWaterCache';
import { OsmWaterwayPathProvider } from '../lib/services/osmWaterwayPathProvider';
import { RouteEnrichmentService } from '../lib/services/routeEnrichmentService';
import { runDetectionInline } from '../lib/services/routeDetectionRunner';
import type { Coordinate, WaterRoute } from '../lib/types/index';

const box = (minLat: number, minLng: number, maxLat: number, maxLng: number): WaterBox => ({
  minLat,
  minLng,
  maxLat,
  maxLng,
});

describe('OverpassWaterCache (#752 FR3)', () => {
  it('answers for any box inside one it holds, and nothing outside it', () => {
    const cache = new OverpassWaterCache();
    cache.store(box(51, -1, 52, 0), [{ id: 1 }]);

    expect(cache.covering(box(51.2, -0.8, 51.8, -0.2))).toEqual([{ id: 1 }]);
    expect(cache.covering(box(50.9, -0.8, 51.8, -0.2))).toBeNull();
    expect(boxContains(box(51, -1, 52, 0), box(51, -1, 52, 0))).toBe(true);
  });

  it('keeps only the most recent areas', () => {
    const cache = new OverpassWaterCache(2);
    cache.store(box(0, 0, 1, 1), [{ id: 1 }]);
    cache.store(box(10, 10, 11, 11), [{ id: 2 }]);
    cache.store(box(20, 20, 21, 21), [{ id: 3 }]);

    expect(cache.covering(box(0, 0, 1, 1))).toBeNull();
    expect(cache.covering(box(20, 20, 21, 21))).toEqual([{ id: 3 }]);
  });

  it('builds one water query that holds what both services read', () => {
    const query = buildWaterQueryForBox(box(51, -1, 52, 0), 25);
    expect(query).toContain('[timeout:25]');
    expect(query).toContain('way["waterway"](51,-1,52,0);');
    expect(query).toContain('relation["natural"~"^(water|bay|strait|coastline|bare_rock|shoal)$"](51,-1,52,0);');
  });
});

// Two gates 1.2 km apart on the Thames at Henley, nothing mapped.
const GATES: Coordinate[] = [
  { lat: 51.5363, lng: -0.9008 },
  { lat: 51.5471, lng: -0.9005 },
];

const ROUTE = {
  id: 'rownative-752',
  name: 'Two Gates',
  coordinates: GATES,
  description: '',
  distance: 1.2,
  difficulty: 'easy',
  location: 'Henley',
  elevationGain: 0,
  estimatedTime: 6,
  tags: ['river'],
} as unknown as WaterRoute;

/** Counts the Overpass water queries; answers everything else empty. */
function countingFetch() {
  const calls = { water: 0, scenery: 0 };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('interpreter')) {
      const query = decodeURIComponent(String(init?.body ?? ''));
      if (query.includes('"place"~"^(island|islet)$"')) calls.water += 1;
      else calls.scenery += 1;
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ elevation: GATES.map(() => 10) }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('one water query for one area (#752 FR3)', () => {
  it('a course imported and then enriched asks Overpass for water once', async () => {
    const { calls, fetchImpl } = countingFetch();
    const waterCache = new OverpassWaterCache();
    const provider = new OsmWaterwayPathProvider(fetchImpl, { waterCache, retryDelayMs: 0 });
    const enrichment = new RouteEnrichmentService(fetchImpl, null, runDetectionInline, waterCache);

    await provider.findPath(GATES);
    await enrichment.enrichRoute(ROUTE);

    expect(calls.water).toBe(1);
    expect(calls.scenery).toBe(1);
  });

  it('and the reverse: an enriched course re-traced asks once', async () => {
    const { calls, fetchImpl } = countingFetch();
    const waterCache = new OverpassWaterCache();
    const provider = new OsmWaterwayPathProvider(fetchImpl, { waterCache, retryDelayMs: 0 });
    const enrichment = new RouteEnrichmentService(fetchImpl, null, runDetectionInline, waterCache);

    await enrichment.enrichRoute(ROUTE);
    await provider.findPath(GATES);

    expect(calls.water).toBe(1);
  });

  it('services built without a shared cache still ask for themselves', async () => {
    const { calls, fetchImpl } = countingFetch();
    await new OsmWaterwayPathProvider(fetchImpl, { retryDelayMs: 0 }).findPath(GATES);
    await new RouteEnrichmentService(fetchImpl, null, runDetectionInline).enrichRoute(ROUTE);

    expect(calls.water).toBe(2);
  });
});
