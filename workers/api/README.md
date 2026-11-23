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

## Profile API (#37)

Every `/api/*` call carries the app's intervals.icu access token as
`Authorization: Bearer <token>`. The Worker checks it against
`https://intervals.icu/api/v1/athlete/0`, caches the athlete for 10 minutes per
isolate (keyed by a SHA-256 of the token), and creates the `users` row on first use.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/profile/appearance` or `/colours` | | `{ value, updatedAt }` (`null`s when unset) |
| PUT | same | `{ value, updatedAt }` (epoch ms, ≤16 KB) | 200 stored copy, or 409 with the newer stored copy |

Browser origins come from the `ALLOWED_ORIGINS` var in `wrangler.toml`
(production: the GitHub Pages host only).
