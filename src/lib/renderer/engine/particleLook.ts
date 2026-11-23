/**
 * Shared look of the wake and oar-splash particles (#722 VP-04). Both
 * WGSL passes mirror these numbers; `particleLook.test.ts` checks the
 * mirror so the CPU-side caps and what the GPU draws cannot drift.
 */

import type { Vec3 } from './postFxMath';

/** FR5: a particle this close to the camera is fully transparent. */
export const PARTICLE_NEAR_FADE_START_METRES = 1.5;
/** FR5: a particle this far from the camera is drawn at full alpha. */
export const PARTICLE_NEAR_FADE_END_METRES = 3;

/**
 * FR6: foam is written into the HDR target pre-exposed, at or below this
 * luminance, so bloom's bright-pass (threshold 1.0) never treats it as a
 * light source.
 */
export const FOAM_MAX_LUMINANCE = 0.85;

const FOAM_BASE: Vec3 = [0.8, 0.83, 0.86];
/** How much a high sun warms the red channel. */
const FOAM_SUN_WARM = 0.06;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const particleNearCameraFade = (distanceMetres: number): number =>
  smoothstep(PARTICLE_NEAR_FADE_START_METRES, PARTICLE_NEAR_FADE_END_METRES, distanceMetres);

/** Foam colour for a sun with the given normalised Y component. */
export const foamColour = (sunDirY: number): Vec3 => [
  FOAM_BASE[0] + Math.max(sunDirY, 0) * FOAM_SUN_WARM,
  FOAM_BASE[1],
  FOAM_BASE[2],
];
