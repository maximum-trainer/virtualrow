import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_FOOTPRINT_REACH_M,
  LandscapeService,
  buildBuiltFormQuery,
  buildLandCoverQuery,
  builtFormFromElements,
  landCoverFromElements,
  landCoverKindOf,
  landmarkKindOf,
  landscapeKey,
  waterSamplesFor,
} from '../lib/services/landscapeService';
import { LandscapeCache, memoryLandscapeStore } from '../lib/services/landscapeCache';
import { distanceToCourse, routeFrame } from '../lib/services/landscapeArea';
import type { OverpassElement } from '../lib/services/routeEnrichmentService';

// A 2 km east-west course on a reservoir 280 m above sea level.
const COURSE = Array.from({ length: 21 }, (_, i) => ({ lat: 51.5, lng: -0.1 + (0.0288 * i) / 20 }));
const FRAME = routeFrame(COURSE)!;
const METRES_PER_DEG_LAT = (6378137 * Math.PI) / 180;
/** The land rises 2 m per 100 m away from the water. */
const terrain = (lat: number, lng: number) => {
  const y = (lat - 51.5) * METRES_PER_DEG_LAT;
  const x = (lng + 0.1) * METRES_PER_DEG_LAT * Math.cos((51.5 * Math.PI) / 180);
  return 280 + 0.02 * distanceToCourse(FRAME, x, y);
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  }) as unknown as Response;

const WOOD: OverpassElement = {
  type: 'way',
  id: 1,
  tags: { natural: 'wood' },
  geometry: [
    { lat: 51.505, lon: -0.09 },
    { lat: 51.505, lon: -0.085 },
    { lat: 51.508, lon: -0.085 },
    { lat: 51.505, lon: -0.09 },
  ],
};
const CHURCH: OverpassElement = {
  type: 'way',
  id: 2,
  tags: { building: 'church', name: 'St Mary' },
  geometry: [
    { lat: 51.51, lon: -0.08 },
    { lat: 51.51, lon: -0.0798 },
    { lat: 51.5102, lon: -0.0798 },
    { lat: 51.51, lon: -0.08 },
  ],
};

interface Calls {
  elevation: string[];
  overpass: string[];
}

const fakeFetch = (
  calls: Calls,
  opts: { elevation?: (call: number) => Response | null; overpass?: (body: string) => Response | null } = {},
) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('open-meteo')) {
      calls.elevation.push(url);
      const override = opts.elevation?.(calls.elevation.length);
      if (override) return override;
      const q = new URL(url).searchParams;
      const lats = q.get('latitude')!.split(',').map(Number);
      const lngs = q.get('longitude')!.split(',').map(Number);
      return json({ elevation: lats.map((lat, i) => terrain(lat, lngs[i])) });
    }
    const body = decodeURIComponent(String(init?.body ?? ''));
    calls.overpass.push(body);
    const override = opts.overpass?.(body);
    if (override) return override;
    if (body.includes('barrier')) return json({ elements: [WOOD] });
    return json({ elements: [CHURCH] });
  }) as unknown as typeof fetch;

/** A clock that only moves when the service sleeps. */
const clock = () => {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
  };
};

const service = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof LandscapeService>[0]> = {}) => {
  const c = clock();
  return {
    clock: c,
    service: new LandscapeService({ fetchImpl, cache: null, sleep: c.sleep, now: c.now, publish: false, ...extra }),
  };
};

afterEach(() => {
  delete (window as unknown as { __ROWER3D_LANDSCAPE?: unknown }).__ROWER3D_LANDSCAPE;
});

