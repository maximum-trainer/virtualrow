import { test, expect } from '../fixtures/crash-watch';
import { assertCanvasNotBlank } from './helpers/assertCanvasNotBlank';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  installRideHarness,
  pinTier,
  startDemoRide,
  waitForRideOutcome,
  forceRender,
  assertWellFormedDecline,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/**
 * #722 VP-04 — the hull wake and oar splashes used to draw as upright,
 * opaque white discs as tall as the rower: two of them filled the bottom
 * centre of the chase view. The fix lays the wake flat on the water and
 * caps the splash size, so near-white blobs below the boat must be gone.
 *
 * Scenario: no upright white discs
 *   Given a demo row at tier medium frozen 30 s in, chase view
 *   Then no connected near-white (>240,240,240) region taller than 3% of
 *   the canvas height exists below the boat
 *
 * "Below the boat" is the bottom half of the frame: in the chase view the
 * boat sits near the vertical centre, and the sky (which can legitimately
 * be near-white) is above it. Runs on the GPU runner; on a VM without a
 * hardware adapter the engine declines and the spec asserts the fallback.
 */

const ROW_MS = 30_000;
const NEAR_WHITE = 240;
const MAX_REGION_HEIGHT_SHARE = 0.03;

test('the chase view shows no tall near-white wake or splash blobs at medium', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 720 });
  await installRideHarness(page);
  await pinTier(page, 'medium');
  await startDemoRide(page);

  const outcome = await waitForRideOutcome(page, 45_000);
  if (outcome !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }

  const canvas = page.locator('.rower3d-canvas-container canvas').first();
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu');

  const start = Date.now();
  while (Date.now() - start < ROW_MS) {
    await forceRender(page);
    await page.waitForTimeout(250);
  }
  await assertCanvasNotBlank(page, canvas);
  await forceRender(page);

  const result = await canvas.evaluate(
    (el, { nearWhite }) => {
      const c = el as HTMLCanvasElement;
      const w = c.width;
      const h = c.height;
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const ctx = tmp.getContext('2d');
      if (!ctx) return { error: 'no-2d-context', tallest: 0, h };
      ctx.drawImage(c, 0, 0);
      const top = Math.floor(h / 2);
      const rows = h - top;
      const data = ctx.getImageData(0, top, w, rows).data;
      const white = new Uint8Array(w * rows);
      for (let i = 0; i < w * rows; i += 1) {
        const o = i * 4;
        white[i] = data[o] > nearWhite && data[o + 1] > nearWhite && data[o + 2] > nearWhite ? 1 : 0;
      }
      // 4-connected flood fill; track each region's vertical extent.
      const seen = new Uint8Array(w * rows);
      const stack: number[] = [];
      let tallest = 0;
      for (let i = 0; i < white.length; i += 1) {
        if (!white[i] || seen[i]) continue;
        let minY = rows;
        let maxY = -1;
        seen[i] = 1;
        stack.push(i);
        while (stack.length) {
          const p = stack.pop() as number;
          const x = p % w;
          const y = (p - x) / w;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          const next = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < rows - 1 ? p + w : -1];
          for (const n of next) {
            if (n >= 0 && white[n] && !seen[n]) {
              seen[n] = 1;
              stack.push(n);
            }
          }
        }
        tallest = Math.max(tallest, maxY - minY + 1);
      }
      return { error: null, tallest, h };
    },
    { nearWhite: NEAR_WHITE },
  );

  expect(result.error, 'canvas readback').toBeNull();
  console.log(`[wake-foam] tallest near-white region below the boat: ${result.tallest}px of ${result.h}px`);
  expect(result.tallest).toBeLessThanOrEqual(Math.floor(result.h * MAX_REGION_HEIGHT_SHARE));
});
