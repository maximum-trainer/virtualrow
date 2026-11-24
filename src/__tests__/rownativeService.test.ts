import { afterEach, describe, expect, it, vi } from 'vitest';
import { RownativeCourseNotFoundError, RownativeService } from '../lib/services/rownativeService';
import { RouteService } from '../lib/services/routeService';
import { WaterwayPathCache } from '../lib/services/waterwayPathCache';
import { polylineLengthMeters } from '../lib/utils/coordinateUtils';

/** Response double exposing both json() and text(), as the service uses each. */
function jsonResponse(body: unknown, status = 200) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text } as unknown as Response;
}

describe('RownativeService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the global fetch with the correct receiver when none is injected', async () => {
    // Regression: the constructor default used to store a bare `fetch` on an
    // instance field, so `this.fetchImpl(...)` invoked it with the service as
    // its receiver and browsers threw "Illegal invocation". Every unit test
    // injects a double, so only a real browser ever hit it.
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      id: '1',
      name: 'Course One',
      country: 'United States',
      distance_m: 5306,
      polygons: [
        { order: 0, points: [{ lat: 42.24, lon: -71.81 }] },
        { order: 1, points: [{ lat: 42.28, lon: -71.81 }] },
      ],
    }));

    const service = new RownativeService();
    await expect(service.importCourseById('1')).resolves.toBeDefined();
    // One request to the mirror; the waterway lookup (#743) is a second call
    // to a different host and goes through the same forwarding arrow.
    const mirrorCalls = globalFetch.mock.calls.filter(([url]) => !String(url).includes('overpass'));
    expect(mirrorCalls).toHaveLength(1);
    // Invoked as a plain call, not as a method of the service instance.
    for (const receiver of globalFetch.mock.instances) {
      expect(receiver).not.toBeInstanceOf(RownativeService);
    }
  });

  it('searches courses by name from the index', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: '1', name: 'Amsterdam Canal Sprint', country: 'Netherlands', distance_m: 2000 },
        { id: '2', name: 'Boston Head Course', country: 'United States', distance_m: 4800 },
      ],
    } as Response);

    const service = new RownativeService(fetchMock as unknown as typeof fetch);
    const results = await service.searchCourses('amsterdam');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
    expect(results[0].distanceMeters).toBe(2000);
  });

  it('reads has_path from the index and can search only traced courses (#747 FR4)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: '1', name: 'Kanaal A', country: 'Netherlands', distance_m: 2000 },
        { id: '277', name: 'Kanaal B', country: 'Netherlands', distance_m: 8889, has_path: true },
        { id: '3', name: 'Kanaal C', country: 'Netherlands', distance_m: 1000, has_path: 'yes' },
      ],
    } as Response);

    const service = new RownativeService(fetchMock as unknown as typeof fetch);
    const all = await service.searchCourses('kanaal');
    expect(all.map((c) => [c.id, c.hasPath])).toEqual([
      ['1', false],
      ['277', true],
      ['3', false],
    ]);
    const traced = await service.searchCourses('kanaal', 30, { tracedOnly: true });
    expect(traced.map((c) => c.id)).toEqual(['277']);
  });

  it('imports a course and creates a rownative WaterRoute', async () => {
    const isolatedRouteService = new RouteService();
    const initialCount = isolatedRouteService.getAllRoutes().length;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: '77', name: 'River Course', country: 'Germany', distance_m: 6200 }],
      } as Response)
      .mockResolvedValueOnce(jsonResponse({
        id: '77',
        name: 'River Course',
        country: 'Germany',
        distance_m: 6200,
        status: 'provisional',
        polygons: [
          { order: 0, points: [{ lat: 52.5, lon: 13.4 }, { lat: 52.51, lon: 13.41 }, { lat: 52.5, lon: 13.42 }] },
          { order: 1, points: [{ lat: 52.52, lon: 13.43 }, { lat: 52.53, lon: 13.44 }, { lat: 52.52, lon: 13.45 }] },
        ],
      }));

    const service = new RownativeService(
      fetchMock as unknown as typeof fetch,
      (data) => isolatedRouteService.importRouteFromRownative(data),
    );
    const [course] = await service.searchCourses('river');
    const imported = await service.importCourse(course);

    expect(imported.source).toBe('rownative');
    // Distance is measured from the geometry, never taken from distance_m (#194 R-5).
    expect(imported.geometrySource).toBe('gate-chain');
    expect(imported.externalDistanceMeters).toBe(6200);
    expect(Math.abs(imported.distance * 1000 - polylineLengthMeters(imported.coordinates))).toBeLessThan(1);
    // The two polygon centroids are the route's endpoints, but the centreline is
    // densified in between so the engine gets demo-route resolution (issue #189).
    expect(imported.coordinates.length).toBeGreaterThan(2);
    // Endpoints are the polygon centroids: mean of each gate's three vertices.
    expect(imported.coordinates[0].lat).toBeCloseTo(52.50333, 4);
    expect(imported.coordinates[0].lng).toBeCloseTo(13.41, 4);
    const last = imported.coordinates[imported.coordinates.length - 1];
    expect(last.lat).toBeCloseTo(52.52333, 4);
    expect(last.lng).toBeCloseTo(13.44, 4);
    expect(isolatedRouteService.getAllRoutes().length).toBe(initialCount + 1);
  });

  it('imports a course by id alone, without an index lookup', async () => {
    const isolatedRouteService = new RouteService();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: '106',
      name: 'HOTS Stake Race',
      country: 'United States',
      distance_m: 4804,
      status: 'established',
      polygons: [
        { order: 0, points: [{ lat: 42.24, lon: -71.81 }] },
        { order: 1, points: [{ lat: 42.28, lon: -71.79 }] },
      ],
    }));

    const service = new RownativeService(
      fetchMock as unknown as typeof fetch,
      (data) => isolatedRouteService.importRouteFromRownative(data),
    );
    const route = await service.importCourseById('106');

    // One mirror request only: the course JSON already carries
    // name/country/distance, so there is no index lookup. (The waterway
    // lookup added by #743 goes to Overpass, not the mirror.)
    const mirrorCalls = fetchMock.mock.calls.filter(([url]) => !String(url).includes('overpass'));
    expect(mirrorCalls).toHaveLength(1);
    expect(mirrorCalls[0][0]).toContain('/106.json');
    expect(route.name).toBe('HOTS Stake Race');
    expect(route.externalDistanceMeters).toBe(4804);
    expect(Math.abs(route.distance * 1000 - polylineLengthMeters(route.coordinates))).toBeLessThan(1);
    expect(route.source).toBe('rownative');
  });

  it('rejects malformed input before making any request', async () => {
    const fetchMock = vi.fn();
    const service = new RownativeService(fetchMock as unknown as typeof fetch);

    await expect(service.importCourseById('../../secrets')).rejects.toThrow(/course ID or a rownative\.icu course link/i);
    await expect(service.importCourseById('')).rejects.toThrow(/course ID or a rownative\.icu course link/i);
    await expect(service.importCourseById('https://evil.example/course/5')).rejects.toThrow(/https:\/\/ links on rownative\.icu/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a course missing from the mirror as recoverable, carrying the id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    const service = new RownativeService(fetchMock as unknown as typeof fetch);

    await expect(service.importCourseById('2')).rejects.toBeInstanceOf(RownativeCourseNotFoundError);
    await expect(service.importCourseById('2')).rejects.toThrow(/isn't in the public mirror yet/i);
    await service.importCourseById('2').catch((e: unknown) => {
      expect((e as RownativeCourseNotFoundError).courseId).toBe('2');
    });
  });

  it('names the mirror lag in the not-found message (#211 R-D)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    const service = new RownativeService(fetchMock as unknown as typeof fetch);

    await service.importCourseById('99').catch((e: unknown) => {
      const msg = (e as Error).message;
      expect(msg).toMatch(/mirror lags/i);
      expect(msg).toMatch(/rownative\.icu/);
    });
  });

  it('reports a non-404 failure as a plain retryable error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
    const service = new RownativeService(fetchMock as unknown as typeof fetch);

    await expect(service.importCourseById('5')).rejects.toThrow(
      'Unable to load rownative course data (HTTP 500). Please try again.',
    );
    await expect(service.importCourseById('5')).rejects.not.toBeInstanceOf(RownativeCourseNotFoundError);
  });

  it('rejects malformed JSON and payloads missing required fields', async () => {
    const badJson = new RownativeService(
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'not json at all' } as unknown as Response) as unknown as typeof fetch,
    );
    await expect(badJson.importCourseById('5')).rejects.toThrow('Course 5 data is malformed.');

    const missingFields = new RownativeService(
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ polygons: [] }) }) as unknown as typeof fetch,
    );
    await expect(missingFields.importCourseById('5')).rejects.toThrow('Course 5 data is malformed.');
  });

  it('rejects a course payload larger than the size cap', async () => {
    const huge = JSON.stringify({ id: '5', name: 'Huge', padding: 'x'.repeat(3 * 1024 * 1024) });
    const service = new RownativeService(
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => huge }) as unknown as typeof fetch,
    );
    await expect(service.importCourseById('5')).rejects.toThrow('Course 5 data is too large to import.');
  });

  it('rejects a course with no usable polygons', async () => {
    const service = new RownativeService(
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: '5', name: 'Empty Course', polygons: [] }),
      }) as unknown as typeof fetch,
    );
    await expect(service.importCourseById('5')).rejects.toThrow(/insufficient coordinate data/i);
  });

  it('resolves a pasted course link end to end', async () => {
    const isolatedRouteService = new RouteService();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: '5', name: 'Quinsig S to N', country: 'United States', distance_m: 5349, status: 'established',
        polygons: [
          { order: 0, points: [{ lat: 42.246, lon: -71.746 }] },
          { order: 1, points: [{ lat: 42.28, lon: -71.75 }] },
        ],
      }),
    });
    const service = new RownativeService(
      fetchMock as unknown as typeof fetch,
      (data) => isolatedRouteService.importRouteFromRownative(data),
    );

    const route = await service.importCourseById('https://rownative.icu/course/5');
    expect(route.name).toBe('Quinsig S to N');
    expect(route.externalId).toBe('5');
    expect(fetchMock.mock.calls[0][0]).toContain('/5.json');
    // AC-6: course data comes only from the GitHub mirror.
    expect(fetchMock.mock.calls[0][0]).toContain('raw.githubusercontent.com/rownative/courses');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('rownative.icu/api');
  });

  it('names the course when importCourseById geometry is insufficient', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ id: '9', name: 'Broken Course', polygons: [{ order: 0, points: [{ lat: 1, lon: 2 }] }] }),
    );
    const service = new RownativeService(fetchMock as unknown as typeof fetch);

    await expect(service.importCourseById('9')).rejects.toThrow('Broken Course (9) has insufficient coordinate data');
  });

  it('throws a helpful error when course geometry has insufficient points', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: '9', name: 'Broken Course', country: 'Unknown', distance_m: 1000 }],
      } as Response)
      .mockResolvedValueOnce(jsonResponse({
        id: '9',
        name: 'Broken Course',
        polygons: [{ order: 0, points: [{ lat: 1, lon: 2 }] }],
      }));

    const service = new RownativeService(fetchMock as unknown as typeof fetch);
    const [course] = await service.searchCourses('broken');

    await expect(service.importCourse(course)).rejects.toThrow('Broken Course (9) has insufficient coordinate data');
  });

  it('reuses the same in-flight index fetch for concurrent callers', async () => {
    let resolveJson!: (value: Array<{ id: string; name: string; country: string; distance_m: number }>) => void;
    const jsonPromise = new Promise<Array<{ id: string; name: string; country: string; distance_m: number }>>((resolve) => {
      resolveJson = resolve;
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => jsonPromise,
    } as Response);

    const service = new RownativeService(fetchMock as unknown as typeof fetch);
    const first = service.searchCourses('river');
    const second = service.searchCourses('river');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveJson([{ id: '1', name: 'River Course', country: 'Germany', distance_m: 6200 }]);

    const [firstResults, secondResults] = await Promise.all([first, second]);
    expect(firstResults).toEqual(secondResults);
  });

  it('does not include raw URLs in HTTP errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    const service = new RownativeService(fetchMock as unknown as typeof fetch);

    await expect(service.searchCourses('river')).rejects.toThrow(
      'Unable to load rownative course data (HTTP 404). Please try again.',
    );
  });


  // #743: the waterway provider is on by default, so a gates-only river course
  // is rowed along the river.
  // #753 FR1 — a stake race's turn point travels with the imported route.
  it('stores the stake of an out-and-back course on the route', async () => {
    const gate = (name: string, order: number, lat: number, lon: number) => ({
      name,
      order,
      points: [
        { lat: lat - 0.0001, lon: lon - 0.0002 },
        { lat: lat + 0.0001, lon: lon + 0.0002 },
      ],
    });
    const file = {
      id: '233', name: 'HOTS Stake Race', country: 'United States', distance_m: 3000,
      polygons: [gate('Start', 0, 42.0, -71.0), gate('Stake', 1, 42.0135, -71.0), gate('Finish', 2, 42.0, -70.9996)],
    };
    const isolated = new RouteService();
    const service = new RownativeService(
      vi.fn(async () => jsonResponse(file)) as unknown as typeof fetch,
      (data) => isolated.importRouteFromRownative(data),
      undefined,
      null,
    );
    const route = await service.importCourseById('233');
    expect(route.stakeTurns).toHaveLength(1);
    expect(route.stakeTurns![0].lat).toBeCloseTo(42.0135, 4);
  });

  describe('gates-only river courses', () => {
    const gatePolygon = (order: number, lat: number, lon: number) => ({
      order,
      name: order === 0 ? 'Start' : 'Finish',
      points: [
        { lat: lat - 0.0001, lon: lon - 0.0002 },
        { lat: lat - 0.0001, lon: lon + 0.0002 },
        { lat: lat + 0.0001, lon: lon + 0.0002 },
        { lat: lat + 0.0001, lon: lon - 0.0002 },
      ],
    });
    const courseFile = {
      id: '900',
      name: 'Bend Head',
      country: 'United Kingdom',
      distance_m: 2000,
      polygons: [gatePolygon(0, 52.0, 0.0), gatePolygon(1, 52.018, 0.0)],
    };
    // A river that swings about 400 m east between the two gates.
    const river = {
      elements: [
        {
          type: 'way',
          tags: { waterway: 'river' },
          geometry: Array.from({ length: 21 }, (_, i) => ({
            lat: 52.0 + (0.018 * i) / 20,
            lon: 0.006 * Math.sin((i / 20) * Math.PI),
          })),
        },
      ],
    };
    const fetchFor = (overpassBody: unknown, overpassOk = true) =>
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('overpass')) return { ok: overpassOk, json: async () => overpassBody } as Response;
        if (url.endsWith('index.json')) {
          return { ok: true, json: async () => [{ id: '900', name: 'Bend Head', country: 'United Kingdom', distance_m: 2000 }] } as Response;
        }
        return jsonResponse(courseFile);
      });

    it('follows the mapped waterway and says so, once the background lookup lands (#750)', async () => {
      const isolated = new RouteService();
      const service = new RownativeService(
        fetchFor(river) as unknown as typeof fetch,
        (data) => isolated.importRouteFromRownative(data),
        undefined,
        undefined,
        {
          replaceGeometry: (id, update) => isolated.replaceRownativeGeometry(id, update),
          findRoute: (id) => isolated.getRouteById(id),
          pathCache: new WaterwayPathCache(() => null),
        },
      );
      const [found] = await service.searchCourses('bend');
      const imported = await service.importCourse(found);
      // #750 FR1: the import returns on the gate chain, without the lookup.
      expect(imported.geometrySource).toBe('gate-chain');

      await service.geometrySettled(imported.id);
      const refined = isolated.getRouteById(imported.id)!;
      expect(refined.geometrySource).toBe('osm-derived');
      // Straight line is 2.0 km; round the bend is nearer 2.2 km.
      expect(refined.distance).toBeGreaterThan(2.1);
      expect(refined.externalDistanceMeters).toBe(2000);
    });

    it('still imports on the gate chain when the map service is down', async () => {
      const isolated = new RouteService();
      const service = new RownativeService(
        fetchFor({}, false) as unknown as typeof fetch,
        (data) => isolated.importRouteFromRownative(data),
      );
      const [found] = await service.searchCourses('bend');
      const imported = await service.importCourse(found);

      expect(imported.geometrySource).toBe('gate-chain');
      expect(imported.distance).toBeCloseTo(2.0, 1);
    });

    it('can be switched off', async () => {
      const isolated = new RouteService();
      const fetchMock = fetchFor(river);
      const service = new RownativeService(
        fetchMock as unknown as typeof fetch,
        (data) => isolated.importRouteFromRownative(data),
        undefined,
        null,
      );
      const [found] = await service.searchCourses('bend');
      const imported = await service.importCourse(found);

      expect(imported.geometrySource).toBe('gate-chain');
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('overpass'))).toBe(false);
    });

    it('does not ask for a waterway on a course its name says is a lake', async () => {
      // The lookup costs about half a minute on a busy day and a lake has no
      // centreline to follow.
      const isolated = new RouteService();
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('overpass')) return { ok: true, json: async () => river } as Response;
        return jsonResponse({ ...courseFile, id: '901', name: 'Lake Quinsigamond - 2K Classic' });
      });
      const service = new RownativeService(
        fetchMock as unknown as typeof fetch,
        (data) => isolated.importRouteFromRownative(data),
      );

      const imported = await service.importCourseById('901');

      expect(imported.geometrySource).toBe('gate-chain');
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes('overpass'))).toBe(false);
    });
  });
});
