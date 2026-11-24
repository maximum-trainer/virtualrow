/**
 * #750 VP-27 — a river course imports at once on its gate chain, and the
 * waterway lookup refines the same route in the background.
 */
import { describe, expect, it, vi } from 'vitest';
import { RownativeService, type RownativeGeometryEvent } from '../lib/services/rownativeService';
import { RouteService } from '../lib/services/routeService';
import { WaterwayPathCache } from '../lib/services/waterwayPathCache';
import type { WaterwayPathProvider } from '../lib/services/rownativeGeometry';
import type { Coordinate } from '../lib/types/index';

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

const courseFile = (name = 'Bend Head') => ({
  id: '900',
  name,
  country: 'United Kingdom',
  distance_m: 2000,
  polygons: [gatePolygon(0, 52.0, 0.0), gatePolygon(1, 52.018, 0.0)],
});

/** A river that swings about 400 m east between the two gates. */
const RIVER: Coordinate[] = Array.from({ length: 21 }, (_, i) => ({
  lat: 52.0 + (0.018 * i) / 20,
  lng: 0.006 * Math.sin((i / 20) * Math.PI),
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const setup = (provider: WaterwayPathProvider, name?: string) => {
  const routes = new RouteService();
  const memory = new Map<string, string>();
  const cache = new WaterwayPathCache(() => ({
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
  }));
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(courseFile(name)) }) as Response);
  const service = new RownativeService(
    fetchMock as unknown as typeof fetch,
    (data) => routes.importRouteFromRownative(data),
    { getCoordinates: () => null } as unknown as ConstructorParameters<typeof RownativeService>[2],
    provider,
    {
      replaceGeometry: (id, update) => routes.replaceRownativeGeometry(id, update),
      findRoute: (id) => routes.getRouteById(id),
      pathCache: cache,
    },
  );
  const events: RownativeGeometryEvent[] = [];
  service.onGeometryEvent((e) => events.push(e));
  return { routes, service, events };
};

describe('rownative background waterway lookup (#750)', () => {
  it('imports at once on the gate chain, then replaces the same route with the river', async () => {
    const lookup = deferred<Coordinate[] | null>();
    const { routes, service, events } = setup({ findPath: () => lookup.promise });

    const imported = await service.importCourseById('900');
    const position = routes.getAllRoutes().findIndex((r) => r.id === imported.id);
    expect(imported.geometrySource).toBe('gate-chain');
    expect(imported.distance).toBeCloseTo(2.0, 1);
    expect(service.isTracing(imported.id)).toBe(true);
    expect(events).toEqual([{ kind: 'tracing', routeId: imported.id }]);

    lookup.resolve(RIVER);
    await service.geometrySettled(imported.id);

    const after = routes.getRouteById(imported.id)!;
    expect(after).toBe(imported);
    expect(routes.getAllRoutes().findIndex((r) => r.id === imported.id)).toBe(position);
    expect(after.geometrySource).toBe('osm-derived');
    expect(after.distance).toBeGreaterThan(2.1);
    expect(after.tags).toContain('geometry:osm-derived');
    expect(after.tags).not.toContain('outline-only');
    expect(service.isTracing(imported.id)).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(['tracing', 'replaced', 'settled']);
  });

  it('leaves the gate chain, quietly, when the lookup fails', async () => {
    const { routes, service, events } = setup({ findPath: () => Promise.reject(new Error('502 at capacity')) });
    const imported = await service.importCourseById('900');
    await service.geometrySettled(imported.id);
    expect(routes.getRouteById(imported.id)!.geometrySource).toBe('gate-chain');
    expect(events.map((e) => e.kind)).toEqual(['tracing', 'settled']);
  });

  it('does not look for a river on a lake', async () => {
    const findPath = vi.fn();
    const { service, events } = setup({ findPath }, 'Lake Bend Regatta');
    const imported = await service.importCourseById('900');
    expect(service.isTracing(imported.id)).toBe(false);
    expect(findPath).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('holds the new line while the route is being rowed, and applies it when the row ends', async () => {
    const { routes, service } = setup({ findPath: async () => RIVER });
    let rowing = true;
    service.setGeometryHold(() => rowing);
    const imported = await service.importCourseById('900');
    const before = [...imported.coordinates];
    await service.geometrySettled(imported.id);
    expect(routes.getRouteById(imported.id)!.coordinates).toEqual(before);
    expect(routes.getRouteById(imported.id)!.geometrySource).toBe('gate-chain');

    rowing = false;
    service.releaseHeldGeometry();
    expect(routes.getRouteById(imported.id)!.geometrySource).toBe('osm-derived');
  });

  it('upgrades a gate-chain route with "Refresh geometry", keeping its id', async () => {
    let answer: Coordinate[] | null = null;
    const { routes, service } = setup({ findPath: async () => answer });
    const imported = await service.importCourseById('900');
    await service.geometrySettled(imported.id);
    expect(imported.geometrySource).toBe('gate-chain');

    answer = RIVER;
    const refreshed = await service.refreshGeometry(imported.id);
    expect(refreshed?.id).toBe(imported.id);
    expect(routes.getRouteById(imported.id)!.geometrySource).toBe('osm-derived');
  });

  it('refreshes nothing for a route that is not a rownative river course', async () => {
    const { service } = setup({ findPath: async () => RIVER });
    expect(await service.refreshGeometry('1')).toBeNull();
    expect(await service.refreshGeometry('no-such-route')).toBeNull();
  });

  it('answers a second import of the same course from the cache, with no lookup', async () => {
    const findPath = vi.fn(async () => RIVER);
    const { routes, service } = setup({ findPath });
    const first = await service.importCourseById('900');
    await service.geometrySettled(first.id);
    const second = await service.importCourseById('900');
    await service.geometrySettled(second.id);
    expect(findPath).toHaveBeenCalledTimes(1);
    expect(routes.getRouteById(second.id)!.geometrySource).toBe('osm-derived');
  });
});

describe('RouteService.replaceRownativeGeometry (#750 FR2)', () => {
  it('keeps the route id and position and any tag the import did not write', () => {
    const routes = new RouteService();
    const route = routes.importRouteFromRownative({
      id: '900',
      name: 'Bend Head',
      country: 'UK',
      coordinates: [RIVER[0], RIVER[RIVER.length - 1]],
      geometrySource: 'gate-chain',
      status: 'established',
    });
    route.tags.push('favourite');
    const replaced = routes.replaceRownativeGeometry(route.id, { coordinates: RIVER, geometrySource: 'osm-derived' })!;
    expect(replaced).toBe(route);
    expect(replaced.tags).toEqual(expect.arrayContaining(['rownative', 'status:established', 'geometry:osm-derived', 'favourite']));
    expect(replaced.tags).not.toContain('geometry:gate-chain');
    expect(replaced.tags).not.toContain('outline-only');
    expect(replaced.distance).toBeGreaterThan(2.1);
    expect(replaced.estimatedTime).toBe(Math.round((replaced.distance / 3.5) * 60));
  });

  it('refuses the demo route and a line with fewer than two points', () => {
    const routes = new RouteService();
    expect(routes.replaceRownativeGeometry('1', { coordinates: RIVER, geometrySource: 'osm-derived' })).toBeUndefined();
    const route = routes.importRouteFromRownative({
      id: '900', name: 'Bend Head', country: 'UK', coordinates: RIVER, geometrySource: 'gate-chain',
    });
    expect(routes.replaceRownativeGeometry(route.id, { coordinates: [RIVER[0]], geometrySource: 'osm-derived' })).toBeUndefined();
  });
});
