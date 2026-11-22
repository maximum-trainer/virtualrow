// #719 VP-01 FR3 — the foliage atlas carries a full mip chain so the
// scenery sprite sampler can honour `mipmapFilter: 'linear'` at
// distance instead of aliasing against the leaf-texture grain.

import { describe, expect, it } from 'vitest';
import { buildFoliageMips } from '../foliageMips';

describe('buildFoliageMips (#719 VP-01 FR3)', () => {
  const rgba = (r: number, g: number, b: number, a: number): Uint8ClampedArray =>
    new Uint8ClampedArray([r, g, b, a]);

  it('produces log2(size) mip levels for a square base image', () => {
    const base = new Uint8ClampedArray(256 * 256 * 4);
    const mips = buildFoliageMips(base, 256);
    // 256 → 128 → 64 → 32 → 16 → 8 → 4 → 2 → 1 = 8 downsampled levels.
    expect(mips.map((m) => m.size)).toEqual([128, 64, 32, 16, 8, 4, 2, 1]);
  });

  it('box-filters a 2×2 solid block to its average', () => {
    const base = new Uint8ClampedArray([
      ...rgba(10, 20, 30, 40),
      ...rgba(50, 60, 70, 80),
      ...rgba(90, 100, 110, 120),
      ...rgba(130, 140, 150, 160),
    ]);
    const mips = buildFoliageMips(base, 2);
    expect(mips).toHaveLength(1);
    expect(mips[0].size).toBe(1);
    // Mean of each channel across the 2×2 input.
    expect(Array.from(mips[0].pixels)).toEqual([70, 80, 90, 100]);
  });

  it('preserves a uniform alpha channel across every mip level', () => {
    const size = 8;
    const base = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < size * size; i += 1) base[i * 4 + 3] = 200;
    const mips = buildFoliageMips(base, size);
    for (const mip of mips) {
      for (let i = 0; i < mip.size * mip.size; i += 1) {
        expect(mip.pixels[i * 4 + 3]).toBe(200);
      }
    }
  });
});
