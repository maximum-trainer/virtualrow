# exr-game rowing reference brief

**Style:** chunky arcade proportions. Slightly more polygons on the
torso and shoulders than biketerra; visible shoulder caps as separate
cuboids above the arms strap; a slightly oversized head for a mascot
feel.

## Silhouette rules

- Shoulder caps are small cuboids riding on top of the arms strap
  (same bone, index 2). They widen the shoulder plane without extending
  the arm's X reach.
- The head stays a cube but at ~1.15× the biketerra size, so a reader
  can parse the rower's orientation at a glance.
- Palette blocks stay flat-shaded (no gradient).

## Proportion bounds

Same as biketerra (`torsoX`, `armsX`, `hipScale`). The exr-game variant
usually pushes the male end of `armsX` toward 0.30+ for the bigger
shoulder cap, and the female end stays near 0.235.

## When to pick this over biketerra

Use the exr-game brief when the engine's silhouette starts reading as
too thin at the /row chase distance. Biketerra's slimmer shoulders are
the default; exr-game is the "beef it up" fallback.
