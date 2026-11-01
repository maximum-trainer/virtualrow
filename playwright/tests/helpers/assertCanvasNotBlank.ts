import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Assert the WebGPU engine actually drew something to the canvas.
 *
 * The existing smoke specs assert `data-backend="webgpu"` and that the frame
 * counter advances on `__ROWER3D_FORCE_RENDER()`. Both of those passed while
 * the canvas rendered pure black (#549 regression): the engine attached, the
 * frame loop ran, `queue.submit` was called every frame, but every lit pass
 * failed WebGPU validation on bind-group size (`frame-uniforms` was 256 B,
 * the WGSL `Frame` struct needed 272 B). Chromium discards every invalid
 * command buffer silently and the swap-chain comes out all zeros.
 *
 * This helper closes that gap. After the frame loop has driven at least one
 * draw, it reads back the canvas pixels into a 2-D canvas (same-origin, so
 * `drawImage` + `getImageData` are allowed) and asserts a minimum share of
 * sampled pixels are above a brightness floor. Not every pixel — a scene
 * can legitimately be dim at the edges — but black-everywhere trips it.
 *
 * Only called when the engine has reported ready (`backend === 'webgpu'`),
 * never on the fallback path where no WebGPU adapter is available.
 */

export interface AssertCanvasNotBlankOptions {
  /**
   * Fraction of sampled pixels that must have R+G+B above the floor.
   * Default 0.2 (20 %) — generous so a mostly-dark but non-black scene
   * (e.g. the postfx smoke with an unlit test rig) still passes.
   */
  minNonBlankShare?: number;
  /** Minimum R+G+B sum (0..765) to count a pixel as non-blank. Default 15. */
  minBrightness?: number;
  /** Sample grid resolution (NxN). Default 20 → 400 samples. */
  gridSize?: number;
}

export async function assertCanvasNotBlank(
  page: Page,
  canvas: Locator,
  opts: AssertCanvasNotBlankOptions = {},
): Promise<void> {
  const minShare = opts.minNonBlankShare ?? 0.2;
  const minBrightness = opts.minBrightness ?? 15;
  const grid = opts.gridSize ?? 20;

  // Drive one more render so the swap-chain holds a presented frame at the
  // moment we read it back; without this the readback can race the present.
  await page.evaluate(() =>
    (window as unknown as { __ROWER3D_FORCE_RENDER?: () => void }).__ROWER3D_FORCE_RENDER?.(),
  );

  const sampled = await canvas.evaluate(
    (el, { grid: g, minBrightness: mb }) => {
      const c = el as HTMLCanvasElement;
      const w = c.width;
      const h = c.height;
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const ctx = tmp.getContext('2d');
      if (!ctx) return { total: 0, nonBlank: 0, w, h, error: 'no-2d-context' as const };
      try {
        ctx.drawImage(c, 0, 0);
      } catch (err) {
        return {
          total: 0,
          nonBlank: 0,
          w,
          h,
          error: (err instanceof Error ? err.message : String(err)) as string,
        };
      }
      let total = 0;
      let nonBlank = 0;
      for (let yi = 0; yi < g; yi += 1) {
        for (let xi = 0; xi < g; xi += 1) {
          const x = Math.floor(((xi + 0.5) / g) * w);
          const y = Math.floor(((yi + 0.5) / g) * h);
          const d = ctx.getImageData(x, y, 1, 1).data;
          total += 1;
          if (d[0] + d[1] + d[2] >= mb) nonBlank += 1;
        }
      }
      return { total, nonBlank, w, h };
    },
    { grid, minBrightness },
  );

  expect(sampled, 'canvas readback should succeed').toMatchObject({ error: undefined });
  const share = sampled.total === 0 ? 0 : sampled.nonBlank / sampled.total;
  expect(
    share,
    `expected ≥${(minShare * 100).toFixed(0)}% of ${sampled.total} sampled pixels to be ` +
      `non-black (R+G+B ≥ ${minBrightness}); got ${sampled.nonBlank}/${sampled.total}. ` +
      `Canvas ${sampled.w}×${sampled.h}. A black canvas means lit passes submitted ` +
      `invalid command buffers (see helper comment).`,
  ).toBeGreaterThanOrEqual(minShare);
}

/**
 * #588 FR7 / AC7 — per-region pixel probe.
 *
 * `assertCanvasNotBlank` samples the whole canvas and passes a frame
 * that is pure sky top-to-bottom. The chase-camera scene has sky at
 * the top, water in the middle band, and the boat near the bottom —
 * a drop of the water pass or the boat pass passes the non-blank test
 * because sky alone saturates it. This helper walks a named set of
 * rectangles and asserts each one has at least one non-blank sample,
 * so a seeded "clear to sky" scene fails on `water` and `boat` while
 * `sky` still passes.
 */
export interface CanvasRegion {
  /** Fractional rect in [0, 1]^2 — `{x0, y0, x1, y1}`. */
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** Minimum fraction of samples in the region that must be non-blank. */
  readonly minNonBlankShare?: number;
}

export interface SamplePerRegionOptions {
  /** Minimum R+G+B sum to count a pixel as non-blank. Default 15. */
  minBrightness?: number;
  /** Sample grid per region (NxN). Default 8 → 64 samples/region. */
  gridSize?: number;
}

/**
 * The engine's default chase-camera framing. Captures the three regions
 * a dropped pass would stop filling.
 */
export const DEFAULT_CHASE_REGIONS: Record<string, CanvasRegion> = {
  sky: { x0: 0.2, y0: 0.0, x1: 0.8, y1: 0.35, minNonBlankShare: 0.6 },
  water: { x0: 0.1, y0: 0.55, x1: 0.9, y1: 0.9, minNonBlankShare: 0.3 },
  boat: { x0: 0.35, y0: 0.5, x1: 0.65, y1: 0.95, minNonBlankShare: 0.15 },
};

export async function samplePerRegion(
  page: Page,
  canvas: Locator,
  regions: Record<string, CanvasRegion> = DEFAULT_CHASE_REGIONS,
  opts: SamplePerRegionOptions = {},
): Promise<void> {
  const minBrightness = opts.minBrightness ?? 15;
  const grid = opts.gridSize ?? 8;

  await page.evaluate(() =>
    (window as unknown as { __ROWER3D_FORCE_RENDER?: () => void }).__ROWER3D_FORCE_RENDER?.(),
  );

  const samples = await canvas.evaluate(
    (el, { regionList, grid: g, minBrightness: mb }) => {
      const c = el as HTMLCanvasElement;
      const w = c.width;
      const h = c.height;
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const ctx = tmp.getContext('2d');
      if (!ctx) return { error: 'no-2d-context' as const, regions: {} };
      try {
        ctx.drawImage(c, 0, 0);
      } catch (err) {
        return {
          error: (err instanceof Error ? err.message : String(err)) as string,
          regions: {},
        };
      }
      const out: Record<string, { total: number; nonBlank: number }> = {};
      for (const [name, r] of regionList) {
        let total = 0;
        let nonBlank = 0;
        for (let yi = 0; yi < g; yi += 1) {
          for (let xi = 0; xi < g; xi += 1) {
            const fx = r.x0 + ((xi + 0.5) / g) * (r.x1 - r.x0);
            const fy = r.y0 + ((yi + 0.5) / g) * (r.y1 - r.y0);
            const x = Math.min(w - 1, Math.max(0, Math.floor(fx * w)));
            const y = Math.min(h - 1, Math.max(0, Math.floor(fy * h)));
            const d = ctx.getImageData(x, y, 1, 1).data;
            total += 1;
            if (d[0] + d[1] + d[2] >= mb) nonBlank += 1;
          }
        }
        out[name] = { total, nonBlank };
      }
      return { regions: out };
    },
    { regionList: Object.entries(regions), grid, minBrightness },
  );

  expect(samples, 'canvas readback should succeed').toMatchObject({ error: undefined });
  const regionCounts = samples.regions as Record<string, { total: number; nonBlank: number }>;
  for (const [name, region] of Object.entries(regions)) {
    const s = regionCounts[name];
    const minShare = region.minNonBlankShare ?? 0.2;
    const share = s.total === 0 ? 0 : s.nonBlank / s.total;
    expect(
      share,
      `region "${name}": expected ≥${(minShare * 100).toFixed(0)}% of ${s.total} ` +
        `samples to be non-black; got ${s.nonBlank}/${s.total}. A failure here ` +
        `with the whole-canvas probe passing means the pass that fills this ` +
        `region (sky / water / boat / …) stopped drawing.`,
    ).toBeGreaterThanOrEqual(minShare);
  }
}
