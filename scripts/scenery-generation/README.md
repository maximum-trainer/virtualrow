# Scenery generation (#449)

Monthly workflow regenerates route-specific scenery via llm-cad.

- `.github/workflows/scenery-generation.yml` — the scheduled job.
- `processed-courses.json` — the committed snapshot of every rownative
  course already processed. Keyed by course id; each entry records the
  course SHA at the time of generation.
- `../../public/assets/scenery/route-placements.json` — the single
  source of truth for per-route tier-r scenery (FR6).
- `../../public/assets/scenery/route-placements.schema.json` — JSON
  schema; the parser in `src/lib/scenery/routePlacements.ts` enforces
  the same invariants at load time.

See the scenery kit README beside this file's parent for the generic
kit conventions (`public/assets/scenery/README.md`).

## Which courses a run processes

```
node scripts/scenery-generation/plan.mjs [--max 5] [--dry-run]
```

Loads the rownative index (bundled `public/assets/rownative/rownative-index.json`
when the live one is unreachable) and prints the courses missing from
`processed-courses.json`, or whose course file changed since, in id order and
at most `--max` per run (D3, D5). The workflow runs this on every schedule,
with or without the llm-cad key.

## Generating scenery for courses

```
export LLM_CAD_MODEL_API_KEY=...   # an Anthropic key (sk-ant-...); never printed
git clone https://github.com/MaximumTrainer/llm-cad ../llm-cad && uv sync --directory ../llm-cad
node scripts/scenery-generation/run.mjs --courses "180 277" --llm-cad-dir ../llm-cad \
  [--model claude-opus-5-5] [--summary out.md] [--dry-run]
npm run build:assets               # compress, LOD1s, manifest (D12)
```

The workflow runs exactly this (FR10 / AC11). Per course `run.mjs` fetches the
course JSON from rownative and hashes it, runs `llm-cad generate-course`
(llm-cad#42) with the pinned model and a seed derived from the course id
(FR12), rejects any GLB over 450 KB on disk (the kit gate) or 500 KB gzipped
(NFR2), copies the rest to `public/assets/scenery/tier-r/<id>/`, and merges the
placements into `route-placements.json` and the course into
`processed-courses.json`. A course that produces nothing stays out of the
snapshot, so the next run retries it. An existing GLB that differs from the new
one is kept (D11). It never touches git; `--stub` swaps llm-cad for a
placeholder GLB so the harness runs offline.
