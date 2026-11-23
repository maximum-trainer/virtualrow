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
  /** #732 FR4: whole-frame sharpness, brightness and fringing (all 0–255 scale). */
  quality?: FrameQuality;
  error?: string;
}

export interface FrameQuality {
  meanLuma: number;
  /** Variance of the 4-neighbour Laplacian of luma: falls as the frame softens. */
  laplacianVariance: number;
  /** 99th percentile of max(|R−G|, |B−G|) over edge pixels (luma gradient ≥ EDGE_GRADIENT). */
  edgeFringe: number;
  edgePixels: number;
}

/** A luma step this large between neighbours marks a silhouette edge (#732). */
export const EDGE_GRADIENT = 24;

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

/**
 * #732 FR4: score a read-back frame. `bgra` says the texture stores blue
 * first (`bgra8unorm`, the usual swap-chain format).
 */
export const frameQuality = (
  bytes: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  bgra: boolean,
): FrameQuality => {
  const r = bgra ? 2 : 0;
  const b = bgra ? 0 : 2;
  const luma = new Float32Array(width * height);
  let sum = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = y * bytesPerRow + x * BYTES_PER_TEXEL;
      const l = 0.2126 * bytes[o + r] + 0.7152 * bytes[o + 1] + 0.0722 * bytes[o + b];
      luma[y * width + x] = l;
      sum += l;
    }
  }
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  const fringe: number[] = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const c = luma[i];
      const lap = luma[i - 1] + luma[i + 1] + luma[i - width] + luma[i + width] - 4 * c;
      lapSum += lap;
      lapSq += lap * lap;
      n += 1;
      const grad = Math.max(Math.abs(luma[i + 1] - luma[i - 1]), Math.abs(luma[i + width] - luma[i - width]));
      if (grad >= EDGE_GRADIENT) {
        const o = y * bytesPerRow + x * BYTES_PER_TEXEL;
        const g = bytes[o + 1];
        fringe.push(Math.max(Math.abs(bytes[o + r] - g), Math.abs(bytes[o + b] - g)));
      }
    }
  }
  const mean = n > 0 ? lapSum / n : 0;
  fringe.sort((p, q) => p - q);
  return {
    meanLuma: width * height > 0 ? sum / (width * height) : 0,
    laplacianVariance: n > 0 ? lapSq / n - mean * mean : 0,
    edgeFringe: fringe.length > 0 ? fringe[Math.min(fringe.length - 1, Math.floor(fringe.length * 0.99))] : 0,
    edgePixels: fringe.length,
  };
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
          req.resolve({
            w,
            h,
            ...samplePixelGrid(bytes, w, h, bytesPerRow, req.grid, req.minBrightness),
            quality: frameQuality(bytes, w, h, bytesPerRow, (texture.format ?? 'bgra8unorm').startsWith('bgra')),
          });
        })
        .catch((err: unknown) => {
          req.resolve({ w, h, total: 0, nonBlank: 0, error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => buffer.destroy());
    },
  };
};
