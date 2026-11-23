/**
 * An off-centre perspective projection for a stage that is partly covered
 * (#733 VP-15).
 *
 * The ride HUD sits over the bottom of the canvas. A centred projection frames
 * the boat for the whole canvas, so the hull, the blades and the wake ended up
 * behind the panels. Here the field of view is fitted to the *clear* rectangle
 * (what the HUD leaves visible) and the frustum is shifted so the camera's
 * look-at point projects to that rectangle's centre. The 3D view still fills
 * the canvas behind the HUD; it is framed as if the canvas were only the
 * clear part.
 *
 * All rectangles are in CSS pixels, y down, origin at the canvas' top-left.
 */

import { mat4Perspective, type Mat4 } from './mat4';

export interface ViewportInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export const NO_INSETS: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The clear rectangle never shrinks below this share of the canvas. */
const MIN_CLEAR_SHARE = 0.2;

const clean = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);

const fit = (a: number, b: number, size: number): [number, number] => {
  const minClear = size * MIN_CLEAR_SHARE;
  const total = a + b;
  if (size - total >= minClear || total <= 0) return [a, b];
  const k = (size - minClear) / total;
  return [a * k, b * k];
};

export const hasInsets = (i: ViewportInsets): boolean =>
  clean(i.top) + clean(i.right) + clean(i.bottom) + clean(i.left) > 0;

/** The part of a `width × height` canvas the HUD leaves visible. */
export const clearRect = (width: number, height: number, insets: ViewportInsets): ScreenRect => {
  const [top, bottom] = fit(clean(insets.top), clean(insets.bottom), height);
  const [left, right] = fit(clean(insets.left), clean(insets.right), width);
  return { left, top, right: width - right, bottom: height - bottom };
};

/**
 * Write the projection into `out`. With no insets this is exactly
 * `mat4Perspective`, so a stage without a HUD draws the same frame as before.
 */
export const projectionWithInsets = (
  out: Mat4,
  fovYRadians: number,
  width: number,
  height: number,
  insets: ViewportInsets,
  near: number,
  far: number,
): Mat4 => {
  if (!hasInsets(insets)) return mat4Perspective(out, fovYRadians, width / height, near, far);
  const r = clearRect(width, height, insets);
  const clearH = r.bottom - r.top;
  const fy = (1 / Math.tan(fovYRadians / 2)) * (clearH / height);
  const fx = fy * (height / width);
  // NDC of the clear rectangle's centre (y up).
  const cx = (r.left + r.right) / width - 1;
  const cy = 1 - (r.top + r.bottom) / height;
  mat4Perspective(out, fovYRadians, width / height, near, far);
  out[0] = fx;
  out[5] = fy;
  // w = -z, so a view-axis point lands at ndc = -out[8], -out[9].
  out[8] = -cx;
  out[9] = -cy;
  return out;
};

/**
 * The vertical field of view the whole canvas covers once the clear part
 * spans `fovYRadians`. Shadow cascades fit this so nothing visible behind a
 * translucent panel goes unshadowed.
 */
export const effectiveFovY = (fovYRadians: number, height: number, insets: ViewportInsets): number => {
  if (!hasInsets(insets)) return fovYRadians;
  const r = clearRect(1, height, insets);
  return 2 * Math.atan(Math.tan(fovYRadians / 2) * (height / (r.bottom - r.top)));
};

/**
 * The CSS-px box around `points` (world space) as `viewProj` draws them on a
 * `width × height` canvas, or null when any point is behind the camera.
 */
export const projectedBounds = (
  viewProj: Mat4,
  points: readonly (readonly [number, number, number])[],
  width: number,
  height: number,
): ScreenRect | null => {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  const m = viewProj;
  for (const [x, y, z] of points) {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!(w > 1e-6)) return null;
    const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    const ny = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    const sx = ((nx + 1) / 2) * width;
    const sy = ((1 - ny) / 2) * height;
    left = Math.min(left, sx);
    right = Math.max(right, sx);
    top = Math.min(top, sy);
    bottom = Math.max(bottom, sy);
  }
  return points.length ? { left, top, right, bottom } : null;
};
