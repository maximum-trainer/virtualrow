// #728 VP-10 FR2 — the race ghost: one dark green hull with a lime rim,
// dark enough to stand off the water in every light, and a marker over it
// once it is more than 30 m away. Dan chose a near-solid ghost over FR2's
// 0.55–0.7 see-through range (2026-11-22): at 0.7 even white tops out near
// 2.75:1 over the water as a real GPU draws it.

import { describe, expect, it } from 'vitest';
import { mat4, mat4LookAt, mat4Multiply, mat4Perspective } from '../../math/mat4';
import { vec3 } from '../../math/vec3';
import { FLEET_HULL_PALETTE } from '../../engine/fleet';
import { GHOST_MARKER_MIN_GAP_M, GHOST_SCULL_STYLE, ghostMarker } from '../ghostStyle';

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** WCAG relative luminance of a linear RGB colour. */
const luminance = ([r, g, b]: readonly number[]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe('GHOST_SCULL_STYLE', () => {
  it('is solid, with a rim, out of the haze, and holds its colour in any light', () => {
    // Solid: at 0.95 the 5% of water showing through lifted the hull
    // enough to miss 3:1 over dusk water.
    expect(GHOST_SCULL_STYLE.alpha).toBe(1);
    expect(GHOST_SCULL_STYLE.rim).toBeGreaterThan(0);
    // A thin edge, not a glow: on Dan's laptop a 0.6 rim at fresnel^2 lit
    // the hull's sides to sRGB ~[50,106,61], about 2:1 against the water.
    expect(GHOST_SCULL_STYLE.rim).toBeLessThanOrEqual(0.4);
    expect(GHOST_SCULL_STYLE.flat).toBeGreaterThanOrEqual(0.8);
    expect(GHOST_SCULL_STYLE.haze).toBe(0);
    // The whole boat, crew included, takes the tint.
    expect(GHOST_SCULL_STYLE.tint[3]).toBe(1);
  });

  it('is a dark green, unlike any fleet hull', () => {
    const [r, g, b] = GHOST_SCULL_STYLE.tint;
    expect(g).toBe(Math.max(r, g, b));
    expect(luminance([r, g, b])).toBeLessThanOrEqual(0.02);
    const max = Math.max(r, g, b);
    for (const c of FLEET_HULL_PALETTE) {
      expect(Math.hypot(r / max - c[0], g / max - c[1], b / max - c[2])).toBeGreaterThan(0.35);
    }
  });

  // The engine's tone-mapping tops out near sRGB 202 grey, so on midday
  // water a pale ghost peaks at ~2.3:1 (Dan's laptop, 2026-11-22). A dark
  // hull clears 3:1 against the water of every preset as that GPU drew it.
  it.each([
    ['dawn', [93, 167, 186]],
    ['midday', [56, 140, 169]],
    ['golden', [94, 150, 156]],
    ['overcast', [116, 182, 194]],
    ['dusk', [72, 144, 171]],
    // The darkest dusk water a held frame measured (2026-11-22).
    ['dusk, held', [47, 120, 159]],
  ])('stands off the %s water by at least 3:1 at its opacity, before its rim', (_name, srgb) => {
    const water = (srgb as number[]).map((c) => srgbToLinear(c / 255));
    const a = GHOST_SCULL_STYLE.alpha;
    const ghost = GHOST_SCULL_STYLE.tint.slice(0, 3).map((c, i) => a * c + (1 - a) * water[i]);
    const ratio = (luminance(water) + 0.05) / (luminance(ghost) + 0.05);
    // Margin for the rim and the exposure lift the GPU frames show.
    expect(ratio).toBeGreaterThanOrEqual(3.5);
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
