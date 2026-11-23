import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RownativeService } from '../lib/services/rownativeService';
import { RouteService } from '../lib/services/routeService';
import { OsmWaterwayPathProvider } from '../lib/services/osmWaterwayPathProvider';
import type { WaterwayPathProvider } from '../lib/services/rownativeGeometry';

/**
 * #756 — sea and regatta courses no longer wait for a river lookup, and a
 * course that cannot be imported says so before any network request.
 */

const jsonResponse = (body: unknown, status = 200) => {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text } as unknown as Response;
};

const course = (id: string, name: string) => ({
  id,
  name,
  country: 'United Kingdom',
  distance_m: 6000,
  status: 'established',
  polygons: [
    { order: 0, name: 'Start', points: [{ lat: 56.89, lon: -2.2 }] },
    { order: 1, name: 'Finish', points: [{ lat: 56.96, lon: -2.21 }] },
  ],
});

const setup = (file: unknown, provider: WaterwayPathProvider) => {
  const routes = new RouteService();
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(file));
  const service = new RownativeService(
    fetchMock as unknown as typeof fetch,
    (data) => routes.importRouteFromRownative(data),
    { getCoordinates: () => null } as unknown as ConstructorParameters<typeof RownativeService>[2],
    provider,
  );
  return { service, fetchMock };
};

describe('rownative import of sea and impossible courses (#756)', () => {
  it('refuses a course that starts and finishes in the same place without asking the map server', async () => {
    const file = JSON.parse(
      readFileSync(join(__dirname, 'fixtures', 'rownative', '175.json'), 'utf8'),
    ) as unknown;
    const findPath = vi.fn().mockResolvedValue(null);
    const { service } = setup(file, { findPath });
    await expect(service.importCourseById('175')).rejects.toThrow(/starts and finishes in the same place/);
    expect(findPath).not.toHaveBeenCalled();
  });

  it('does not look for a river on a CCRC sea course, and tags it open water and coastal', async () => {
    const findPath = vi.fn().mockResolvedValue(null);
    const { service } = setup(course('177', 'CCRC - Catterline to Stonehaven'), { findPath });
    const route = await service.importCourseById('177');
    expect(findPath).not.toHaveBeenCalled();
    expect(route.tags).toEqual(expect.arrayContaining(['open_water', 'coastal']));
  });

  it('does not look for a river on a regatta course', async () => {
    const findPath = vi.fn().mockResolvedValue(null);
    const { service } = setup(course('18', 'Munich Regatta'), { findPath });
    const route = await service.importCourseById('18');
    expect(findPath).not.toHaveBeenCalled();
    expect(route.tags).toContain('lake');
    expect(route.tags).not.toContain('coastal');
  });

  it('asks the map server once per session for a course with no waterway (FR5)', async () => {
    const overpass = vi.fn().mockResolvedValue(jsonResponse({ elements: [] }));
    const provider = new OsmWaterwayPathProvider(overpass as unknown as typeof fetch);
    const { service } = setup(course('42', 'Somewhere Head'), provider);
    await service.importCourseById('42');
    await service.importCourseById('42');
    expect(overpass).toHaveBeenCalledOnce();
  });
});
