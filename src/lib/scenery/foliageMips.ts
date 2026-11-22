/**
 * CPU mip-chain generator for the foliage leaf atlas (#719 VP-01 FR3).
 *
 * The atlas is painted on the CPU by `paintFoliage`, uploaded layer-by-
 * layer to a `texture_2d_array`, and sampled by the scenery sprite
 * pass. Without a mip chain the sampler can't honour `mipmapFilter:
 * 'linear'`, so distant cards alias/shimmer against the leaf texture's
 * high-frequency grain. A full chain is roughly a third more memory per
 * layer and lets the GPU's 2×2 bilinear fetch stand in for the box
 * filter below at steady camera distance.
 *
 * Kept in TS (not the GPU `generateMips` in `textures.ts`) because the
 * atlas is `2d-array` and the engine's mip pipeline today only writes
 * to a plain 2D texture view. A straight box filter over RGBA rows is
 * cheap at 256² × 18 layers; each halving cuts the work by 4×.
 */

export interface FoliageMip {
  size: number;
  pixels: Uint8ClampedArray;
}

const halve = (n: number): number => Math.max(1, Math.floor(n / 2));

/**
 * Box-filter one 2×2 block of RGBA pixels down to a single destination
 * texel. Mirrors the GPU's bilinear fetch closely enough that the
 * sampled result at a non-base mip looks continuous with the base.
 */
const boxFilterStep = (src: Uint8ClampedArray, srcSize: number): FoliageMip => {
  const dstSize = halve(srcSize);
  const dst = new Uint8ClampedArray(dstSize * dstSize * 4);
  for (let y = 0; y < dstSize; y += 1) {
    const sy0 = y * 2;
    const sy1 = Math.min(srcSize - 1, sy0 + 1);
    for (let x = 0; x < dstSize; x += 1) {
      const sx0 = x * 2;
      const sx1 = Math.min(srcSize - 1, sx0 + 1);
      const i00 = (sy0 * srcSize + sx0) * 4;
      const i01 = (sy0 * srcSize + sx1) * 4;
      const i10 = (sy1 * srcSize + sx0) * 4;
      const i11 = (sy1 * srcSize + sx1) * 4;
      const o = (y * dstSize + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        dst[o + c] = Math.round((src[i00 + c] + src[i01 + c] + src[i10 + c] + src[i11 + c]) / 4);
      }
    }
  }
  return { size: dstSize, pixels: dst };
};

/**
 * Build mip levels 1..N for a square RGBA image. Level 0 (the base) is
 * the caller's own `pixels` and is NOT returned, so the caller stays
 * responsible for uploading it.
 *
 * `size` must be a power of two; the engine's foliage atlas is always
 * 256². Smaller atlases are a test convenience.
 */
export const buildFoliageMips = (
  base: Uint8ClampedArray,
  size: number,
): ReadonlyArray<FoliageMip> => {
  const mips: FoliageMip[] = [];
  let src = base;
  let srcSize = size;
  while (srcSize > 1) {
    const next = boxFilterStep(src, srcSize);
    mips.push(next);
    src = next.pixels;
    srcSize = next.size;
  }
  return mips;
};
