# Asset licences and attribution

Every 3D model and texture shipped under `public/assets/` is listed here by
folder (#890 AC11, #891 AC3). `src/__tests__/sceneryKitGates.test.ts` fails
when a `.glb` lands in a folder this file does not cover, so a new
third-party model cannot ship without its licence row.

Allowed licences for new third-party assets: CC0 or CC-BY, with the author
credited here (#890 D6). Never CC-BY-SA.

## Own work

Authored for virtualrow from CadQuery source in `assets-src/`, built by the
scripts named, and released under the same terms as this repository.

| Path | What | Built by |
|---|---|---|
| `public/assets/scenery/tier-a/` | Rowing course furniture | `scripts/build_scenery.py` |
| `public/assets/scenery/tier-b/` | Water-edge structures | `scripts/build_scenery.py` |
| `public/assets/scenery/tier-c/` | Crossings | `scripts/build_scenery.py` |
| `public/assets/scenery/tier-d/` | Regional architecture | `scripts/build_scenery.py` |
| `public/assets/scenery/tier-e/` | Vegetation | `scripts/build_scenery.py` |
| `public/assets/scenery/tier-f/` | Generic biome kit | `scripts/build_scenery.py` |
| `public/assets/scenery/tier-g/` | Additional archetypes | `scripts/build_scenery.py` |
| `public/assets/scenery/tier-l/` | Liveried landmark heroes | `scripts/build_scenery.py` |
| `public/assets/boat/` | Sculls and crew | `scripts/build_crew.py` |
| `public/assets/flora/` | Leaf atlas, drawn procedurally | `scripts/build-flora-atlas.mjs` |

## Third party

| Path | Source | Licence | Credit |
|---|---|---|---|
| `public/assets/basis/` | Basis Universal transcoder | Apache-2.0 | Binomial LLC |
| `public/assets/basemap/` | Natural Earth land outlines | Public domain | Natural Earth |
