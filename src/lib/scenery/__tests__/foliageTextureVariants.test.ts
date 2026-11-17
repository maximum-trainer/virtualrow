// #686 D1c — the sprite flora atlas carries FOLIAGE_VARIANT_COUNT
// silhouettes per species. `paintFoliage(shape, size, variant)` emits
// a distinct crown silhouette per variant, deterministic for a fixed
// (shape, variant) pair, while staying recognisable as the same
// species.
//
// The checks below verify the pipeline guarantee the engine depends on
// (per-variant pixels differ, same (shape, variant) is byte-stable),
// not a visual claim about the crowns themselves — the hero / docs
// visual baseline round-trip is where "do these look right?" lives.

import { describe, expect, it } from 'vitest';
import {
  FOLIAGE_SHAPES,
  FOLIAGE_VARIANT_COUNT,
  paintFoliage,
  type FoliageShape,
} from '../foliageTexture';

const SIZE = 64;

const hash = (pixels: Uint8ClampedArray): string => {
  // Cheap content-dependent fingerprint — hashing every byte via
  // (acc * 31 + byte) | 0. Two identical buffers produce the same
  // string; any single-pixel change produces a different string.
  let acc = 2166136261 >>> 0;
  for (let i = 0; i < pixels.length; i += 1) {
    acc = Math.imul(acc, 16777619) ^ pixels[i];
  }
  return (acc >>> 0).toString(16);
};

describe('paintFoliage variants (#686 D1c)', () => {
  it('FOLIAGE_VARIANT_COUNT is at least six (Dan: D1c)', () => {
    expect(FOLIAGE_VARIANT_COUNT).toBeGreaterThanOrEqual(6);
  });

  it('variant 0 defaults the parameter so historical callers stay unchanged', () => {
    for (const shape of FOLIAGE_SHAPES) {
      const explicit = paintFoliage(shape, SIZE, 0);
      const defaulted = paintFoliage(shape, SIZE);
      expect(hash(defaulted)).toBe(hash(explicit));
    }
  });

  it.each(FOLIAGE_SHAPES)('%s: all variants produce distinct pixels', (shape: FoliageShape) => {
    const hashes = new Set<string>();
    for (let v = 0; v < FOLIAGE_VARIANT_COUNT; v += 1) {
      hashes.add(hash(paintFoliage(shape, SIZE, v)));
    }
    // Every variant is its own fingerprint.
    expect(hashes.size).toBe(FOLIAGE_VARIANT_COUNT);
  });

  it.each(FOLIAGE_SHAPES)('%s: a given (shape, variant) is byte-stable across calls', (shape: FoliageShape) => {
    for (let v = 0; v < FOLIAGE_VARIANT_COUNT; v += 1) {
      const a = paintFoliage(shape, SIZE, v);
      const b = paintFoliage(shape, SIZE, v);
      expect(hash(a)).toBe(hash(b));
    }
  });

  it('every variant keeps the same trunk column so the silhouette still reads as that species', () => {
    // The trunk is a vertical column drawn from `trunk.top` to the
    // bottom of the texture at TRUNK_LUMA. Variants shouldn't move
    // that geometry — only the crown blobs should jitter — so the
    // bottom-centre pixel stays opaque leaf-grey in every variant.
    const centreX = Math.floor(SIZE / 2);
    const bottomY = SIZE - 2;
    for (const shape of FOLIAGE_SHAPES) {
      for (let v = 0; v < FOLIAGE_VARIANT_COUNT; v += 1) {
        const pixels = paintFoliage(shape, SIZE, v);
        const i = (bottomY * SIZE + centreX) * 4;
        expect(pixels[i + 3], `${shape} v${v}: trunk alpha`).toBe(255);
      }
    }
  });
});