describe('LandscapeService.load (FR1, FR3, FR6)', () => {
  it('loads all three layers from the network, with heights relative to the water', async () => {
    const calls: Calls = { elevation: [], overpass: [] };
    const { service: s } = service(fakeFetch(calls));
    const landscape = await s.load(COURSE);

    expect(landscape.origin).toEqual(COURSE[0]);
    expect(landscape.elevation.source).toBe('network');
    expect(landscape.landCover.source).toBe('network');
    expect(landscape.built.source).toBe('network');
    expect(landscape.landCover.count).toBe(1);
    expect(landscape.built.data!.landmarks).toEqual([
      expect.objectContaining({ kind: 'church', name: 'St Mary' }),
    ]);

    const grid = landscape.elevation.data!;
    expect(grid.complete).toBe(true);
    // 20 km² of buffer at 90 m is over 2,000 points: one rung coarser.
    expect(grid.spacingM).toBeCloseTo(127.28, 2);
    expect(landscape.elevation.count).toBe(grid.heights.filter((h) => Number.isFinite(h)).length);
    let checkedNear = 0;
    let checkedFar = 0;
    for (let row = 0; row < grid.rows; row += 1) {
      for (let col = 0; col < grid.cols; col += 1) {
        const h = grid.heights[row * grid.cols + col];
        if (!Number.isFinite(h)) continue;
        const x = grid.originX + col * grid.stepX;
        const z = grid.originZ + row * grid.stepZ;
        const d = distanceToCourse(FRAME, x, -z);
        if (d <= 30) {
          // AC: heights within 30 m of a reservoir at 280 m sit at the water.
          expect(h).toBeGreaterThanOrEqual(-2);
          expect(h).toBeLessThanOrEqual(2);
          checkedNear += 1;
        } else {
          expect(h).toBeCloseTo(0.02 * d, 0);
          checkedFar += 1;
        }
      }
    }
    expect(checkedNear).toBeGreaterThan(0);
    expect(checkedFar).toBeGreaterThan(100);
    // FR3b: sequential, a second between calls.
    expect(calls.elevation.length).toBeGreaterThan(1);
  });

  it('keeps the other layers when the elevation source is down (AC: one source down)', async () => {
    const calls: Calls = { elevation: [], overpass: [] };
    const { service: s } = service(fakeFetch(calls, { elevation: () => json({}, 503) }));
    const landscape = await s.load(COURSE);
    expect(landscape.elevation.source).toBe('unavailable');
    expect(landscape.landCover.source).toBe('network');
    expect(landscape.built.source).toBe('network');
    expect(calls.elevation).toHaveLength(3);
  });

  it('retries a 429 after its Retry-After, then succeeds', async () => {
    const calls: Calls = { elevation: [], overpass: [] };
    const { service: s, clock: c } = service(
      fakeFetch(calls, { elevation: (n) => (n === 1 ? json({}, 429, { 'Retry-After': '2' }) : null) }),
    );
    const landscape = await s.load(COURSE);
    expect(landscape.elevation.source).toBe('network');
    expect(c.sleeps[0]).toBe(2000);
  });

  it('fails over to the next Overpass endpoint on a 504, and gives up on a 400', async () => {
    const calls: Calls = { elevation: [], overpass: [] };
    const urls: string[] = [];
    const base = fakeFetch(calls);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('open-meteo')) {
        urls.push(url);
        if (url.includes('first')) return json({}, 504);
        if (String(init?.body).includes('place')) return json({}, 400);
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    const { service: s } = service(fetchImpl, { overpassUrls: ['https://first/api', 'https://second/api'] });
    const landscape = await s.load(COURSE);
    expect(landscape.landCover.source).toBe('network');
    expect(landscape.built.source).toBe('unavailable');
    expect(urls.filter((u) => u.includes('second'))).toHaveLength(2);
  });

  it('treats a dropped connection as retryable and resolves when every try fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const { service: s } = service(fetchImpl);
    const landscape = await s.load(COURSE);
    expect(landscape.elevation.source).toBe('unavailable');
    expect(landscape.landCover.source).toBe('unavailable');
    expect(landscape.built.source).toBe('unavailable');
  });

  it('stops a layer at its budget and cuts off a request that never answers', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
      const s = new LandscapeService({ fetchImpl, cache: null, publish: false, layerBudgetMs: 500 });
      const pending = s.load(COURSE);
      await vi.advanceTimersByTimeAsync(600);
      const landscape = await pending;
      expect(landscape.landCover.source).toBe('unavailable');
      expect(landscape.elevation.source).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves with every layer unavailable for a route without two points', async () => {
    const calls: Calls = { elevation: [], overpass: [] };
    const { service: s } = service(fakeFetch(calls), { publish: true });
    for (const coords of [[], [COURSE[0]]]) {
      const landscape = await s.load(coords);
      expect(landscape.elevation.source).toBe('unavailable');
      expect(landscape.built.source).toBe('unavailable');
    }
    expect(calls.elevation).toHaveLength(0);
    expect(calls.overpass).toHaveLength(0);
    expect((window as unknown as { __ROWER3D_LANDSCAPE?: unknown }).__ROWER3D_LANDSCAPE).toEqual({
      elevation: { source: 'unavailable', ms: 0, count: 0 },
      landCover: { source: 'unavailable', ms: 0, count: 0 },
      built: { source: 'unavailable', ms: 0, count: 0 },
    });
  });

  it('publishes __ROWER3D_LANDSCAPE as each layer lands (FR9)', async () => {
    const calls: Calls = { elevation: [], overpass: [] };
    const { service: s } = service(fakeFetch(calls), { publish: true });
    const landscape = await s.load(COURSE);
    const published = (window as unknown as { __ROWER3D_LANDSCAPE: Record<string, { source: string; count: number }> })
      .__ROWER3D_LANDSCAPE;
    expect(published.elevation).toMatchObject({ source: 'network', count: landscape.elevation.count });
    expect(published.landCover).toMatchObject({ source: 'network', count: 1 });
    expect(published.built).toMatchObject({ source: 'network', count: 1 });
  });
});

