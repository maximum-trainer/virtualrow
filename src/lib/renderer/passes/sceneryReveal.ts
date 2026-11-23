/**
 * #726 VP-08 FR3 — the fade-in of a kit model registered mid-ride.
 *
 * A model used to appear at full opacity on the frame its fetch, decode
 * and upload finished, wherever the boat was. Each registered mesh now
 * carries a reveal uniform (`packRevealUniform`), and the fragment stage
 * of `sceneryMesh.wgsl` dithers its instances in over
 * `SCENERY_REVEAL_SECONDS` from that time. `revealAlpha` is the same
 * curve on the CPU, for telemetry and tests.
 *
 * The fade is skipped beyond `SCENERY_VISIBILITY_METRES`, the camera's far
 * plane: nothing out there is drawn, so it needs no fade.
 */

export const SCENERY_REVEAL_SECONDS = 1.5;

/** The ride camera's far plane (`projectionWithInsets(..., 0.1, 2000)`). */
export const SCENERY_VISIBILITY_METRES = 2000;

/** Reveal time for a mesh that should draw fully from its first frame. */
export const ALWAYS_REVEALED = -1e9;

/** Bytes of the per-mesh reveal uniform: {revealTime, fadeSeconds, visibility, pad}. */
export const SCENERY_REVEAL_UNIFORM_BYTES = 16;

export interface RevealOptions {
  fadeSeconds?: number;
  visibilityMetres?: number;
}

/**
 * Opacity of an instance `distanceMetres` from the camera at frame time
 * `now` (seconds), for a mesh revealed at `revealTime`.
 */
export const revealAlpha = (
  now: number,
  revealTime: number,
  distanceMetres: number,
  { fadeSeconds = SCENERY_REVEAL_SECONDS, visibilityMetres = SCENERY_VISIBILITY_METRES }: RevealOptions = {},
): number => {
  if (distanceMetres > visibilityMetres) return 1;
  return Math.min(1, Math.max(0, (now - revealTime) / fadeSeconds));
};

export const packRevealUniform = (revealTime: number, out = new Float32Array(4)): Float32Array => {
  out[0] = revealTime;
  out[1] = SCENERY_REVEAL_SECONDS;
  out[2] = SCENERY_VISIBILITY_METRES;
  out[3] = 0;
  return out;
};
