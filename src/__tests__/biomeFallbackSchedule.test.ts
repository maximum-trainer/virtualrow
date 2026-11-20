/**
 * #712 FR3 — tests the per-segment profile selection used by
 * `createFallbackRouteEnrichment` when Overpass is unreachable.
 *
 * Priority:
 *   1. `route.sceneryOverrides` entry that intersects the segment mid-point.
 *   2. Tag-ordered schedule: biome tags in `route.tags` split the route into
 *      equal distance bands, in tag order.
 *   3. Today's `inferFallbackSceneryProfile(route)` — single-tag fallback.
 *
 * Steps 1 and 2 only run when `__VIRTUALROW_RICH_BIOMES === true` so phase 1
 * ships off-by-default.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFallbackRouteEnrichment, fallbackProfileForSegment } from '../lib/services/routeEnrichmentService';
import type { WaterRoute } from '../lib/types/index';

const RICH_BIOMES_KEY = '__VIRTUALROW_RICH_BIOMES';

const buildRoute = (overrides?: Partial<WaterRoute>): WaterRoute => ({
  id: 'test-route',
  name: 'Test',
  description: '',
  // Six roughly-equidistant coordinates along a ~7 km line so distance
  // calculations have something to walk.
  coordinates: [
    { lat: 47.5786, lng: 11.3268 },
    { lat: 47.5900, lng: 11.3270 },
    { lat: 47.6000, lng: 11.3290 },
    { lat: 47.6100, lng: 11.3310 },
    { lat: 47.6200, lng: 11.3325 },
    { lat: 47.6220, lng: 11.3330 },
  ],
  distance: 7,
  difficulty: 'easy',
  location: 'nowhere',
  elevationGain: 0,
  estimatedTime: 0,
  tags: [],
  createdAt: new Date(0),
  ...overrides,
});

describe('#712 FR3 — fallback biome schedule', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const original = g[RICH_BIOMES_KEY];
  beforeEach(() => { delete g[RICH_BIOMES_KEY]; });
  afterEach(() => {
    if (original === undefined) delete g[RICH_BIOMES_KEY];
    else g[RICH_BIOMES_KEY] = original;
  });

  it('with the flag off, every segment reads the single-tag fallback', () => {
    const route = buildRoute({ tags: ['river', 'forest'] });
    const enrichment = createFallbackRouteEnrichment(route);
    expect(enrichment.segmentProfiles.length).toBeGreaterThan(1);
    for (const seg of enrichment.segmentProfiles) {
      expect(seg.sceneryProfile).toBe('forest');
    }
  });

  it('with the flag off, sceneryOverrides are ignored (strict superset)', () => {
    const route = buildRoute({
      tags: ['river', 'forest'],
      sceneryOverrides: [{ fromMeters: 0, toMeters: 100_000, profile: 'small-city' }],
    });
    const enrichment = createFallbackRouteEnrichment(route);
    for (const seg of enrichment.segmentProfiles) {
      expect(seg.sceneryProfile).toBe('forest');
    }
  });

  it('with the flag on, sceneryOverrides win per segment', () => {
    g[RICH_BIOMES_KEY] = true;
    const route = buildRoute({
      tags: ['river'],
      sceneryOverrides: [
        { fromMeters: 0, toMeters: 1500, profile: 'woodland' },
        { fromMeters: 1500, toMeters: 3000, profile: 'parkland' },
        { fromMeters: 3000, toMeters: 4500, profile: 'village' },
        { fromMeters: 4500, toMeters: 100_000, profile: 'beach' },
      ],
    });
    const seenProfiles = new Set<string>();
    for (const seg of createFallbackRouteEnrichment(route).segmentProfiles) {
      const mid = (seg.startMeters + seg.endMeters) / 2;
      const expected =
        mid < 1500 ? 'woodland' : mid < 3000 ? 'parkland' : mid < 4500 ? 'village' : 'beach';
      expect(seg.sceneryProfile).toBe(expected);
      seenProfiles.add(seg.sceneryProfile);
    }
    expect(seenProfiles.size).toBeGreaterThanOrEqual(3);
  });

  it('with the flag on, biome tags split the route in order', () => {
    g[RICH_BIOMES_KEY] = true;
    const route = buildRoute({ tags: ['river', 'forest', 'meadow', 'village', 'lake'] });
    // The tag-ordered schedule is `forest`, `farmland` (meadow), `village`.
    // `river` and `lake` are water-body tags, not biome tags, and are ignored.
    const enrichment = createFallbackRouteEnrichment(route);
    const total = enrichment.segmentProfiles[enrichment.segmentProfiles.length - 1].endMeters;
    const seen = new Set<string>();
    for (const seg of enrichment.segmentProfiles) {
      const mid = (seg.startMeters + seg.endMeters) / 2;
      const band = Math.min(2, Math.floor((mid / total) * 3));
      const expected = ['forest', 'farmland', 'village'][band];
      expect(seg.sceneryProfile).toBe(expected);
      seen.add(seg.sceneryProfile);
    }
    expect(seen).toEqual(new Set(['forest', 'farmland', 'village']));
  });

  it('with the flag on, override gaps fall through to the tag-ordered schedule', () => {
    g[RICH_BIOMES_KEY] = true;
    const route = buildRoute({
      tags: ['river', 'forest', 'village'],
      sceneryOverrides: [{ fromMeters: 0, toMeters: 1500, profile: 'parkland' }],
    });
    const total = 7000;
    const first = fallbackProfileForSegment(route, 0, 500, total);
    const afterOverride = fallbackProfileForSegment(route, 2000, 2500, total);
    expect(first).toBe('parkland');
    // 2000..2500 mid 2250 is past the override end; at total ~7km and two
    // biomes (forest, village) it lands in the first band → 'forest'.
    expect(afterOverride).toBe('forest');
  });

  it('with the flag on and no overrides or biome tags, keeps today single-tag fallback', () => {
    g[RICH_BIOMES_KEY] = true;
    const route = buildRoute({ tags: ['river', 'scenic'] });
    const enrichment = createFallbackRouteEnrichment(route);
    for (const seg of enrichment.segmentProfiles) {
      expect(seg.sceneryProfile).toBe('fallback');
    }
  });
});
