# @virtualrow/api

Cloudflare Worker that owns virtualrow's server-side persistence (Cloudflare D1). See issue #670.

Phase 1 ships only `GET /health/db`, which runs `SELECT 1` against the bound D1 database and returns `{ "ok": true }`. Feature routes land with their feature issues (#37, #421, #417, #477, #650). Full documentation — including rotation, local-dev flow and token-scope requirements — moves to `docs/d1.md` in Phase 3.

## Local dev

```bash
cd workers/api
npm install
npm run dev     # wrangler dev --local; local SQLite file under .wrangler/state/d1/
npm test
```

No Cloudflare account is required to build the client (`npm run build` in the repo root); the Worker is optional for local client development.

## Bindings

| Env          | Worker name              | D1 database        |
|--------------|--------------------------|--------------------|
| `dev`        | `virtualrow-api-dev`     | `virtualrow-dev`   |
| `production` | `virtualrow-api`         | `virtualrow-prod`  |

Binding name is `DB` in both environments. IDs live in `wrangler.toml` (not secrets).
