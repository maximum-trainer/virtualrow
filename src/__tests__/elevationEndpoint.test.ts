import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPEN_TOPO_DATA_URL,
  RouteEnrichmentService,
  resolveElevationUrl,
} from '../lib/services/routeEnrichmentService';
import type { WaterRoute } from '../lib/types';

/**
 * api.opentopodata.org sends no CORS headers, so a browser cannot read it
 * (#741). `workers/geo-proxy` mirrors its path behind CORS; the app uses it
 * when `VITE_GEO_PROXY_URL` is set at build time (#762 D1).
 */
describe('resolveElevationUrl', () => {
  it('uses the public endpoint when no proxy is configured', () => {
    expect(resolveElevationUrl(undefined)).toBe(OPEN_TOPO_DATA_URL);
    expect(resolveElevationUrl('')).toBe(OPEN_TOPO_DATA_URL);
    expect(resolveElevationUrl('   ')).toBe(OPEN_TOPO_DATA_URL);
  });

  it('swaps only the host when a proxy is configured', () => {
    expect(resolveElevationUrl('https://geo.example.workers.dev'))
      .toBe('https://geo.example.workers.dev/v1/srtm30m');
  });

  it('tolerates a trailing slash', () => {
    expect(resolveElevationUrl('https://geo.example.workers.dev/'))
      .toBe('https://geo.example.workers.dev/v1/srtm30m');
  });

  it('ignores a value that is not an https URL (or local http)', () => {
    expect(resolveElevationUrl('geo.example.workers.dev')).toBe(OPEN_TOPO_DATA_URL);
    expect(resolveElevationUrl('http://geo.example.workers.dev')).toBe(OPEN_TOPO_DATA_URL);
    expect(resolveElevationUrl('http://localhost:8787')).toBe('http://localhost:8787/v1/srtm30m');
  });
});

describe('RouteEnrichmentService elevation requests', () => {
  afterEach(() => vi.unstubAllEnvs());

  const route = {
    id: 'proxy-route',
    name: 'Proxy River',
    tags: ['river'],
    coordinates: [
      { lat: 52.2, lng: 0.12 },
      { lat: 52.201, lng: 0.121 },
    ],
  } as unknown as WaterRoute;

  const run = async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/v1/srtm30m')) {
        return Response.json({ results: [{ elevation: 5 }, { elevation: 6 }] });
      }
      return Response.json({ elements: [] });
    }) as typeof fetch;
    localStorage.clear();
    await new RouteEnrichmentService(fetchImpl, localStorage).enrichRoute(route);
    return urls.filter((u) => u.includes('/v1/srtm30m'));
  };

  it('go to the proxy when VITE_GEO_PROXY_URL is set', async () => {
    vi.stubEnv('VITE_GEO_PROXY_URL', 'https://geo.example.workers.dev');
    const calls = await run();
    expect(calls.length).toBeGreaterThan(0);
    for (const u of calls) expect(u.startsWith('https://geo.example.workers.dev/v1/srtm30m?locations=')).toBe(true);
  });

  it('go to OpenTopoData directly when it is not', async () => {
    vi.stubEnv('VITE_GEO_PROXY_URL', '');
    const calls = await run();
    expect(calls.length).toBeGreaterThan(0);
    for (const u of calls) expect(u.startsWith(`${OPEN_TOPO_DATA_URL}?locations=`)).toBe(true);
  });
});
