// Cloudflare Worker entry point for virtualrow's server-side persistence.
// See issues #670 (foundation) and #37 (auth + profile API).
import { createAthleteVerifier, fetchIntervalsAthlete, type FetchAthlete } from './auth';
import { allowedOrigin, preflight, withCors } from './cors';
import { getField, isProfileField, putField, upsertUser } from './profile';
import { createRateLimiter, ingestProblemReport, ingestTelemetry, runRetention } from './telemetry';

export interface Env {
  DB: D1Database;
  /** Comma-separated browser origins allowed to call /api/*. */
  ALLOWED_ORIGINS?: string;
}

export interface HealthResponse {
  ok: boolean;
  error?: string;
}

export interface HandlerDeps {
  fetchAthlete: FetchAthlete;
  now: () => number;
}

async function handleHealth(env: Env): Promise<Response> {
  try {
    const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    const ok = row?.ok === 1;
    const body: HealthResponse = ok ? { ok: true } : { ok: false, error: 'unexpected-result' };
    return Response.json(body, { status: ok ? 200 : 500 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message } satisfies HealthResponse, { status: 500 });
  }
}

const PROFILE_ROUTE = /^\/api\/profile\/([a-z]+)$/;

export function createHandler(deps: HandlerDeps) {
  const verify = createAthleteVerifier(deps.fetchAthlete, deps.now);
  const allowIngest = createRateLimiter(deps.now);

  async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health/db') return handleHealth(env);

    if (url.pathname === '/api/telemetry' || url.pathname === '/api/problem-reports') {
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, OPTIONS' } });
      }
      if (!allowIngest(request.headers.get('CF-Connecting-IP') ?? 'unknown')) {
        return Response.json({ error: 'rate-limited' }, { status: 429, headers: { 'Retry-After': '60' } });
      }
      return url.pathname === '/api/telemetry'
        ? ingestTelemetry(env.DB, request, deps.now())
        : ingestProblemReport(env.DB, request, deps.now());
    }

    const match = PROFILE_ROUTE.exec(url.pathname);
    if (!match?.[1]) return new Response('Not Found', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'PUT') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, PUT, OPTIONS' } });
    }
    const athlete = await verify(request);
    if (!athlete) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const field = match[1];
    if (!isProfileField(field)) return Response.json({ error: 'unknown-field' }, { status: 404 });

    const now = deps.now();
    const userId = await upsertUser(env.DB, athlete, now);
    return request.method === 'GET'
      ? getField(env.DB, userId, field)
      : putField(env.DB, userId, field, request, now);
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const origin = allowedOrigin(request, env.ALLOWED_ORIGINS);
      if (request.method === 'OPTIONS') return preflight(origin);
      return withCors(await route(request, env), origin);
    },
    /** #421 daily retention (cron in wrangler.toml). */
    async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
      await runRetention(env.DB, deps.now());
    },
  } satisfies ExportedHandler<Env>;
}

export default createHandler({ fetchAthlete: fetchIntervalsAthlete, now: Date.now });
