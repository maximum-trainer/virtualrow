# Biketerra reference brief

**Style:** procedural flat-shaded palette blocks. No textures, no face
detail, no normal mapping. The rower reads as four solid colour swatches
(suit, skin, hair, shoes) at the /row chase camera distance (~4–8 m).

## Silhouette rules

- The torso is a cuboid; it widens on the shoulder plane and narrows at
  the hip plane. The male/female difference lives entirely in the X
  (lateral) widths of the shoulders and arms.
- The arms sit at shoulder height, slightly forward, as a single
  horizontal strap (one bone, bone index 2). No elbow break — the
  reference draws arms as one piece during the drive, and the engine's
  rower is simplified to match.
- The head is a cube. No neck.
- No visible rigger geometry on the body itself; the scull hull owns
  the rigger as a separate node (`Left/RightRigger`).

## Palette (as of #578)

The engine applies the per-athlete palette through
`sceneryMeshPass.writeColors`. Keep the authored vertex colours neutral
— the baked default stays navy unisuit / dark hair / black shoes, and
the picker tints the suit / shorts / shoes / hair / hat slots on top.

## Proportion bounds (D1-a)

- `torsoX`: 0.14–0.22 (male end wider)
- `armsX`: 0.20–0.32 (male end wider)
- `hipScale`: 0.85–1.15 (female end narrower)

The baker clamps each to its range; the LLM proposes values within
bounds, with the invariant `male.torsoX >= female.torsoX * 1.05`
(enforced by `engineCrewMeshContract.test.ts` AC3).
