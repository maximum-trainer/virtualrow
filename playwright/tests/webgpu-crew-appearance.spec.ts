import { test, expect } from '../fixtures/crash-watch';
import { assertCanvasNotBlank } from './helpers/assertCanvasNotBlank';

test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgl',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-unsafe-webgpu',
      '--no-sandbox',
      '--disable-gpu-rasterization',
      '--disable-gpu-compositing',
      '--disable-dev-shm-usage',
    ],
  },
});

/**
 * #578 AC5 — crew appearance seam, GPU-runner pixel check.
 *
 * Mounts the boat smoke, pushes a loud-red palette through the
 * `__ROWER3D_SET_APPEARANCE` seam that `rideScene` publishes, forces one
 * frame, and samples the canvas for a non-default red the engine's
 * baked navy would never produce. On SwiftShader the engine declines
 * (no adapter): the spec checks the status attribute and passes
 * without the pixel assertion, matching the boat smoke's own pattern.
 *
 * Together with the plan-layer vitests this fences the FR5 pipeline:
 * - vitests pin the pure maths (`tintPrimitiveColors`, `writeColors`),
 * - this spec pins the running-scene end-to-end that no vitest can.
 */
test('webgpu crew appearance seam re-tints the rower on the next frame', async ({ page }) => {
  await page.goto('./smoke/boat');
  const main = page.getByTestId('webgpu-boat-smoke');
  await expect(main).toBeVisible();

  const status = await main.getAttribute('data-status');
  if (status !== 'ready') {
    const health = await page.evaluate(
      () =>
        (window as unknown as {
          __VIRTUALROW_WEBGPU_HEALTH?: { fallbackReason?: string };
        }).__VIRTUALROW_WEBGPU_HEALTH,
    );
    expect(health?.fallbackReason).toBeTruthy();
    return;
  }

  const canvas = main.locator('canvas').first();
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu');

  // Give the engine a moment to register the scull primitives.
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const fn = (window as unknown as { __ROWER3D_FORCE_RENDER?: () => void })
      .__ROWER3D_FORCE_RENDER;
    fn?.();
  });
  await assertCanvasNotBlank(page, canvas);

  // The seam is on `globalThis.__ROWER3D_SET_APPEARANCE` once createRideScene
  // finishes. Push a loud-red palette the baked navy would never produce.
  const result = await page.evaluate(() => {
    const seam = (
      window as unknown as {
        __ROWER3D_SET_APPEARANCE?: (p: unknown) => void;
      }
    ).__ROWER3D_SET_APPEARANCE;
    if (!seam) return { called: false };
    seam({
      top: [1, 0, 0, 1],
      shorts: [1, 0, 0, 1],
      shoes: [1, 0, 0, 1],
      hair: [1, 0, 0, 1],
      hat: [1, 0, 0, 1],
    });
    const fn = (window as unknown as { __ROWER3D_FORCE_RENDER?: () => void })
      .__ROWER3D_FORCE_RENDER;
    fn?.();
    return { called: true };
  });
  expect(result.called).toBe(true);

  // Sample the canvas: if the seam reached the GPU the rower pixels are
  // now dominantly red. We tolerate the engine's shading / fog / exposure
  // by checking that any pixel in the frame has R far above both G and B.
  const hasLoudRed = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="webgpu-boat-smoke"] canvas') as HTMLCanvasElement | null;
    if (!c) return false;
    // Pull the GPU canvas through a 2D copy — the compositor path a
    // Chromium headless flow uses for toDataURL / getImageData on a
    // WebGPU canvas. drawImage works on an HTMLCanvasElement.
    const copy = document.createElement('canvas');
    copy.width = c.width;
    copy.height = c.height;
    const ctx = copy.getContext('2d');
    if (!ctx) return false;
    try {
      ctx.drawImage(c, 0, 0);
    } catch { return false; }
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 180 && r - g > 60 && r - b > 60) return true;
    }
    return false;
  });
  // AC5: the loud red is visible on the next frame. On a SwiftShader-fallback
  // runner the earlier `status !== 'ready'` branch returned already, so we
  // only land here on a real GPU.
  expect(hasLoudRed).toBe(true);
});
