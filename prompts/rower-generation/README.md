# Rower generation prompt bundle (#590, #672)

> **#672:** the rower the engine draws — `public/assets/boat/scull-{male,female}.glb` —
> is now the high-definition body authored in `scripts/crew_body.py` with the
> llm-cad design loop. See [hd-body.md](hd-body.md) for that brief. The rest of
> this file covers the `shell-*.bin` box bodies, which are only the engine's
> load-failure fallback.

LLM-cad regenerates the two placeholder rower bodies that live at
`public/assets/boat/scull-{male,female}.glb` and bakes them into
`public/assets/boat/shell-{male,female}.bin` via `npm run build:crew`.
The CadQuery scaffold in `scripts/build_crew.py` is deterministic — the
LLM step is scoped to *proportion tuning* and *reference calibration*,
not to authoring geometry from scratch.

## When to regenerate

- The monthly workflow `.github/workflows/llm-cad-rowers.yml` runs on
  the first of every month (or on `workflow_dispatch`), diffs the
  committed bins, and opens a PR labelled `rower-generation` when the
  bodies drift.
- Run locally with `npm run build:crew` after editing
  `scripts/build-boat-mesh.mjs`'s `CREW_VARIANTS` table; both bins
  update in one command.

## Reference styles

Three aesthetic targets, in order of preference for a placeholder:

1. **Biketerra** — flat-shaded palette blocks. Procedural per-material
   pipelines; no textures, no face detail; the body reads as four
   solid colour swatches at the chase-camera distance. **Primary
   target** for #590's placeholder bodies (D4-a).
2. **exr-game rowing** — chunky arcade proportions. Slightly more
   polygons on the torso, visible shoulder caps, bigger head. Fallback
   target for a push toward more geometric richness without lighting.
3. **mywhoosh rowing** — slightly realistic silhouette with muscular
   shading. Hardest to approach at placeholder fidelity; use only
   if the bins start carrying real materials.

See the per-style files in this directory for the LLM-cad brief.

## What the LLM step actually tunes (D1-a)

- `CREW_VARIANTS.male.torsoX`
- `CREW_VARIANTS.female.torsoX`
- `CREW_VARIANTS.male.armsX`, `female.armsX`
- `CREW_VARIANTS.{male,female}.hipScale`

Bounded by `scripts/build-boat-mesh.mjs`'s inline min/max asserts
(torsoX in `[0.14, 0.22]`, armsX in `[0.20, 0.32]`, hipScale in
`[0.85, 1.15]`). The LLM proposes new values that stay in-bounds; the
baker enforces the bounds and the contract test enforces that the
MALE/FEMALE ratio stays ≥ 1.05 (AC3).

## Workflow secret

- `LLM_CAD_MODEL_API_KEY` — shared with #449's scenery workflow (D7-a).
- Workflow permissions: `contents: write` + `pull-requests: write`.
- Secret absent → workflow skips with a step-summary note and succeeds.
