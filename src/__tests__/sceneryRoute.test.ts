import { describe, it, expect } from 'vitest';
import type { WaterRoute } from '../lib/types/index';
import { toEngineRoute, toEngineRouteCached, turnBuoysInScene } from '../lib/ui/sceneryRoute';
import { COASTAL_SEA_HALF_WIDTH_METERS } from '../lib/scenery/waterType';

/**
 * #570 AC2 — the shell route → engine SceneryRoute adapter. The engine only
 * acts on a route that is a `SceneryRoute` (has a `pools` array); the adapter
 * gives it that plus the curve + real length so the boat follows the route.
 */
const makeRoute = (over: Partial<WaterRoute> = {}): WaterRoute =>
  ({
    id: 'r1',
    name: 'Test',
    description: '',
    distance: 2, // km
    difficulty: 'easy',
    location: '',
    coordinates: [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.001 },
    ],
    elevationGain: 0,
    estimatedTime: 10,
    tags: [],
    createdAt: new Date(),
    ...over,
  }) as WaterRoute;

describe('toEngineRoute (#570 AC2)', () => {
  it('returns null when no route is selected', () => {
    expect(toEngineRoute(null)).toBeNull();
    expect(toEngineRoute(undefined)).toBeNull();
  });

  it('always carries a pools array so isSceneryRoute holds', () => {
    const route = toEngineRoute(makeRoute());
    expect(Array.isArray(route?.pools)).toBe(true);
    // The adapter populates foliage pools when the curve is well-formed; the
    // engine mounts an empty scenery pass for an empty `pools`, which is the
    // path taken when the curve is too short — tested below.
    for (const pool of route?.pools ?? []) {
      expect(pool.kind).toBe('foliage');
      expect(pool.positions.length % 3).toBe(0);
      expect(pool.metadata?.length).toBe(pool.positions.length / 3);
    }
  });

  it('leaves pools empty when the route has too few coordinates to form a curve', () => {
    const route = toEngineRoute(makeRoute({ coordinates: [{ lat: 1, lng: 1 }] }));
    expect(route?.pools).toHaveLength(0);
  });

  it('scales GLB scenery with the device tier (kit trees on every tier, denser higher)', () => {
    // #623 Phase 1 — `keepsKitTrees` is now `true` on every tier so basic/low
    // also draw tier-E GLB trees (replacing the retired procedural
    // `floraSolidPool`). Density still rises with the mode because `budgetFor`
    // scales the placement count. The invariant we assert is
    // "high >= medium >= low" so the test keeps working as the catalogue grows.
    const base = makeRoute();
    const low = toEngineRoute(base, undefined, 'low');
    const medium = toEngineRoute(base, undefined, 'medium');
    const high = toEngineRoute(base, undefined, 'high');
    const count = (r: ReturnType<typeof toEngineRoute>) =>
      (r?.sceneryGlbs ?? []).reduce((n, g) => n + g.instances.length, 0);
    expect(count(high)).toBeGreaterThanOrEqual(count(medium));
    expect(count(medium)).toBeGreaterThanOrEqual(count(low));
    expect(count(high)).toBeGreaterThan(count(low));
    // Even on `basic`/`low` the kit-tree species now contribute at least one
    // instance where the route carries any trees at all.
    expect(count(low)).toBeGreaterThan(0);
    // Foliage pools (sprite tree layout) come from `foliagePlan`
    // which is deterministic regardless of tier, so pool counts match.
    expect((high?.pools ?? []).length).toBe((low?.pools ?? []).length);
  });

  it('places more foliage on a longer route (deterministic density scales with length)', () => {
    const short = toEngineRoute(makeRoute({
      coordinates: [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.001 },
      ],
      distance: 0.1, // 100 m
    }));
    const long = toEngineRoute(makeRoute({
      coordinates: [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.01 },
      ],
      distance: 1, // 1 km
    }));
    const shortCount = (short?.pools ?? []).reduce((n, p) => n + p.positions.length / 3, 0);
    const longCount = (long?.pools ?? []).reduce((n, p) => n + p.positions.length / 3, 0);
    expect(longCount).toBeGreaterThan(shortCount);
  });

  it('derives curvePoints from the route geometry', () => {
    const route = toEngineRoute(makeRoute());
    expect(route?.curvePoints?.length).toBeGreaterThanOrEqual(2);
    const first = route?.curvePoints?.[0] ?? [NaN, NaN, NaN];
    expect(first[0]).toBeCloseTo(0, 6);
    expect(first[1]).toBe(0);
    expect(first[2]).toBeCloseTo(0, 6);
  });

  it('sets totalDistanceMeters to distance × 1000 (matches finish detection)', () => {
    const route = toEngineRoute(makeRoute({ distance: 2 }));
    expect(route?.totalDistanceMeters).toBe(2000);
  });

  it('omits totalDistanceMeters for a zero-length route (engine uses chord length)', () => {
    const route = toEngineRoute(makeRoute({ distance: 0 }));
    expect(route?.totalDistanceMeters).toBeUndefined();
    expect(Array.isArray(route?.pools)).toBe(true);
  });

  it('omits curvePoints but still mounts for a route with too few points', () => {
    const route = toEngineRoute(makeRoute({ coordinates: [{ lat: 1, lng: 1 }] }));
    expect(route?.curvePoints).toBeUndefined();
    expect(route?.pools).toHaveLength(0);
    expect(route?.totalDistanceMeters).toBe(2000);
  });

  it('treats a route with no coordinates as an empty curve, still mounting', () => {
    const route = toEngineRoute(makeRoute({ coordinates: undefined as never }));
    expect(route?.curvePoints).toBeUndefined();
    expect(Array.isArray(route?.pools)).toBe(true);
    expect(route?.totalDistanceMeters).toBe(2000);
  });

  it('marks a lap route as closed when the endpoints are within 5 m', () => {
    const lap = makeRoute({
      coordinates: [
        { lat: 0, lng: 0 },
        { lat: 0.001, lng: 0 },
        { lat: 0.001, lng: 0.001 },
        { lat: 0.000001, lng: 0.000001 }, // ~15 cm from the start
      ],
    });
    expect(toEngineRoute(lap)?.isClosedLoop).toBe(true);
    const open = makeRoute({
      coordinates: [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.001 },
        { lat: 0.001, lng: 0.001 },
        { lat: 0.001, lng: 0.002 },
      ],
    });
    // Open routes carry no isClosedLoop at all so the engine's default (false) applies.
    expect(toEngineRoute(open)?.isClosedLoop).toBeUndefined();
    // Too-short routes can't be loops regardless of endpoint proximity.
    expect(toEngineRoute(makeRoute())?.isClosedLoop).toBeUndefined();
  });

  it('always publishes waterEdgesForProgress, with a sensible fallback when there is no enrichment', () => {
    const route = toEngineRoute(makeRoute());
    const edges = route?.waterEdgesForProgress?.(0.5);
    // Fallback width is 20 m / 2 on each side, floored at MIN_NAVIGABLE_WIDTH_METERS / 2.
    expect(edges?.left).toBeGreaterThan(0);
    expect(edges?.left).toBeCloseTo(edges?.right ?? 0);
  });

  it('uses enrichment-derived shore widths when enrichment is supplied', () => {
    const enriched = toEngineRoute(makeRoute(), {
      source: 'overpass',
      enrichedAt: 0,
      segmentProfiles: [
        {
          waterBodyType: 'river',
          waterWidthMeters: 40,
          leftShoreMeters: 5,
          rightShoreMeters: 35,
          waterBodyName: null,
          dragModifier: 1,
          elevationMeters: 0,
          windModifier: 1,
          onMappedWater: true,
          mappedWaterType: 'river',
          mappedWaterSource: 'overpass',
          sceneryProfile: 'fallback',
        },
        {
          waterBodyType: 'river',
          waterWidthMeters: 40,
          leftShoreMeters: 5,
          rightShoreMeters: 35,
          waterBodyName: null,
          dragModifier: 1,
          elevationMeters: 0,
          windModifier: 1,
          onMappedWater: true,
          mappedWaterType: 'river',
          mappedWaterSource: 'overpass',
          sceneryProfile: 'fallback',
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const mid = enriched?.waterEdgesForProgress?.(0.5);
    expect(mid?.left).toBeCloseTo(5);
    expect(mid?.right).toBeCloseTo(35);
  });
});

// #729 FR3 — the route layout is cached per (route, enrichment, tier), so a
// row page that remounts or re-derives with the same inputs does not lay the
// whole course out again on the main thread.
describe('toEngineRouteCached (#729 FR3)', () => {
  it('returns the same layout for the same route, enrichment and tier', () => {
    const route = makeRoute({ id: 'cache-a' });
    const first = toEngineRouteCached(route, null, 'medium');
    expect(first).not.toBeNull();
    expect(toEngineRouteCached(route, null, 'medium')).toBe(first);
    // A copy of the same route (the store re-creating its object) hits too.
    expect(toEngineRouteCached({ ...route }, null, 'medium')).toBe(first);
  });

  it('lays out again when the tier or the enrichment changes', () => {
    const route = makeRoute({ id: 'cache-b' });
    const medium = toEngineRouteCached(route, null, 'medium');
    expect(toEngineRouteCached(route, null, 'basic')).not.toBe(medium);
    const enrichment = { source: 'overpass', enrichedAt: 0, segmentProfiles: [] } as never;
    const enriched = toEngineRouteCached(route, enrichment, 'medium');
    expect(enriched).not.toBe(medium);
    expect(toEngineRouteCached(route, enrichment, 'medium')).toBe(enriched);
  });

  it('passes no route through as null', () => {
    expect(toEngineRouteCached(null, null, 'medium')).toBeNull();
  });
});

describe('toEngineRoute bank profiles (#725 FR5)', () => {
  it('hands the bank pass each bank\'s authored profile along Willowbrook', () => {
    const route = toEngineRoute(makeRoute({ id: '1' }));
    expect(route?.profileForProgress?.(0.1, 'left')).toBe('forest');
    expect(route?.profileForProgress?.(0.3, 'right')).toBe('farmland');
    expect(route?.profileForProgress?.(0.9, 'left')).toBe('wetland');
  });

  it('falls back with no track and no enrichment', () => {
    expect(toEngineRoute(makeRoute())?.profileForProgress?.(0.5, 'left')).toBe('fallback');
  });
});

describe('toEngineRoute land relief (#745 FR1)', () => {
  it('hands the bank the relief from the enrichment\'s elevations, and nothing on flat water', () => {
    const base = makeRoute();
    const enrichment = {
      waterWidthMeters: 40, segmentProfiles: [], elevations: [0, 100], buildings: null, crossings: null, waterBodyType: 'river',
    } as unknown as Parameters<typeof toEngineRoute>[1];
    const route = toEngineRoute(base, enrichment);
    expect(route?.reliefForProgress?.(0)).toBe(0);
    expect(route?.reliefForProgress?.(1)).toBeCloseTo(2);
    expect(toEngineRoute(base)?.reliefForProgress).toBeUndefined();
  });
});

describe('turn buoys (#753 FR1)', () => {
  it('carries each stake turn into scene XZ against the route origin', () => {
    const route = toEngineRoute(
      makeRoute({
        coordinates: [{ lat: 0, lng: 0 }, { lat: 0.01, lng: 0 }, { lat: 0, lng: 0.0003 }],
        stakeTurns: [{ lat: 0.01, lng: 0 }],
      }),
    );
    expect(route?.turnBuoys).toHaveLength(1);
    const [buoy] = route!.turnBuoys!;
    // ~1.11 km north is -z in scene space; no east offset.
    expect(buoy.x).toBeCloseTo(0, 3);
    expect(buoy.z).toBeLessThan(-1000);
    expect(turnBuoysInScene([{ lat: 0.01, lng: 0 }], { lat: 0, lng: 0 })).toEqual([buoy]);
  });

  it('leaves turnBuoys off a route with no stakes', () => {
    expect(toEngineRoute(makeRoute())?.turnBuoys).toBeUndefined();
  });
});

describe('the map landscape in the engine route (#764)', () => {
  const landscape = (source: 'network' | 'unavailable') =>
    ({
      origin: { lat: 0, lng: 0 },
      key: 'k',
      elevation: { source: 'unavailable', ms: 0, count: 0, data: null },
      landCover: {
        source,
        ms: 0,
        count: 1,
        data:
          source === 'network'
            ? [
                {
                  kind: 'wood',
                  shape: 'polygon',
                  points: [[-50, -300], [150, -300], [150, -500], [-50, -500], [-50, -300]],
                },
              ]
            : null,
      },
      built: { source: 'unavailable', ms: 0, count: 0, data: null },
    }) as never;

  it('carries the land-cover mask, its summary, and treelines on the wood that faces the course', () => {
    const route = toEngineRoute(makeRoute(), null, 'medium', landscape('network'))!;
    expect(route.landCover).toBeDefined();
    expect(route.landCoverSummary).toMatchObject({ woodlandPolygons: 1, treelineInstances: 2 });
    const strips = route.sceneryGlbs!.filter((g) => g.id === 'f45-treeline-strip').flatMap((g) => g.instances);
    expect(strips.filter((s) => Math.abs(s.position[2] + 303) < 1)).toHaveLength(2);
  });

  it('is unchanged without land-cover data (FR9)', () => {
    const route = toEngineRoute(makeRoute(), null, 'medium', landscape('unavailable'))!;
    expect(route.landCover).toBeUndefined();
    expect(route.landCoverSummary).toBeUndefined();
    const plain = toEngineRoute(makeRoute(), null, 'medium')!;
    expect(Object.keys(route).sort()).toEqual(Object.keys(plain).sort());
    expect(route.sceneryGlbs).toEqual(plain.sceneryGlbs);
  });

  it('takes the land side of a sea course from the coastline, even with map enrichment (FR6)', () => {
    // The course heads east; walking west along z = -200 the land is south,
    // so the sea is north of the course, on its left bank.
    const coastal = {
      ...(landscape('network') as object),
      landCover: {
        source: 'network',
        ms: 0,
        count: 1,
        data: [{ kind: 'coastline', shape: 'line', points: [[2000, -200], [-2000, -200]] }],
      },
    } as never;
    const enrichment = { routeId: 'r1', waterWidthMeters: 40, segmentProfiles: [] } as never;
    const route = toEngineRoute(makeRoute(), enrichment, 'medium', coastal)!;
    expect(route.landSide).toBe('right');
    expect(route.waterEdgesForProgress!(0.5).left).toBe(COASTAL_SEA_HALF_WIDTH_METERS);
    expect(toEngineRoute(makeRoute(), enrichment, 'medium', landscape('network'))!.landSide).toBeUndefined();
  });

  it('lays out again when the landscape arrives', () => {
    const r = makeRoute({ id: 'cache-landscape' });
    const before = toEngineRouteCached(r, null, 'medium');
    const land = landscape('network');
    const after = toEngineRouteCached(r, null, 'medium', land);
    expect(after).not.toBe(before);
    expect(toEngineRouteCached(r, null, 'medium', land)).toBe(after);
  });
});

describe('hills from the real terrain in the engine route (#763)', () => {
  // makeRoute runs ~111 m east along z = 0. A 120 m ridge runs east-west 800 m north of it.
  const cols = 121;
  const heights = new Float32Array(cols * cols);
  for (let r = 0; r < cols; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const z = 3000 - r * 50;
      heights[r * cols + c] = 120 * Math.exp(-(((z + 800) / 150) ** 2));
    }
  }
  const withElevation = (source: 'network' | 'unavailable') =>
    ({
      origin: { lat: 0, lng: 0 },
      key: 'k',
      elevation: {
        source,
        ms: 0,
        count: cols * cols,
        data:
          source === 'network'
            ? { originX: -3000, originZ: 3000, stepX: 50, stepZ: -50, spacingM: 50, cols, rows: cols, heights, complete: true }
            : null,
      },
      landCover: { source: 'unavailable', ms: 0, count: 0, data: null },
      built: { source: 'unavailable', ms: 0, count: 0, data: null },
    }) as never;

  it('stands kit landforms on the ridge and reports them (FR2, FR9)', () => {
    const route = toEngineRoute(makeRoute(), null, 'medium', withElevation('network'))!;
    expect(route.reliefSummary!.placed).toBeGreaterThan(0);
    expect(route.reliefSummary!.maxElevationDeg).toBeGreaterThan(5);
    const plain = toEngineRoute(makeRoute(), null, 'medium')!;
    const count = (r: typeof route) => (r.sceneryGlbs ?? []).reduce((n, g) => n + g.instances.length, 0);
    expect(count(route) - count(plain)).toBe(route.reliefSummary!.placed);
    const onRidge = (route.sceneryGlbs ?? [])
      .flatMap((g) => g.instances)
      .filter((i) => Math.abs(i.position[2] + 800) < 100);
    expect(onRidge.length).toBeGreaterThan(0);
  });

  it('is unchanged without elevation data (FR8)', () => {
    const route = toEngineRoute(makeRoute(), null, 'medium', withElevation('unavailable'))!;
    expect(route.reliefSummary).toBeUndefined();
    expect(route.sceneryGlbs).toEqual(toEngineRoute(makeRoute(), null, 'medium')!.sceneryGlbs);
  });
});

describe('the map built form in the engine route (#765)', () => {
  const sq = (cx: number, cz: number, half: number): [number, number][] => [
    [cx - half, cz - half],
    [cx + half, cz - half],
    [cx + half, cz + half],
    [cx - half, cz + half],
    [cx - half, cz - half],
  ];
  const withBuilt = (source: 'network' | 'unavailable') =>
    ({
      origin: { lat: 0, lng: 0 },
      key: 'k',
      elevation: { source: 'unavailable', ms: 0, count: 0, data: null },
      landCover: { source: 'unavailable', ms: 0, count: 0, data: null },
      built: {
        source,
        ms: 0,
        count: 4,
        data:
          source === 'network'
            ? {
                footprints: [{ kind: 'house', points: sq(50, -100, 6) }],
                places: [{ kind: 'town', x: 0, z: -1500 }],
                landmarks: [{ kind: 'church', heightM: 40, x: 300, z: 400 }],
              }
            : null,
      },
    }) as never;

  it('draws the real footprints, a town skyline and a landmark, and reports them (FR1, FR3, FR4, FR10)', () => {
    const route = toEngineRoute(makeRoute(), null, 'medium', withBuilt('network'))!;
    expect(route.buildings!.some((b) => b.x === 50 && b.z === -100)).toBe(true);
    const ids = (route.sceneryGlbs ?? []).map((g) => g.id);
    expect(ids).toContain('f47-skyline-strip');
    expect(ids).toContain('d-gb-02-church-square-tower');
    expect(route.builtSummary).toEqual({ near: 1, mid: 0, skylineInstances: 3, landmarks: 1, source: 'network' });
  });

  it('is unchanged without built-form data (FR9)', () => {
    const route = toEngineRoute(makeRoute(), null, 'medium', withBuilt('unavailable'))!;
    const plain = toEngineRoute(makeRoute(), null, 'medium')!;
    expect(route.builtSummary).toBeUndefined();
    expect(route.buildings).toEqual(plain.buildings);
    expect(route.sceneryGlbs).toEqual(plain.sceneryGlbs);
  });
});
