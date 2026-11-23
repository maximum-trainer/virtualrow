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

## Telemetry ingest (#421)

Anonymous, no auth. The browser posts a client-random `runId` per page load;
the Worker never stores the client IP or any user id.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/api/telemetry` | `{ schemaVersion: 1, runId, build?, tier?, events: [{ at, kind, detail? }] }` (1–300 events) | 202 `{ accepted }` |
| POST | `/api/problem-reports` | `{ schemaVersion: 1, runId, description, events? }` | 201 `{ id }` |

Bodies over 64 KB get 413, and an IP over 60 requests a minute (per isolate) gets 429.
Strings are scrubbed of emails, bearer tokens, JWTs, long hex keys and secret
query parameters, and object keys that name a secret are redacted. A daily cron
(`17 3 * * *` UTC) deletes events after 90 days, except those of a run with a
problem report, and deletes problem reports after 365 days. Triage starts at
the `v_error_groups_7d` view.