describe('the landscape cache in use (FR7, FR3d)', () => {
  it('answers a second row on the same route from the cache, with no request', async () => {
    const calls: Calls = { elevation: [], overpass: [] };
    const cache = new LandscapeCache(memoryLandscapeStore());
    const { service: s } = service(fakeFetch(calls), { cache });
    const first = await s.load(COURSE);
    const before = calls.elevation.length + calls.overpass.length;

    const second = await s.load(COURSE);
    expect(calls.elevation.length + calls.overpass.length).toBe(before);
    expect(second.elevation.source).toBe('cache');
    expect(second.landCover.source).toBe('cache');
    expect(second.built.source).toBe('cache');
    expect(Array.from(second.elevation.data!.heights)).toEqual(Array.from(first.elevation.data!.heights));
  });

  it('keeps a partly fetched grid and resumes it, asking only for the missing points', async () => {
    const calls: Calls = { elevation: [], overpass: [] };
    const cache = new LandscapeCache(memoryLandscapeStore());
    // Budget for three calls a second apart.
    const { service: s } = service(fakeFetch(calls), { cache, layerBudgetMs: 2500 });
    const first = await s.load(COURSE);
    expect(first.elevation.source).toBe('network');
    expect(first.elevation.data!.complete).toBe(false);
    const asked = calls.elevation.length;
    expect(asked).toBe(3);

    const { service: again } = service(fakeFetch(calls), { cache });
    const second = await again.load(COURSE);
    expect(second.elevation.data!.complete).toBe(true);
    const total = calls.elevation.length;
    const fresh = new LandscapeService({
      fetchImpl: fakeFetch({ elevation: [], overpass: [] }),
      cache: null,
      sleep: async () => undefined,
      publish: false,
    });
    const whole = await fresh.load(COURSE);
    expect(second.elevation.count).toBe(whole.elevation.count);
    expect(total - asked).toBeLessThan(Math.ceil(whole.elevation.count / 100) + 2);
    // Land cover and built form came from the cache the second time.
    expect(second.landCover.source).toBe('cache');
  });

  it('carries on without the cache when reading or writing it throws', async () => {
    const calls: Calls = { elevation: [], overpass: [] };
    const broken = {
      get: async () => {
        throw new Error('quota');
      },
      put: async () => {
        throw new Error('quota');
      },
    } as unknown as LandscapeCache;
    const { service: s } = service(fakeFetch(calls), { cache: broken });
    const landscape = await s.load(COURSE);
    expect(landscape.landCover.source).toBe('network');
  });
});

