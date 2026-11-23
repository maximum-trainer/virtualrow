import { describe, expect, it, vi } from 'vitest';
import { uploadFoliageAtlas } from '../foliageAtlasUpload';

// #729 FR2 — one writeTexture per mip level, every layer at once.
describe('uploadFoliageAtlas (#729 FR2)', () => {
  it('writes each mip level once, covering all the layers', () => {
    const writeTexture = vi.fn();
    const queue = { writeTexture } as unknown as GPUQueue;
    const texture = {} as GPUTexture;
    const atlas = {
      layers: 3,
      mips: [
        { size: 4, pixels: new Uint8Array(4 * 4 * 4 * 3) },
        { size: 2, pixels: new Uint8Array(2 * 2 * 4 * 3) },
        { size: 1, pixels: new Uint8Array(4 * 3) },
      ],
    };
    expect(uploadFoliageAtlas(queue, texture, atlas)).toBe(true);
    expect(writeTexture).toHaveBeenCalledTimes(3);
    expect(writeTexture.mock.calls[1]).toEqual([
      { texture, origin: { x: 0, y: 0, z: 0 }, mipLevel: 1 },
      atlas.mips[1].pixels,
      { bytesPerRow: 8, rowsPerImage: 2 },
      { width: 2, height: 2, depthOrArrayLayers: 3 },
    ]);
  });

  it('skips the upload on a queue without writeTexture (the unit-test mock)', () => {
    expect(uploadFoliageAtlas({} as GPUQueue, {} as GPUTexture, { layers: 1, mips: [] })).toBe(false);
  });
});
