# geo-proxy

A Cloudflare Worker that lets the browser read elevations from
[OpenTopoData](https://www.opentopodata.org/).

OpenTopoData's public API sends no CORS headers, so a browser can send the
request but is never allowed to read the answer. Every imported route has been
drawn without elevation for that reason (#741). This Worker makes the same
request from Cloudflare, adds CORS for VirtualRow's own origins, and caches
the answer at the edge for 30 days. Decision D1 on #762.

## What it serves

| Request | Answer |
|---|---|
| `GET /v1/srtm30m?locations=lat,lng\|lat,lng…` | OpenTopoData's JSON, unchanged, with CORS |
| `OPTIONS /v1/srtm30m` | CORS pre-flight |
| `GET /health` | `{ "ok": true, "upstream": "https://api.opentopodata.org" }` |

The path and query are the same as upstream's, so the app only swaps the host.

## What it refuses

It is not an open proxy. The public upstream allows **1 call per second and
1,000 calls per day in total**, shared by everyone who uses this Worker.

- any path other than `/v1/srtm30m` → 404
- an `Origin` that is not in `ALLOWED_ORIGINS` (`src/proxy.ts`), or none → 403
- more than 100 points, or anything that is not a valid `lat,lng` → 400
- anything but `GET` / `OPTIONS` → 405

Upstream failures are reported as 502 (429 is passed through with
`Retry-After`) and are never cached. Coordinates are rounded to 5 decimal
places (about 1 m) before the lookup so near-identical requests share one
cache entry.

If the daily budget becomes a problem, the next step is self-hosting
OpenTopoData or switching dataset source; both are a change to `UPSTREAM_BASE`
only.

## Develop

```bash
cd workers/geo-proxy
npm install
npm test            # unit tests (no network)
npm run typecheck
npm run dev         # wrangler dev --local, http://127.0.0.1:8787
```

## Deploy

Needs a Cloudflare account and `wrangler login` (or `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` in the environment). There are no bindings and no
secrets.

```bash
cd workers/geo-proxy
npx wrangler deploy
```

Wrangler prints the URL, of the form
`https://virtualrow-geo-proxy.<your-subdomain>.workers.dev`.

Check it from a terminal:

```bash
BASE=https://virtualrow-geo-proxy.<your-subdomain>.workers.dev
curl -s $BASE/health
curl -si -H 'Origin: https://maximum-trainer.github.io' \
  "$BASE/v1/srtm30m?locations=52.2053,0.1218" | head -20
# expect 200, Access-Control-Allow-Origin echoed, and an elevation of a few metres (Cambridge)
```

## Point the app at it

The app reads the base URL at build time from `VITE_GEO_PROXY_URL`
(`resolveElevationUrl` in `src/lib/services/routeEnrichmentService.ts`).

- **Deployed site:** set a repository *variable* (not a secret) named
  `GEO_PROXY_URL` to the Worker's base URL, then re-run the Pages deploy.
  `.github/workflows/deploy-pages.yml` passes it through.
- **Local:** `VITE_GEO_PROXY_URL=http://localhost:8787 npm run dev` with
  `npm run dev` running in this folder.

Unset, the app behaves exactly as before and asks OpenTopoData directly.

## Adding an origin

Add it to `ALLOWED_ORIGINS` in `src/proxy.ts`, add nothing else, redeploy.
The pre-flight test covers every entry in the list.
