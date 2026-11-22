import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_ORIGINS,
  CACHE_TTL_SECONDS,
  MAX_LOCATIONS,
  UPSTREAM_BASE,
  handle,
  type Deps,
} from '../src/proxy';

const ORIGIN = 'https://maximum-trainer.github.io';
const okBody = { results: [{ elevation: 12.5, location: { lat: 52.2, lng: 0.12 }, dataset: 'srtm30m' }], status: 'OK' };

const makeDeps = (upstream?: (url: string) => Response | Promise<Response>) => {
  const store = new Map<string, Response>();
  const fetchImpl = vi.fn(async (input: string) =>
    upstream ? upstream(input) : Response.json(okBody));
  const deps: Deps = {
    fetch: fetchImpl as unknown as Deps['fetch'],
    cache: {
      match: async (key) => store.get(key)?.clone(),
      put: async (key, res) => { store.set(key, res.clone()); },
    },
  };
  return { deps, fetchImpl, store };
};

const get = (path: string, origin: string | null = ORIGIN, method = 'GET') =>
  new Request(`https://geo.example.workers.dev${path}`, {
    method,
    headers: origin ? { Origin: origin } : {},
  });

describe('geo-proxy: elevation', () => {
  it('forwards a valid lookup to OpenTopoData and returns its JSON with CORS', async () => {
    const { deps, fetchImpl } = makeDeps();
    const res = await handle(get('/v1/srtm30m?locations=52.2,0.12'), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Vary')).toContain('Origin');
    await expect(res.json()).resolves.toEqual(okBody);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${UPSTREAM_BASE}/v1/srtm30m?locations=52.2%2C0.12`);
  });

  it('keeps the upstream request shape for several points', async () => {
    const { deps, fetchImpl } = makeDeps();
    await handle(get('/v1/srtm30m?locations=' + encodeURIComponent('52.2,0.12|52.21,0.13')), deps);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${UPSTREAM_BASE}/v1/srtm30m?locations=52.2%2C0.12%7C52.21%2C0.13`);
  });

  it('serves a repeat lookup from the cache without calling upstream', async () => {
    const { deps, fetchImpl } = makeDeps();
    await handle(get('/v1/srtm30m?locations=52.2,0.12'), deps);
    const again = await handle(get('/v1/srtm30m?locations=52.2,0.12'), deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(again.headers.get('X-Geo-Proxy-Cache')).toBe('HIT');
    await expect(again.json()).resolves.toEqual(okBody);
  });

  it('treats coordinates that differ below a metre as the same lookup', async () => {
    const { deps, fetchImpl } = makeDeps();
    await handle(get('/v1/srtm30m?locations=52.2000001,0.1200001'), deps);
    await handle(get('/v1/srtm30m?locations=52.2000002,0.1200004'), deps);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a cached answer still carries the caller’s own origin', async () => {
    const { deps } = makeDeps();
    await handle(get('/v1/srtm30m?locations=52.2,0.12'), deps);
    const other = await handle(get('/v1/srtm30m?locations=52.2,0.12', 'http://localhost:5173'), deps);
    expect(other.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('tells browsers and the edge to keep a good answer for 30 days', async () => {
    const { deps } = makeDeps();
    const res = await handle(get('/v1/srtm30m?locations=52.2,0.12'), deps);
    expect(CACHE_TTL_SECONDS).toBe(30 * 24 * 3600);
    expect(res.headers.get('Cache-Control')).toBe(`public, max-age=${CACHE_TTL_SECONDS}`);
  });

  it('does not cache an upstream failure, and reports it as 502', async () => {
    let calls = 0;
    const { deps, fetchImpl } = makeDeps(() => {
      calls++;
      return calls === 1 ? new Response('boom', { status: 500 }) : Response.json(okBody);
    });
    const first = await handle(get('/v1/srtm30m?locations=52.2,0.12'), deps);
    expect(first.status).toBe(502);
    expect(first.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const second = await handle(get('/v1/srtm30m?locations=52.2,0.12'), deps);
    expect(second.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('passes an upstream rate limit through as 429 with Retry-After', async () => {
    const { deps } = makeDeps(() => new Response('slow down', { status: 429 }));
    const res = await handle(get('/v1/srtm30m?locations=52.2,0.12'), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('1');
  });

  it('reports a network failure as 502 rather than throwing', async () => {
    const { deps } = makeDeps(() => { throw new Error('connect timeout'); });
    const res = await handle(get('/v1/srtm30m?locations=52.2,0.12'), deps);
    expect(res.status).toBe(502);
  });
});

describe('geo-proxy: it is not an open proxy', () => {
  it.each([
    ['no locations', '/v1/srtm30m'],
    ['empty locations', '/v1/srtm30m?locations='],
    ['not numbers', '/v1/srtm30m?locations=abc,def'],
    ['latitude out of range', '/v1/srtm30m?locations=95,0'],
    ['longitude out of range', '/v1/srtm30m?locations=10,181'],
    ['one number', '/v1/srtm30m?locations=52.2'],
    ['three numbers', '/v1/srtm30m?locations=52.2,0.1,7'],
  ])('rejects %s with 400 and never calls upstream', async (_name, path) => {
    const { deps, fetchImpl } = makeDeps();
    const res = await handle(get(path), deps);
    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it(`rejects more than ${MAX_LOCATIONS} points`, async () => {
    const { deps, fetchImpl } = makeDeps();
    const many = Array.from({ length: MAX_LOCATIONS + 1 }, (_, i) => `52.${i},0.1`).join('|');
    const res = await handle(get('/v1/srtm30m?locations=' + encodeURIComponent(many)), deps);
    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts exactly the upstream limit', async () => {
    const { deps } = makeDeps();
    const many = Array.from({ length: MAX_LOCATIONS }, (_, i) => `52.${String(i).padStart(3, '0')},0.1`).join('|');
    const res = await handle(get('/v1/srtm30m?locations=' + encodeURIComponent(many)), deps);
    expect(res.status).toBe(200);
  });

  it.each(['/v1/aster30m?locations=1,1', '/v1/', '/', '/anything', '/v1/srtm30m/extra?locations=1,1'])(
    'serves only the one dataset: %s is 404',
    async (path) => {
      const { deps, fetchImpl } = makeDeps();
      const res = await handle(get(path), deps);
      expect(res.status).toBe(404);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([['https://evil.example'], [null]])('refuses origin %s with 403', async (origin) => {
    const { deps, fetchImpl } = makeDeps();
    const res = await handle(get('/v1/srtm30m?locations=52.2,0.12', origin), deps);
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses anything but GET and OPTIONS', async () => {
    const { deps } = makeDeps();
    const res = await handle(get('/v1/srtm30m?locations=52.2,0.12', ORIGIN, 'POST'), deps);
    expect(res.status).toBe(405);
  });
});

describe('geo-proxy: CORS and health', () => {
  it('answers a pre-flight from every deployed origin', async () => {
    expect(ALLOWED_ORIGINS).toContain(ORIGIN);
    for (const origin of ALLOWED_ORIGINS) {
      const { deps } = makeDeps();
      const res = await handle(get('/v1/srtm30m', origin, 'OPTIONS'), deps);
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    }
  });

  it('GET /health needs no origin and calls nothing', async () => {
    const { deps, fetchImpl } = makeDeps();
    const res = await handle(get('/health', null), deps);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, upstream: UPSTREAM_BASE });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('geo-proxy: entry module', () => {
  // workerd refuses to start a Worker whose entry module has named exports
  // that are not handlers. Caught by running `wrangler dev`; pinned here.
  it('exports only the default handler', async () => {
    const entry = await import('../src/worker');
    expect(Object.keys(entry)).toEqual(['default']);
    expect(typeof entry.default.fetch).toBe('function');
  });
});
