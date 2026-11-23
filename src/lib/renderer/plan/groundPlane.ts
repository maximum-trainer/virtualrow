/**
 * The land beyond the bank strips.
 *
 * `bankStrip.ts` draws 60 m of ground either side of the water and nothing
 * else did: past that edge the frame was sky. From any camera with height the
 * two outer bank edges converged on the vanishing point and the course read as
 * a canal floating in the air, most obviously on straight lake and sea
 * courses where no bend hides the edge (#725, #755).
 *
 * This is one flat square, camera-relative (the vertex shader adds the
 * camera's XZ), drawn before the bank strips with no depth write and no depth
 * test. That is what makes it safe: it cannot z-fight the water 0.1 m below it
 * at 1 km, cannot hide anything, and needs no per-route build, so a 33 km
 * course costs the same two triangles as a 1 km one.
 *
 * A geographic surface like `bankStrip` / `waterStrip` / `skyDome`, so it is
 * inside the #623 exception for runtime geometry: there is no model here.
 */

import { WATER_SURFACE_Y } from './waterStrip';
import { CAMERA_FAR_M } from '../engine/cameraRange';

/** Same height as the bank strips (`WATER_SURFACE_Y + 0.1`). */
export const GROUND_SURFACE_Y = WATER_SURFACE_Y + 0.1;

/** Half the side of the square. Past the far plane, so the clip never shows. */
export const GROUND_HALF_EXTENT_M = CAMERA_FAR_M * 1.25;

/**
 * Distance at which the land starts and finishes dissolving into the sky
 * colour behind it. Finishes inside the far plane so the clip edge is never
 * seen. `bank.wgsl` carries the same two numbers; `bankGround.test.ts` pins
 * them together.
 */
export const GROUND_HAZE_START_M = 450;
export const GROUND_HAZE_END_M = 1700;

export interface GroundPlaneGeometry {
  /** x, y, z per vertex; x and z are offsets from the camera. */
  positions: Float32Array;
  indices: Uint16Array;
}

export const buildGroundPlane = (
  halfExtent: number = GROUND_HALF_EXTENT_M,
): GroundPlaneGeometry => {
  const e = halfExtent;
  const y = GROUND_SURFACE_Y;
  return {
    positions: new Float32Array([
      -e, y, -e,
      e, y, -e,
      e, y, e,
      -e, y, e,
    ]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
};
