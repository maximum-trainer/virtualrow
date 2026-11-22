// Entry module. It exports nothing but the handler: the Workers runtime
// rejects an entry module whose named exports are not handlers ("Incorrect
// type for map entry"), which is why the logic and its constants live in
// `proxy.ts`.
import { handle } from './proxy';

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    const edge = caches.default;
    return handle(request, {
      fetch: (url, init) => fetch(url, init),
      cache: {
        match: (key) => edge.match(new Request(key)),
        // Store after the response has gone out.
        put: async (key, response) => { ctx.waitUntil(edge.put(new Request(key), response)); },
      },
    });
  },
} satisfies ExportedHandler;
