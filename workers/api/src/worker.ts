// Cloudflare Worker entry point for virtualrow's server-side persistence.
// See issue #670. Only the DB healthcheck lives here in Phase 1; feature
// routes land with their feature issues (#37, #421, #417, #477, #650).
export interface Env {
  DB: D1Database;
}

export interface HealthResponse {
  ok: boolean;
  error?: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health/db') {
      return handleHealth(env);
    }
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
