// #733 VP-15 — the HUD covers the bottom of the stage, so the camera's
// look-at point must land in the middle of what is left, not the middle of
// the canvas, and the vertical field of view must be the clear area's.

import { describe, expect, it } from 'vitest';
import { mat4, mat4Perspective, mat4LookAt, mat4Multiply } from '../mat4';
import { vec3 } from '../vec3';
import {
  NO_INSETS,
  clearRect,
  effectiveFovY,
  projectedBounds,
  projectionWithInsets,
  type ViewportInsets,
} from '../projectionWithInsets';

const FOV = (55 * Math.PI) / 180;

/** Project a view-space point and return CSS-px screen coordinates. */
const toScreen = (proj: Float32Array, p: [number, number, number], w: number, h: number): [number, number] => {
  const cx = proj[0] * p[0] + proj[4] * p[1] + proj[8] * p[2] + proj[12];
  const cy = proj[1] * p[0] + proj[5] * p[1] + proj[9] * p[2] + proj[13];
  const cw = proj[3] * p[0] + proj[7] * p[1] + proj[11] * p[2] + proj[15];
  return [((cx / cw + 1) / 2) * w, ((1 - cy / cw) / 2) * h];
};

describe('projectionWithInsets (#733 FR2)', () => {
  it('is exactly mat4Perspective with no insets, so un-HUDed frames do not move', () => {
    const a = projectionWithInsets(mat4(), FOV, 1280, 720, NO_INSETS, 0.1, 2000);
    const b = mat4Perspective(mat4(), FOV, 1280 / 720, 0.1, 2000);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('puts the look-at axis at the centre of the clear rectangle', () => {
    const insets: ViewportInsets = { top: 40, right: 100, bottom: 320, left: 20 };
    const proj = projectionWithInsets(mat4(), FOV, 1280, 720, insets, 0.1, 2000);
    const [x, y] = toScreen(proj, [0, 0, -10], 1280, 720);
    const r = clearRect(1280, 720, insets);
    expect(x).toBeCloseTo((r.left + r.right) / 2, 3);
    expect(y).toBeCloseTo((r.top + r.bottom) / 2, 3);
  });

  it('spans the base field of view across the clear height, not the whole canvas', () => {
    const insets: ViewportInsets = { top: 0, right: 0, bottom: 300, left: 0 };
    const proj = projectionWithInsets(mat4(), FOV, 1280, 720, insets, 0.1, 2000);
    const t = Math.tan(FOV / 2) * 10;
    const [, yTop] = toScreen(proj, [0, t, -10], 1280, 720);
    const [, yBottom] = toScreen(proj, [0, -t, -10], 1280, 720);
    expect(yTop).toBeCloseTo(0, 3);
    expect(yBottom).toBeCloseTo(720 - 300, 3);
  });

  it('keeps pixels square', () => {
    const insets: ViewportInsets = { top: 0, right: 0, bottom: 300, left: 0 };
    const proj = projectionWithInsets(mat4(), FOV, 1280, 720, insets, 0.1, 2000);
    const [x0, y0] = toScreen(proj, [0, 0, -10], 1280, 720);
    const [x1] = toScreen(proj, [1, 0, -10], 1280, 720);
    const [, y1] = toScreen(proj, [0, 1, -10], 1280, 720);
    expect(x1 - x0).toBeCloseTo(y0 - y1, 3);
  });

  it('ignores insets that would leave less than 20% of the stage', () => {
    const r = clearRect(1000, 500, { top: 0, right: 0, bottom: 480, left: 0 });
    expect(r.bottom - r.top).toBeGreaterThanOrEqual(100);
    const bad = clearRect(1000, 500, { top: Number.NaN, right: -5, bottom: 0, left: 0 });
    expect(bad).toEqual({ left: 0, top: 0, right: 1000, bottom: 500 });
  });

  it('reports the full-canvas field of view the shadows must cover', () => {
    expect(effectiveFovY(FOV, 720, NO_INSETS)).toBeCloseTo(FOV, 9);
    const wide = effectiveFovY(FOV, 720, { top: 0, right: 0, bottom: 360, left: 0 });
    expect(Math.tan(wide / 2)).toBeCloseTo(Math.tan(FOV / 2) * 2, 6);
  });
});

describe('projectedBounds (#733 FR3 telemetry)', () => {
  it('returns the CSS-px box of world points seen by the camera', () => {
    const view = mat4LookAt(mat4(), vec3(0, 0, 10), vec3(0, 0, 0), vec3(0, 1, 0));
    const proj = mat4Perspective(mat4(), FOV, 1, 0.1, 100);
    const vp = mat4Multiply(mat4(), proj, view);
    const b = projectedBounds(vp, [[-1, -1, 0], [1, 1, 0]], 400, 400);
    expect(b).not.toBeNull();
    expect(b!.left).toBeLessThan(200);
    expect(b!.right).toBeGreaterThan(200);
    expect(b!.top).toBeLessThan(200);
    expect(b!.bottom).toBeGreaterThan(200);
    expect(b!.left + b!.right).toBeCloseTo(400, 3);
  });

  it('is null when a point is behind the camera', () => {
    const view = mat4LookAt(mat4(), vec3(0, 0, 10), vec3(0, 0, 0), vec3(0, 1, 0));
    const vp = mat4Multiply(mat4(), mat4Perspective(mat4(), FOV, 1, 0.1, 100), view);
    expect(projectedBounds(vp, [[0, 0, 20]], 400, 400)).toBeNull();
  });
});
