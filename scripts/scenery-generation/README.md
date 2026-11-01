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

## Local reproduce

```
node scripts/scenery-generation/run.mjs --course-id <id> --out <dir> [--dry-run]
```

Mirrors what the workflow does for one course without opening a PR
(FR10/AC11). Reads `LLM_CAD_MODEL_API_KEY` from the environment when
present; without it the harness still processes a stubbed GLB so the
local run stays testable.
