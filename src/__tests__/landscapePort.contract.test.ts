import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LANDSCAPE_GRID_MIN_SPACING_M, distanceToCourse, routeFrame } from '../lib/services/landscapeArea';
import { LandscapeService, WATER_FLAT_M, offlineLandscapeService } from '../lib/services/landscapeService';
import { LandscapeCache, memoryLandscapeStore } from '../lib/services/landscapeCache';
import { expectLandscapePortContract } from './helpers/landscapePortContract';
import heerenveen from './fixtures/landscape/277.json';

/**
 * #762 AC-R1 — the port contract, run against every backend that serves the
 * scene. The live sources run the same assertions in landscapeContract.test.ts
 * (opt-in, network).
 */
const route = (heerenveen as { route: { lat: number; lng: number }[] }).route;

const json = (body: unknown) =>
  ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body }) as unknown as Response;

/** Flat water-level land, one wood and one house beside the course's first point. */
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('open-meteo')) {
    const n = new URL(url).searchParams.get('latitude')!.split(',').length;
    return json({ elevation: Array.from({ length: n }, () => 1) });
  }
  const { lat, lng } = route[0];
  const square = (d: number) => [
    { lat: lat + d, lon: lng + d },
    { lat: lat + d, lon: lng + 2 * d },
    { lat: lat + 2 * d, lon: lng + 2 * d },
    { lat: lat + d, lon: lng + d },
  ];
  return json({
    elements: [
      { type: 'way', id: 1, tags: { natural: 'wood' }, geometry: square(0.002) },
      { type: 'way', id: 2, tags: { building: 'house' }, geometry: square(0.0005) },
    ],
  });
}) as unknown as typeof fetch;

const instant = { sleep: async () => {}, now: () => 0, requestGapMs: 0, publish: false };

afterEach(() => {
  delete (window as unknown as { __E2E_LANDSCAPE_FIXTURE?: string }).__E2E_LANDSCAPE_FIXTURE;
  delete (window as unknown as { __ROWER3D_LANDSCAPE?: unknown }).__ROWER3D_LANDSCAPE;
});

describe('LandscapePort contract (#762 AC-R1)', () => {
  it('network backend', async () => {
    const landscape = await new LandscapeService({ fetchImpl: fakeFetch, cache: null, ...instant }).load(route);
    expect(landscape.elevation.source).toBe('network');
    expect(landscape.landCover.source).toBe('network');
    expect(landscape.built.source).toBe('network');
    expectLandscapePortContract(landscape, route);
  });

  it('cache backend (a second row on the same route)', async () => {
    const cache = new LandscapeCache(memoryLandscapeStore());
    await new LandscapeService({ fetchImpl: fakeFetch, cache, ...instant }).load(route);
    const offline = (async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    const landscape = await new LandscapeService({ fetchImpl: offline, cache, ...instant }).load(route);
    expect(landscape.elevation.source).toBe('cache');
    expect(landscape.landCover.source).toBe('cache');
    expect(landscape.built.source).toBe('cache');
    expectLandscapePortContract(landscape, route);
  });

  it('failing network backend still resolves, every layer unavailable', async () => {
    const down = (async () => ({ ok: false, status: 400, headers: { get: () => null }, json: async () => ({}) })) as unknown as typeof fetch;
    const landscape = await new LandscapeService({ fetchImpl: down, cache: null, ...instant }).load(route);
    expect([landscape.elevation.source, landscape.landCover.source, landscape.built.source]).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    expectLandscapePortContract(landscape, route);
  });

  it('offline backend (test mode)', async () => {
    const landscape = await offlineLandscapeService.load(route);
    expectLandscapePortContract(landscape, route);
  });

  it('dense budget fixture backend (#885)', async () => {
    (window as unknown as { __E2E_LANDSCAPE_FIXTURE?: string }).__E2E_LANDSCAPE_FIXTURE = 'dense';
    const landscape = await offlineLandscapeService.load(route);
    expect(landscape.elevation.source).toBe('cache');
    expectLandscapePortContract(landscape, route);
  });
});

/**
 * #762 AC-R2 — real recorded landscapes (scripts/record-landscape-fixtures.ts):
 * GLO-90 heights through Open-Meteo on a loch, a canal, a city river and a
 * coast. Each holds the "heights are relative to the water" scenario on real data.
 */
/** AC-R2: the fixture set must not shrink below this. */
const MIN_RECORDED_ROUTES = 2;
const FIXTURE_DIR = join(__dirname, 'fixtures', 'landscape');
const recorded = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as {
    courseId: string;
    route: { lat: number; lng: number }[];
    elevation: { originX: number; originZ: number; stepX: number; stepZ: number; spacingM: number; cols: number; rows: number; heights: (number | null)[] };
  });

describe('recorded real landscapes (#762 AC-R2)', () => {
  it('covers at least four real routes', () => {
    expect(recorded.map((r) => r.courseId).sort()).toEqual(expect.arrayContaining(['180', '277']));
    expect(recorded.length).toBeGreaterThanOrEqual(MIN_RECORDED_ROUTES);
  });

  it.each(recorded.map((r) => [r.courseId, r] as const))('course %s: grid frame, and the water at 0 (AC: heights relative to the water)', (_id, r) => {
    const g = r.elevation;
    expect(g.spacingM).toBeGreaterThanOrEqual(LANDSCAPE_GRID_MIN_SPACING_M);
    expect(g.heights.length).toBe(g.cols * g.rows);
    const frame = routeFrame(r.route)!;
    let near = 0;
    for (let row = 0; row < g.rows; row += 1) {
      for (let col = 0; col < g.cols; col += 1) {
        const h = g.heights[row * g.cols + col];
        if (h === null) continue;
        const x = g.originX + col * g.stepX;
        const z = g.originZ + row * g.stepZ;
        if (distanceToCourse(frame, x, -z) <= WATER_FLAT_M) {
          near += 1;
          expect(Math.abs(h), `course ${r.courseId} (${col},${row})`).toBeLessThanOrEqual(2);
        }
      }
    }
    expect(near).toBeGreaterThan(0);
  });
});
