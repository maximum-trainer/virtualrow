# mywhoosh rowing reference brief

**Style:** slightly realistic silhouette with muscular shading.
Hardest to approach at placeholder fidelity because flat-shading
without textures tends to look worse than biketerra's palette blocks
when the body gets more detailed.

## Silhouette rules

- Torso tapers from shoulder to hip rather than reading as a plain
  cuboid. The baker today does this via the `hipScale` factor on the
  torso's Y half-size — a `hipScale < 1` narrows the hip plane.
- The head has a slight neck gap (TORSO bone's Y max < HEAD bone's Y
  min by ~0.02 m) so the rower reads less like a stack of boxes.
- Arms stay a single strap — adding an elbow break here is a geometry
  change outside the LLM step's scope.

## When to pick this over biketerra

Only when the engine starts shipping per-pixel lighting that would
flatter a muscular torso. Until then, biketerra's palette blocks are
the safer target: they tolerate the engine's current lighting without
reading as "almost realistic, but off".

## Proportion bounds

Same as biketerra. The mywhoosh variant usually pushes `hipScale` to
the female end (0.88–0.93) so the taper is visible without blowing
the AC3 ratio.