describe('land cover (FR4)', () => {
  it('classifies the tags it keeps and ignores the rest', () => {
    expect(landCoverKindOf({ natural: 'wood' })).toBe('wood');
    expect(landCoverKindOf({ landuse: 'forest' })).toBe('forest');
    expect(landCoverKindOf({ landuse: 'vineyard' })).toBe('vineyard');
    expect(landCoverKindOf({ barrier: 'hedge' })).toBe('hedge');
    expect(landCoverKindOf({ natural: 'water' })).toBeNull();
    expect(landCoverKindOf({ landuse: 'railway' })).toBeNull();
    expect(landCoverKindOf(undefined)).toBeNull();
  });

  it('asks once for every kind, 2 km around the course', () => {
    const q = buildLandCoverQuery(COURSE);
    expect(q).toContain('around:2000,');
    for (const word of ['wood', 'tree_row', 'coastline', 'forest', 'farmland', 'retail', 'hedge']) expect(q).toContain(word);
  });

  it('returns polygons and lines in scene XZ, simplified to 20 m, with relations joined', () => {
    const straightRow = Array.from({ length: 50 }, (_, i) => ({ lat: 51.502, lon: -0.1 + 0.0001 * i }));
    const elements: OverpassElement[] = [
      WOOD,
      { type: 'way', tags: { natural: 'tree_row' }, geometry: straightRow },
      { type: 'way', tags: { barrier: 'hedge' }, geometry: straightRow.slice(0, 1) },
      // An unclosed area way has no inside.
      { type: 'way', tags: { landuse: 'meadow' }, geometry: straightRow.slice(0, 5) },
      { type: 'way', tags: { natural: 'water' }, geometry: WOOD.geometry },
      {
        type: 'relation',
        tags: { landuse: 'forest' },
        members: [
          {
            type: 'way',
            ref: 1,
            role: 'outer',
            geometry: [
              { lat: 51.49, lon: -0.1 },
              { lat: 51.49, lon: -0.09 },
              { lat: 51.48, lon: -0.09 },
            ],
          },
          {
            type: 'way',
            ref: 2,
            role: 'outer',
            geometry: [
              { lat: 51.48, lon: -0.09 },
              { lat: 51.48, lon: -0.1 },
              { lat: 51.49, lon: -0.1 },
            ],
          },
          { type: 'way', ref: 3, role: 'inner', geometry: [] },
        ],
      },
    ];
    const features = landCoverFromElements(elements, COURSE[0]);
    expect(features.map((f) => `${f.kind}:${f.shape}`)).toEqual(['wood:polygon', 'tree_row:line', 'forest:polygon']);
    const row = features[1];
    expect(row.points).toHaveLength(2);
    expect(row.points[0][1]).toBeCloseTo(-222.6, 0);
    const forest = features[2];
    expect(forest.points[0]).toEqual(forest.points[forest.points.length - 1]);
    expect(forest.points.length).toBeGreaterThanOrEqual(4);
  });

  it('carries a wood\'s leaf type, and only the known ones (#764 FR5)', () => {
    const features = landCoverFromElements(
      [
        { ...WOOD, tags: { natural: 'wood', leaf_type: 'needleleaved' } },
        { ...WOOD, tags: { natural: 'wood', leaf_type: 'leafless' } },
        { ...WOOD, tags: { natural: 'wood' } },
      ],
      COURSE[0],
    );
    expect(features.map((f) => f.leafType)).toEqual(['needleleaved', undefined, undefined]);
    expect('leafType' in features[2]).toBe(false);
  });
});

describe('built form (FR5)', () => {
  it('names landmarks by their tags', () => {
    expect(landmarkKindOf({ man_made: 'lighthouse' })).toBe('lighthouse');
    expect(landmarkKindOf({ building: 'cathedral' })).toBe('cathedral');
    expect(landmarkKindOf({ power: 'tower' })).toBe('power_tower');
    expect(landmarkKindOf({ 'generator:source': 'wind' })).toBe('wind_turbine');
    expect(landmarkKindOf({ building: 'office', height: '45' })).toBe('tall');
    expect(landmarkKindOf({ building: 'house', height: '20' })).toBeNull();
    expect(landmarkKindOf({ man_made: 'pier' })).toBeNull();
    expect(landmarkKindOf(undefined)).toBeNull();
  });

  it('asks for footprints within 600 m and only places and landmarks beyond', () => {
    const q = buildBuiltFormQuery(COURSE);
    expect(q).toContain(`way["building"](around:${BUILT_FOOTPRINT_REACH_M},`);
    expect(q).toContain('node["place"~"^(city|town|village|hamlet)$"](around:2000,');
    expect(q).toContain('(if: number(t["height"]) > 30)');
  });

  it('keeps no footprint further than 600 m from the course (AC: city payload is bounded)', () => {
    const square = (lat: number, lon: number, tags: Record<string, string>, id: number): OverpassElement => ({
      type: 'way',
      id,
      tags,
      geometry: [
        { lat, lon },
        { lat, lon: lon + 0.0002 },
        { lat: lat + 0.0002, lon: lon + 0.0002 },
        { lat, lon },
      ],
    });
    const elements: OverpassElement[] = [
      square(51.503, -0.09, { building: 'house', 'building:levels': '3' }, 10),
      square(51.52, -0.09, { building: 'house' }, 11),
      { type: 'node', id: 12, lat: 51.51, lon: -0.08, tags: { place: 'town', name: 'Weir', population: '12,000' } },
      { type: 'node', id: 13, lat: 51.51, lon: -0.08, tags: { place: 'suburb' } },
      { type: 'node', id: 14, lat: 51.515, lon: -0.07, tags: { man_made: 'mast', height: '80' } },
      { type: 'relation', id: 15, tags: { man_made: 'tower' }, bounds: { minlat: 51.51, minlon: -0.1, maxlat: 51.512, maxlon: -0.098 } },
      { type: 'relation', id: 16, tags: { man_made: 'tower' } },
      { type: 'node', id: 14, lat: 51.515, lon: -0.07, tags: { man_made: 'mast', height: '80' } },
    ];
    const built = builtFormFromElements(elements, FRAME);
    expect(built.footprints).toHaveLength(1);
    expect(built.footprints[0]).toMatchObject({ kind: 'house', heightM: 9 });
    for (const f of built.footprints) {
      expect(Math.min(...f.points.map(([x, z]) => distanceToCourse(FRAME, x, -z)))).toBeLessThanOrEqual(600);
    }
    expect(built.places).toEqual([expect.objectContaining({ kind: 'town', name: 'Weir', population: 12000 })]);
    expect(built.landmarks.map((l) => l.kind)).toEqual(['mast', 'tower']);
    expect(built.landmarks[0].heightM).toBe(80);
  });
});

