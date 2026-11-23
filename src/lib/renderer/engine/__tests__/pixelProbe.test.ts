// #807 — the engine reads its own presented frame back for the canvas-blank check.
import { describe, expect, it, vi } from 'vitest';
import { alignedBytesPerRow, createPixelProbe, samplePixelGrid } from '../pixelProbe';
import { makeMockDevice } from '../../__tests__/_mockWebGPU';

const image = (w: number, h: number, bytesPerRow: number, lit: (x: number, y: number) => boolean) => {
  const bytes = new Uint8Array(bytesPerRow * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = y * bytesPerRow + x * 4;
      const v = lit(x, y) ? 200 : 0;
      bytes[o] = v; bytes[o + 1] = v; bytes[o + 2] = v; bytes[o + 3] = 255;
    }
  }
  return bytes;
};

describe('alignedBytesPerRow', () => {
  it('pads a row of 4-byte texels up to 256 bytes', () => {
    expect(alignedBytesPerRow(1)).toBe(256);
    expect(alignedBytesPerRow(64)).toBe(256);
    expect(alignedBytesPerRow(65)).toBe(512);
    expect(alignedBytesPerRow(1212)).toBe(4864);
  });
});

describe('samplePixelGrid', () => {
  it('counts the samples above the brightness floor, ignoring alpha and row padding', () => {
    const w = 40;
    const h = 20;
    const bpr = alignedBytesPerRow(w);
    const topHalf = image(w, h, bpr, (_x, y) => y < h / 2);
    expect(samplePixelGrid(topHalf, w, h, bpr, 10, 15)).toEqual({ total: 100, nonBlank: 50 });
    expect(samplePixelGrid(image(w, h, bpr, () => false), w, h, bpr, 10, 15)).toEqual({ total: 100, nonBlank: 0 });
  });
});

describe('createPixelProbe', () => {
  it('copies the frame out, maps it and resolves the sampled counts', async () => {
    const device = makeMockDevice();
    const w = 8;
    const h = 4;
    const bpr = alignedBytesPerRow(w);
    const lit = image(w, h, bpr, () => true);
    const copies: unknown[] = [];
    const realCreate = device.createBuffer.bind(device);
    device.createBuffer = ((desc: GPUBufferDescriptor) => {
      const b = realCreate(desc);
      (b as unknown as { getMappedRange: () => ArrayBuffer }).getMappedRange = () => lit.buffer.slice(0);
      return b;
    }) as typeof device.createBuffer;
    const encoder = device.createCommandEncoder();
    (encoder as unknown as { copyTextureToBuffer: (...a: unknown[]) => void }).copyTextureToBuffer = (...a) => copies.push(a);
    const probe = createPixelProbe(device);
    expect(probe.pending).toBe(false);
    const result = probe.request(4, 15);
    expect(probe.pending).toBe(true);
    probe.capture({ width: w, height: h } as GPUTexture);
    expect(copies).toHaveLength(1);
    expect(probe.pending).toBe(false);
    await expect(result).resolves.toEqual({ w, h, total: 16, nonBlank: 16 });
  });

  it('reports a failed map instead of hanging', async () => {
    const device = makeMockDevice();
    const realCreate = device.createBuffer.bind(device);
    device.createBuffer = ((desc: GPUBufferDescriptor) => {
      const b = realCreate(desc);
      (b as unknown as { mapAsync: () => Promise<void> }).mapAsync = vi.fn(() => Promise.reject(new Error('lost')));
      return b;
    }) as typeof device.createBuffer;
    (device.createCommandEncoder() as unknown as { copyTextureToBuffer: () => void }).copyTextureToBuffer = () => undefined;
    const probe = createPixelProbe(device);
    const result = probe.request(4, 15);
    probe.capture({ width: 4, height: 4 } as GPUTexture);
    await expect(result).resolves.toEqual({ w: 4, h: 4, total: 0, nonBlank: 0, error: 'lost' });
  });
});
