import { describe, expect, it, vi } from 'vitest';
import { mipLevelCountFor, textureBytes, uploadBc7 } from '../engine/textures';

describe('textures', () => {
  it('mipLevelCountFor rounds down log2(max)', () => {
    expect(mipLevelCountFor(1, 1)).toBe(1);
    expect(mipLevelCountFor(512, 512)).toBe(10);
    expect(mipLevelCountFor(512, 256)).toBe(10);
    expect(mipLevelCountFor(1024, 1)).toBe(11);
  });

  it('textureBytes for rgba8unorm-srgb sums rgba bytes per level', () => {
    // 512×512 with full mip chain → sum of 4·w·h.
    const bytes = textureBytes(512, 512, 'rgba8unorm-srgb', 10);
    expect(bytes).toBe(4 * (512 * 512 + 256 * 256 + 128 * 128 + 64 * 64 + 32 * 32 + 16 * 16 + 8 * 8 + 4 * 4 + 2 * 2 + 1));
  });

  it('textureBytes for BC7 sums block layout per level', () => {
    const bytes = textureBytes(512, 512, 'bc7-rgba-unorm-srgb', 10);
    // 512/4 × 512/4 × 16 for level 0 = 65536; chain is 65536, 16384, ...
    let expected = 0;
    let w = 512;
    let h = 512;
    for (let i = 0; i < 10; i += 1) {
      expected += Math.ceil(w / 4) * Math.ceil(h / 4) * 16;
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
    expect(bytes).toBe(expected);
  });

  it('BC7 is roughly ~4× smaller than RGBA8 at matched size (AC3 #562)', () => {
    const rgba = textureBytes(512, 512, 'rgba8unorm-srgb', 10);
    const bc7 = textureBytes(512, 512, 'bc7-rgba-unorm-srgb', 10);
    expect(rgba / bc7).toBeGreaterThan(3.9);
    expect(rgba / bc7).toBeLessThan(4.1);
  });

  // #648: Dawn validation on Chrome 156 / NVIDIA Turing was discarding every
  // uploadBc7 texture because the smallest mips (2×2, 1×1) were being written
  // with a copySize whose width was not a multiple of 4, the BC block size.
  // Each mip must be written with its block-aligned PHYSICAL extent instead.
  it('uploadBc7 writes every mip with block-aligned copySize (regression)', () => {
    (globalThis as unknown as { GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number } }).GPUTextureUsage ??= {
      TEXTURE_BINDING: 4,
      COPY_DST: 8,
    };
    const copySizes: Array<{ width: number; height: number }> = [];
    const device = {
      createTexture: vi.fn().mockReturnValue({ destroy() {}, createView: () => ({}) }),
      queue: {
        writeTexture: vi.fn((_dst, _data, _layout, size) => {
          copySizes.push({ width: size.width, height: size.height });
        }),
      },
    } as unknown as GPUDevice;
    // 8×8 → mips 8, 4, 2, 1. Pre-fix the last two mips were written at
    // {2,2} and {1,1}; post-fix every mip is {4,4}-aligned.
    const mipData = [8, 4, 2, 1].map((px) =>
      new Uint8Array(Math.max(1, Math.ceil(px / 4)) ** 2 * 16),
    );
    uploadBc7(device, 8, 8, mipData);
    expect(copySizes).toEqual([
      { width: 8, height: 8 },
      { width: 4, height: 4 },
      { width: 4, height: 4 },
      { width: 4, height: 4 },
    ]);
    for (const size of copySizes) {
      expect(size.width % 4, `width ${size.width} must be multiple of 4`).toBe(0);
      expect(size.height % 4, `height ${size.height} must be multiple of 4`).toBe(0);
    }
  });
});
