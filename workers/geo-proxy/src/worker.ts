// Entry module. It exports nothing but the handler: the Workers runtime
// rejects an entry module whose named exports are not handlers ("Incorrect
// type for map entry"), which is why the logic and its constants live in
// `proxy.ts`.
import { handle } from './proxy';
import { d1PointStore } from './store';

interface Env {
  /** Optional D1 database for the per-point store. See README "Durable cache". */
  ELEVATIONS?: D1Database;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const edge = caches.default;
    return handle(request, {
      fetch: (url, init) => fetch(url, init),
      cache: {
        match: (key) => edge.match(new Request(key)),
        // Store after the response has gone out.
        put: async (key, response) => { ctx.waitUntil(edge.put(new Request(key), response)); },
      },
      store: env.ELEVATIONS ? d1PointStore(env.ELEVATIONS) : undefined,
    });
  },
} satisfies ExportedHandler<Env>;
