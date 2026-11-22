/**
 * TS mirror of the crossed-quad sprite billboard the scenery pass draws
 * (#719 VP-01). The vertex shader in `src/lib/renderer/passes/scenery.wgsl`
 * expands two crossed quads per instance; each quad must map its own
 * in-plane horizontal axis to u in [0, 1] so the leaf atlas is sampled
 * across the whole card, not down a single texel column.
 *
 * Shared with a Vitest spec that walks every vertex index and pins the
 * mapping, plus a shader-grep test that keeps the WGSL formula in step.
 */

export const QUAD_WIDTH = 1.2;

export const QUAD_VERTS: ReadonlyArray<readonly [number, number, number]> = [
  // card A, facing +X: varies along local.x, local.z is 0
  [-0.6, 0.0, 0.0],
  [0.6, 0.0, 0.0],
  [0.6, 1.0, 0.0],
  [-0.6, 1.0, 0.0],
  // card B, facing +Z: varies along local.z, local.x is 0
  [0.0, 0.0, -0.6],
  [0.0, 0.0, 0.6],
  [0.0, 1.0, 0.6],
  [0.0, 1.0, -0.6],
];

export const QUAD_INDICES: ReadonlyArray<number> = [
  0, 1, 2,
  0, 2, 3,
  4, 5, 6,
  4, 6, 7,
];

export interface SpriteQuadUv {
  u: number;
  v: number;
}

/**
 * The UV for a crossed-quad billboard sprite vertex. Mirrors the
 * expression in `scenery.wgsl`'s `vs_main`: the per-vertex local offset
 * is pulled from `QUAD_VERTS` via `QUAD_INDICES[vi]`, then the varying
 * horizontal axis (local.x for quad 0, local.z for quad 1) is remapped
 * to u in [0, 1] about the card's full width and v is `1 - local.y`.
 */
export const spriteQuadUv = (vi: number): SpriteQuadUv => {
  const [x, y, z] = QUAD_VERTS[QUAD_INDICES[vi]];
  // One of local.x or local.z is 0 for every vertex (see QUAD_VERTS), so
  // their sum collapses to whichever axis the quad actually varies in.
  return { u: (x + z) / QUAD_WIDTH + 0.5, v: 1 - y };
};
