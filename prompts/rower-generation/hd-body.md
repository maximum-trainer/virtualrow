# HD rower body brief (#672)

The crewed GLBs (`public/assets/boat/scull-{male,female}.glb`) carry a
high-definition rower authored in `scripts/crew_body.py` with the
[llm-cad](https://github.com/MaximumTrainer/llm-cad) design loop: write
CadQuery, render, critique against the references, measure, repeat. Targets:
the MyWhoosh and EXR rowing avatars, at EXR's readable silhouette (D2-a).

## What "HD" means here

- Every segment is a smooth loft through anatomical cross-sections, not a
  primitive: the trunk tapers lats → waist → hips, the upper arm carries a
  biceps belly, the calf bulges behind the shin, the quads sit forward.
- Hands wrap the handle: a palm loft and four curled finger lofts plus a
  thumb under the grip.
- Head: cranium, jaw and chin, brow, nose, lips, ears, eyes. Hair styles and
  hats are shells that clear the cranium, with the hairline high at the brow
  and low at the nape.
- Kit: unisuit over trunk and thighs with a white side stripe, rowing shoes
  with sole and strap on the angled foot plate.
- Male and female share one skeleton solver (catch pose, two-bone IK for arms
  and legs) and differ only by the `MALE` / `FEMALE` proportion tables.

## Rules the generator keeps

- Node names are the slot contract (`crewPalette.ts CREW_SLOT_PATTERNS`):
  `Torso_Spine` / `Torso_Shoulders` (top), `<Side>Thigh` (shorts),
  `<Side>Foot` (shoes), `Hair_<Style>_*`, `Hat_<Style>_*`.
- Deterministic: two runs give byte-identical GLBs.
- Body solids are pre-tessellated at an absolute deflection
  (`BODY_TOLERANCE`), finer than the hull's export tolerance. Trim (stripes,
  bands, soles, eyes) meshes coarser.
- After `node scripts/compress-scenery.mjs`, each crewed GLB is ≤ 450 KB
  (D4-a). `src/__tests__/crewHdBody.test.ts` pins this and the anatomy.

## Regenerate

```bash
python3 -m pip install cadquery trimesh matplotlib
python3 scripts/build_crew.py public/assets/boat assets-src/boat/renders
node scripts/compress-scenery.mjs
```

Organic generation through llm-cad's `gen_ai_mesh` (Meshy) is deliberately not
used: it needs a paid key and is not reproducible from code, which breaks the
byte-identical regenerate.
