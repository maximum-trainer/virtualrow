/**
 * How the race ghost is drawn (#728 VP-10 FR2).
 *
 * The ghost was a pale translucent cyan hull over teal water: nearly
 * invisible. It now draws the player's own scull GLB (FR1) as a further
 * instance of each primitive, in one saturated lime, flat-lit so it reads
 * the same at dusk as at midday, with a fresnel rim and a 0.7 opacity. Lime
 * is far from the water's hue, brighter than it in every condition, and
 * unlike every fleet hull colour.
 *
 * Past 30 m the boat is small on screen, so a marker with the gap floats
 * over it; `ghostMarker` places it.
 */

import type { Mat4 } from '../math/mat4';

export interface GhostScullStyle {
  /** Linear rgb (over 1 is allowed: flat-lit, it is clipped by tone-mapping), and the tint share. */
  readonly tint: readonly [number, number, number, number];
  readonly alpha: number;
  readonly rim: number;
  readonly flat: number;
}

export const GHOST_SCULL_STYLE: GhostScullStyle = {
  tint: [0.75, 1.25, 0.25, 1],
  alpha: 0.7,
  rim: 0.6,
  flat: 1,
};

/** FR2: the marker shows once the ghost is more than this far away. */
export const GHOST_MARKER_MIN_GAP_M = 30;
/** Height above the ghost's waterline the marker points at, metres. */
const MARKER_HEIGHT_M = 2.5;

export interface GhostMarker {
  /** CSS px from the canvas' top-left. */
  readonly x: number;
  readonly y: number;
  /** Whole metres between the boats. */
  readonly meters: number;
  /** The ghost leads. */
  readonly ahead: boolean;
}

/**
 * Where to draw the ghost's marker, or null when it should not show: the
 * ghost is within 30 m, behind the camera, or off the canvas.
 * `gapMeters` is rower minus ghost, so negative means the ghost leads.
 */
export const ghostMarker = (input: {
  ghostWorld: readonly [number, number, number];
  gapMeters: number;
  viewProj: Mat4;
  width: number;
  height: number;
}): GhostMarker | null => {
  const { ghostWorld, gapMeters, viewProj: m, width, height } = input;
  if (!(Math.abs(gapMeters) > GHOST_MARKER_MIN_GAP_M)) return null;
  const x = ghostWorld[0];
  const y = ghostWorld[1] + MARKER_HEIGHT_M;
  const z = ghostWorld[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!(w > 1e-6)) return null;
  const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
  const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
  if (Math.abs(nx) > 1 || Math.abs(ny) > 1) return null;
  return {
    x: ((nx + 1) / 2) * width,
    y: ((1 - ny) / 2) * height,
    meters: Math.round(Math.abs(gapMeters)),
    ahead: gapMeters < 0,
  };
};
