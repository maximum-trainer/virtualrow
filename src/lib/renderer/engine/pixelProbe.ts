/**
 * #807 — read the engine's presented frame back from the GPU, so the specs'
 * "is the canvas blank?" check (`assertCanvasNotBlank`) does not depend on
 * the browser copying a WebGPU canvas into a 2-D canvas. On Windows + NVIDIA
 * that copy comes back black while the frame on screen is fine.
 *
 * Test mode only: the swap chain is configured with COPY_SRC there, and a
 * spec asks through `__ROWER3D_READ_PIXELS(grid, minBrightness)`. The next
 * frame copies its output texture into a mappable buffer and samples an
 * NxN grid of it, as the canvas helper does.
 */

export interface PixelProbeResult {
  w: number;
  h: number;
  total: number;
  nonBlank: number;
  error?: string;
}

export interface PixelProbe {
  /** True while a request waits for the next frame. */
  readonly pending: boolean;
  request(grid: number, minBrightness: number): Promise<PixelProbeResult>;
  /** Called by the frame with its output texture, after the frame's submit. */
  capture(texture: GPUTexture): void;
}

const BYTES_PER_TEXEL = 4;

/** `copyTextureToBuffer` needs rows padded to a multiple of 256 bytes. */
export const alignedBytesPerRow = (width: number): number =>
  Math.ceil((width * BYTES_PER_TEXEL) / 256) * 256;

/** Sample an NxN grid of 4-byte texels; count those whose first three channels sum ≥ the floor. */
export const samplePixelGrid = (
  bytes: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  grid: number,
  minBrightness: number,
): { total: number; nonBlank: number } => {
  let total = 0;
  let nonBlank = 0;
  for (let yi = 0; yi < grid; yi += 1) {
    for (let xi = 0; xi < grid; xi += 1) {
      const x = Math.floor(((xi + 0.5) / grid) * width);
      const y = Math.floor(((yi + 0.5) / grid) * height);
      const o = y * bytesPerRow + x * BYTES_PER_TEXEL;
      total += 1;
      // RGBA or BGRA: the sum of the colour channels is the same either way.
      if (bytes[o] + bytes[o + 1] + bytes[o + 2] >= minBrightness) nonBlank += 1;
    }
  }
  return { total, nonBlank };
};

export const createPixelProbe = (device: GPUDevice): PixelProbe => {
  let waiting: { grid: number; minBrightness: number; resolve: (r: PixelProbeResult) => void } | null = null;
  return {
    get pending() {
      return waiting !== null;
    },
    request(grid, minBrightness) {
      return new Promise<PixelProbeResult>((resolve) => {
        waiting?.resolve({ w: 0, h: 0, total: 0, nonBlank: 0, error: 'superseded' });
        waiting = { grid, minBrightness, resolve };
      });
    },
    capture(texture) {
      const req = waiting;
      if (!req) return;
      waiting = null;
      const w = texture.width;
      const h = texture.height;
      const bytesPerRow = alignedBytesPerRow(w);
      const buffer = device.createBuffer({
        label: 'pixel-probe',
        size: bytesPerRow * h,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder({ label: 'pixel-probe' });
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: h }, { width: w, height: h });
      device.queue.submit([encoder.finish()]);
      buffer
        .mapAsync(GPUMapMode.READ)
        .then(() => {
          const bytes = new Uint8Array(buffer.getMappedRange().slice(0));
          buffer.unmap();
          req.resolve({ w, h, ...samplePixelGrid(bytes, w, h, bytesPerRow, req.grid, req.minBrightness) });
        })
        .catch((err: unknown) => {
          req.resolve({ w, h, total: 0, nonBlank: 0, error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => buffer.destroy());
    },
  };
};
