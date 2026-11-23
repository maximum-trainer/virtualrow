/**
 * CSM math tests (#559 FR2). Pins the practical-split formula and the
 * texel-snapped light view-projection shape so later tweaks can't quietly
 * drift the cascades.
 */

import { describe, expect, it } from 'vitest';
import { computeCascades, practicalSplits } from '../cascadedShadows';
import type { Vec3 } from '../../math/vec3';

const vec = (x: number, y: number, z: number): Vec3 =>
  new Float32Array([x, y, z]) as unknown as Vec3;

describe('practicalSplits', () => {
  it('is monotonically increasing and ends at far', () => {
    const splits = practicalSplits(0.5, 500, 3, 0.5);
    expect(splits.length).toBe(3);
    expect(splits[0]).toBeLessThan(splits[1]);
    expect(splits[1]).toBeLessThan(splits[2]);
    expect(splits[2]).toBeCloseTo(500, 2);
  });

  it('lambda=0 gives uniform splits', () => {
    const splits = practicalSplits(1, 401, 4, 0);
    expect(splits[0]).toBeCloseTo(101);
    expect(splits[1]).toBeCloseTo(201);
    expect(splits[2]).toBeCloseTo(301);
    expect(splits[3]).toBeCloseTo(401);
  });

  it('lambda=1 gives logarithmic splits for positive near', () => {
    const splits = practicalSplits(1, 1000, 3, 1);
    expect(splits[0]).toBeCloseTo(10);
    expect(splits[1]).toBeCloseTo(100);
    expect(splits[2]).toBeCloseTo(1000);
  });
});

describe('computeCascades', () => {
  const cfg = {
    cascades: 3,
    near: 0.5,
    far: 500,
    fovY: Math.PI / 3,
    aspect: 16 / 9,
    camPos: vec(0, 2, 0),
    camForward: vec(0, 0, -1),
    camUp: vec(0, 1, 0),
    lightDirection: vec(-0.3, -1, -0.3),
    tileTexels: 1024,
  };

  it('fills requested cascades and zero-pads unused slots', () => {
    const result = computeCascades(cfg);
    expect(result.cascades.length).toBe(4);
    expect(result.splits.length).toBe(3);
    expect(result.cascades[0].radius).toBeGreaterThan(0);
    expect(result.cascades[2].radius).toBeGreaterThan(0);
    expect(result.cascades[3].radius).toBe(0);
  });

  it('splits are monotonically increasing', () => {
    const result = computeCascades(cfg);
    for (let i = 1; i < result.splits.length; i++) {
      expect(result.splits[i]).toBeGreaterThan(result.splits[i - 1]);
    }
  });

  it('clamps cascade count to [1, 4]', () => {
    const over = computeCascades({ ...cfg, cascades: 10 });
    expect(over.splits.length).toBe(4);
    const under = computeCascades({ ...cfg, cascades: 0 });
    expect(under.splits.length).toBe(1);
  });

  it('handles light near vertical without producing NaNs', () => {
    const result = computeCascades({
      ...cfg,
      lightDirection: vec(0, -1, 0.001),
    });
    for (const c of result.cascades) {
      for (const v of c.viewProj) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('texel-snapping stabilises origin under tiny camera shifts', () => {
    const a = computeCascades(cfg);
    const b = computeCascades({
      ...cfg,
      camPos: vec(0.001, 2, 0),
    });
    // Within one texel, the first cascade should be stable or nearly so.
    const dx = Math.abs(a.cascades[0].viewProj[12] - b.cascades[0].viewProj[12]);
    expect(dx).toBeLessThan(0.5);
  });

  // WebGPU clip space has z in [0, 1]; anything outside is clipped. A
  // GL-style [-1, 1] light projection silently drops the near half of the
  // light volume from the shadow map, and every caster in the far half then
  // shadows itself. Found when the ground plane (not a caster) came out twice
  // as bright as the bank strip (a caster) at the same height.
  it('maps the whole light volume, casters above the camera included, into WebGPU depth range [0, 1]', () => {
    const result = computeCascades(cfg);
    const project = (m: Float32Array, x: number, y: number, z: number) =>
      m[2] * x + m[6] * y + m[10] * z + m[14];
    for (let i = 0; i < 3; i++) {
      const m = result.cascades[i].viewProj as unknown as Float32Array;
      const mid = i === 0 ? 5 : result.splits[i - 1] + 1;
      // Ground, eye height, and half a cascade radius up toward the light:
      // a tall tree in a far cascade.
      for (const y of [0, 2, result.cascades[i].radius * 0.5]) {
        const depth = project(m, 0, y, -mid);
        expect(depth).toBeGreaterThanOrEqual(0);
        expect(depth).toBeLessThanOrEqual(1);
      }
      // The ground at the far end of the slice, on the side away from the
      // light: the GL form put this past z = 1 and clipped it.
      const farGround = project(m, 0, 0, -result.splits[i]);
      expect(farGround).toBeGreaterThanOrEqual(0);
      expect(farGround).toBeLessThanOrEqual(1);
    }
  });

  it('puts things nearer the light at a smaller depth', () => {
    const result = computeCascades(cfg);
    const m = result.cascades[0].viewProj as unknown as Float32Array;
    const depth = (y: number) => m[6] * y + m[10] * -5 + m[14];
    expect(depth(10)).toBeLessThan(depth(0));
  });
});