describe('keys and water samples', () => {
  it('keys the same course the same way and a different course differently', () => {
    expect(landscapeKey(routeFrame(COURSE))).toBe(landscapeKey(routeFrame([...COURSE])));
    expect(landscapeKey(routeFrame(COURSE.slice(0, 10)))).not.toBe(landscapeKey(routeFrame(COURSE)));
    expect(landscapeKey(null)).toBe('landscape:none');
  });

  it('samples the water every 100 m, at most 200 times', () => {
    expect(waterSamplesFor(FRAME)).toHaveLength(21);
    const long = routeFrame([
      { lat: 51.5, lng: -0.1 },
      { lat: 51.5, lng: 0.4 },
    ])!;
    expect(waterSamplesFor(long).length).toBeLessThanOrEqual(200);
  });
});

describe('the test-mode port (FR10)', () => {
  it('answers under test with every layer unavailable and no request, and publishes that', async () => {
    const { offlineLandscapeService, pickLandscapeService, landscapeService } = await import(
      '../lib/services/landscapeService'
    );
    expect(pickLandscapeService(true)).toBe(offlineLandscapeService);
    expect(pickLandscapeService(false)).toBe(landscapeService);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const landscape = await offlineLandscapeService.load(COURSE);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(landscape.origin).toEqual(COURSE[0]);
    expect(landscape.key).toBe(landscapeKey(FRAME));
    expect([landscape.elevation.source, landscape.landCover.source, landscape.built.source]).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    expect((window as unknown as { __ROWER3D_LANDSCAPE?: { built: { source: string } } }).__ROWER3D_LANDSCAPE?.built.source).toBe(
      'unavailable',
    );
    expect((await offlineLandscapeService.load([])).origin).toBeNull();
  });

  it('serves the dense budget fixture when a spec asks for it, still with no request (#885 FR1)', async () => {
    const { offlineLandscapeService } = await import('../lib/services/landscapeService');
    const flag = window as unknown as {
      __E2E_LANDSCAPE_FIXTURE?: string;
      __ROWER3D_LANDSCAPE?: { landCover: { source: string; count: number } };
    };
    flag.__E2E_LANDSCAPE_FIXTURE = 'dense';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const landscape = await offlineLandscapeService.load(COURSE);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(landscape.key).toBe(landscapeKey(FRAME));
      expect([landscape.elevation.source, landscape.landCover.source, landscape.built.source]).toEqual([
        'cache',
        'cache',
        'cache',
      ]);
      expect(landscape.landCover.data?.length).toBeGreaterThan(0);
      expect(flag.__ROWER3D_LANDSCAPE?.landCover).toEqual({ source: 'cache', ms: 0, count: landscape.landCover.count });
    } finally {
      fetchSpy.mockRestore();
      delete flag.__E2E_LANDSCAPE_FIXTURE;
    }
  });
});
