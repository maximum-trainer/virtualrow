// Cloudflare Worker: browser-readable OpenTopoData elevations for virtualrow.
//
// Why it exists (#741, #762): api.opentopodata.org sends no CORS headers, so
// the browser can never read its answer and every imported route has gone
// without elevation. This Worker makes the same request server-side, adds
// CORS for virtualrow's own origins and caches the answer at the edge.
//
// It mirrors the upstream path and query exactly
//   GET /v1/srtm30m?locations=lat,lng|lat,lng...
// so the app only has to swap the host.
//
// It is deliberately not an open proxy: one dataset, validated coordinates,
// at most 100 points, virtualrow origins only. The public upstream allows
// 1 call per second and 1,000 calls per day in total, shared by everyone who
// uses this Worker, so every guard here protects that budget.

export const UPSTREAM_BASE = 'https://api.opentopodata.org';
/** The only path served. Same as upstream's. */
export const DATASET_PATH = '/v1/srtm30m';
/** OpenTopoData's own per-request limit. */
export const MAX_LOCATIONS = 100;
/** Terrain does not change: keep good answers for 30 days. */
export const CACHE_TTL_SECONDS = 30 * 24 * 3600;
/** 5 decimal places is about 1 m: finer than the 30 m dataset by far. */
const COORD_DECIMALS = 5;

/**
 * Origins allowed to use the proxy. The deployed site, the legacy Pages
 * hostname, and the local dev and preview servers.
 */
export const ALLOWED_ORIGINS: readonly string[] = [
  'https://maximum-trainer.github.io',
  'https://maximumtrainer.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

/** The two things the handler needs from its environment; faked in tests. */
export interface Deps {
  fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
  cache: {
    match: (key: string) => Promise<Response | undefined>;
    put: (key: string, response: Response) => Promise<void>;
  };
}

const corsHeaders = (origin: string): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

const json = (
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

/**
 * Parse and canonicalise `locations`. Returns the canonical string
 * (`lat,lng|lat,lng`, rounded) or an error message.
 */
export const canonicalLocations = (raw: string | null): { ok: true; value: string } | { ok: false; error: string } => {
  if (!raw) return { ok: false, error: 'locations is required: lat,lng|lat,lng' };
  const parts = raw.split('|');
  if (parts.length > MAX_LOCATIONS) {
    return { ok: false, error: `at most ${MAX_LOCATIONS} locations per request` };
  }
  const out: string[] = [];
  for (const part of parts) {
    const pair = part.split(',');
    if (pair.length !== 2) return { ok: false, error: `not a lat,lng pair: ${part.slice(0, 40)}` };
    const lat = Number(pair[0]);
    const lng = Number(pair[1]);
    if (pair[0]!.trim() === '' || pair[1]!.trim() === '' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { ok: false, error: `not a lat,lng pair: ${part.slice(0, 40)}` };
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { ok: false, error: `out of range: ${part.slice(0, 40)}` };
    }
    // `Number(x.toFixed(n))` drops trailing zeros, so 52.20000 and 52.2 share a key.
    out.push(`${Number(lat.toFixed(COORD_DECIMALS))},${Number(lng.toFixed(COORD_DECIMALS))}`);
  }
  return { ok: true, value: out.join('|') };
};

export const handle = async (request: Request, deps: Deps): Promise<Response> => {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/health') {
    return json({ ok: true, upstream: UPSTREAM_BASE }, 200);
  }

  if (url.pathname !== DATASET_PATH) return json({ error: 'not found' }, 404);

  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    // No CORS header on purpose: a browser on another site cannot read this.
    return json({ error: 'origin not allowed' }, 403);
  }
  const cors = corsHeaders(origin);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, { ...cors, Allow: 'GET, OPTIONS' });

  const locations = canonicalLocations(url.searchParams.get('locations'));
  if (!locations.ok) return json({ error: locations.error }, 400, cors);

  const upstreamUrl = `${UPSTREAM_BASE}${DATASET_PATH}?locations=${encodeURIComponent(locations.value)}`;
  const good = { ...cors, 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` };

  // The cache is keyed by the canonical upstream URL, never by origin: the
  // stored body is origin-free and the CORS headers are added per request.
  const cached = await deps.cache.match(upstreamUrl);
  if (cached) return json(await cached.json(), 200, { ...good, 'X-Geo-Proxy-Cache': 'HIT' });

  let upstream: Response;
  try {
    upstream = await deps.fetch(upstreamUrl, { headers: { Accept: 'application/json' } });
  } catch {
    return json({ error: 'elevation source unreachable' }, 502, cors);
  }
  if (upstream.status === 429) {
    return json({ error: 'elevation source is rate limited' }, 429, { ...cors, 'Retry-After': '1' });
  }
  if (!upstream.ok) {
    return json({ error: `elevation source answered ${upstream.status}` }, 502, cors);
  }

  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    return json({ error: 'elevation source sent an unreadable answer' }, 502, cors);
  }
  await deps.cache.put(
    upstreamUrl,
    new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` },
    }),
  );
  return json(body, 200, { ...good, 'X-Geo-Proxy-Cache': 'MISS' });
};
