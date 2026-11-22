// #728 VP-10 FR2 — the race ghost: one saturated tint with a rim, 0.55–0.7
// opaque, bright enough to stand off the water in every light, and a
// marker over it once it is more than 30 m away.

import { describe, expect, it } from 'vitest';
import { mat4, mat4LookAt, mat4Multiply, mat4Perspective } from '../../math/mat4';
import { vec3 } from '../../math/vec3';
import { FLEET_HULL_PALETTE } from '../../engine/fleet';
import { GHOST_MARKER_MIN_GAP_M, GHOST_SCULL_STYLE, ghostMarker } from '../ghostStyle';

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** WCAG relative luminance of a linear RGB colour. */
const luminance = ([r, g, b]: readonly number[]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe('GHOST_SCULL_STYLE', () => {
  it('is translucent between 0.55 and 0.7, with a rim, and holds its colour in any light', () => {
    expect(GHOST_SCULL_STYLE.alpha).toBeGreaterThanOrEqual(0.55);
    expect(GHOST_SCULL_STYLE.alpha).toBeLessThanOrEqual(0.7);
    expect(GHOST_SCULL_STYLE.rim).toBeGreaterThan(0);
    expect(GHOST_SCULL_STYLE.flat).toBeGreaterThanOrEqual(0.8);
    // The whole boat, crew included, takes the tint.
    expect(GHOST_SCULL_STYLE.tint[3]).toBe(1);
  });

  it('is one saturated colour, unlike any fleet hull', () => {
    const [r, g, b] = GHOST_SCULL_STYLE.tint;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    expect((max - min) / max).toBeGreaterThan(0.6);
    for (const c of FLEET_HULL_PALETTE) {
      expect(Math.hypot(r / max - c[0], g / max - c[1], b / max - c[2])).toBeGreaterThan(0.35);
    }
  });

  it('stands off teal water by at least 3:1 at its opacity, before its rim (the GPU spec measures real frames)', () => {
    // A mid teal, sRGB (60, 130, 140), as the water reads on screen.
    // The pass blends in linear light, and the display clips at 1.
    const water = [60, 130, 140].map((c) => srgbToLinear(c / 255));
    const a = GHOST_SCULL_STYLE.alpha;
    const ghost = GHOST_SCULL_STYLE.tint.slice(0, 3).map((c, i) => a * Math.min(1, c) + (1 - a) * water[i]);
    const ratio = (luminance(ghost) + 0.05) / (luminance(water) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });
});

describe('ghostMarker', () => {
  const W = 1280;
  const H = 720;
  const viewProj = mat4Multiply(
    mat4(),
    mat4Perspective(mat4(), (55 * Math.PI) / 180, W / H, 0.1, 2000),
    mat4LookAt(mat4(), vec3(0, 3, 8), vec3(0, 0, -20), vec3(0, 1, 0)),
  );

  it('shows nothing while the ghost is within 30 m', () => {
    expect(GHOST_MARKER_MIN_GAP_M).toBe(30);
    expect(ghostMarker({ ghostWorld: [0, 0, -20], gapMeters: 29.9, viewProj, width: W, height: H })).toBeNull();
    expect(ghostMarker({ ghostWorld: [0, 0, -20], gapMeters: -29.9, viewProj, width: W, height: H })).toBeNull();
  });

  it('marks a ghost far ahead at its screen point, above the boat, with the gap', () => {
    const m = ghostMarker({ ghostWorld: [-7, 0, -60], gapMeters: -52.4, viewProj, width: W, height: H });
    expect(m).not.toBeNull();
    expect(m!.x).toBeLessThan(W / 2);
    expect(m!.x).toBeGreaterThan(0);
    expect(m!.y).toBeGreaterThan(0);
    expect(m!.y).toBeLessThan(H / 2);
    expect(m!.meters).toBe(52);
    expect(m!.ahead).toBe(true);
  });

  it('marks a ghost far behind too, while it is still in front of the camera', () => {
    const m = ghostMarker({ ghostWorld: [-7, 0, -40], gapMeters: 35, viewProj, width: W, height: H });
    expect(m?.ahead).toBe(false);
  });

  it('shows nothing for a ghost behind the camera or off screen', () => {
    expect(ghostMarker({ ghostWorld: [0, 0, 60], gapMeters: 60, viewProj, width: W, height: H })).toBeNull();
    expect(ghostMarker({ ghostWorld: [400, 0, -20], gapMeters: -40, viewProj, width: W, height: H })).toBeNull();
  });
});
