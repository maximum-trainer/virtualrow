// #686 D1c — the sprite flora fragment shader picks one of
// FOLIAGE_VARIANT_COUNT atlas layers per species using the per-instance
// `tintSeed`. This test pins the shader-side math (the layer formula
// and the variant pick) so a future rewrite that collapses the atlas
// back to one layer per species trips here before the engine starts
// sampling garbage.

import { describe, expect, it } from 'vitest';
import sceneryWgsl from '../scenery.wgsl?raw';
import { FOLIAGE_VARIANT_COUNT } from '../../../scenery/foliageTexture';

describe('scenery.wgsl variant layer pick (#686 D1c)', () => {
  it('picks the variant index from in.tintSeed', () => {
    // Pattern: `u32(floor(in.tintSeed * 6.0))` (or similar literal).
    const m = sceneryWgsl.match(/u32\(floor\(in\.tintSeed \* (\d+(?:\.\d+)?)\)\)/);
    expect(m, 'scenery.wgsl: variantIdx formula not found').not.toBeNull();
    expect(Number(m![1])).toBe(FOLIAGE_VARIANT_COUNT);
  });

  it('computes the atlas layer as species * variantCount + variantIdx', () => {
    // Pattern matches `in.species * 6u + min(variantIdx, 5u)` with the
    // same variant-count literal as the pick above.
    const m = sceneryWgsl.match(/in\.species \* (\d+)u \+ min\(variantIdx, (\d+)u\)/);
    expect(m, 'scenery.wgsl: layer formula not found').not.toBeNull();
    const stride = Number(m![1]);
    const cap = Number(m![2]);
    expect(stride).toBe(FOLIAGE_VARIANT_COUNT);
    expect(cap).toBe(FOLIAGE_VARIANT_COUNT - 1);
  });

  it('samples the atlas with the computed layer, not the species directly', () => {
    // Guard against a regression that re-introduces the old
    // `i32(in.species)` sample while leaving the variant pick dead.
    expect(sceneryWgsl).toMatch(/textureSample\(foliageAtlas, foliageSampler, in\.uv, layer\)/);
    expect(sceneryWgsl).not.toMatch(/textureSample\(foliageAtlas, foliageSampler, in\.uv, i32\(in\.species\)\)/);
  });
});
