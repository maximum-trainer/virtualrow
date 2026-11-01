import { test, expect, type Page } from '../../fixtures/crash-watch';
import { assertCanvasNotBlank } from '../helpers/assertCanvasNotBlank';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  installRideHarness,
  pinTier,
  startDemoRide,
  waitForRideOutcome,
  forceRender,
  readHealth,
  assertWellFormedDecline,
} from '../helpers/engineRide';

/**
 * #588 FR9 / AC9 — engine visual baselines, on the real-GPU runner.
 *
 * Pre-#625 this file froze the React/three.js scene at `(progress=0.31,
 * time=12.5)` via `__ROWER3D_FREEZE` + `__ROWER3D_FORCE_RENDER` and compared
 * SwiftShader PNGs. The WebGPU engine declines software adapters (#542 NFR5)
 * so none of that works any more; the port here drives the real `/row` flow
 * through `installRideHarness` + `startDemoRide`, pins the tier, lets the
 * scene settle, forces a render, and compares against a committed PNG.
 *
 * Baseline platform (D8-a): the `linux-nvidia-gpu-runner` the engine smokes
 * already run on. A single platform is deliberate — the pre-#625 spec said
 * "a baseline is a picture of one renderer, and the moment two machines
 * record it the suite measures the machines"; that still holds on real
 * hardware. Metal / D3D12 runners are a fleet decision (D7-b/c) and not
 * in scope.
 *
 * The fallback branch mirrors `marketing-screenshots.spec.ts`: when the job
 * lands on a VM without the NVIDIA Vulkan ICD the engine declines, each
 * shot `test.skip`s with a well-formed decline, and no baseline is written.
 * That keeps a routine fleet-VM gap from reading as a visual regression.
 */

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });
test.use({ viewport: null });

/**
 * The DOM that sits over the stage, kept out of the shot. The HUD numbers
 * are a live split and stroke count, so masking them is what makes the
 * baseline about the scene rather than the clock.
 */
const HUD_SELECTORS = [
  '.row-hud-strip',
  '.row-hud-actions',
  '.ghost-picker',
  '.route-info-overlay',
  '.race-callout',
] as const;

/** Desktop + phone — the scene is framed differently at each. */
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
] as const;

/** Both runnable tiers; the engine's post-FX stack is only on at `medium+`. */
const TIERS = ['low', 'medium'] as const;

/**
 * Milliseconds of ride to let elapse before the shutter. Matches the
 * marketing-screenshots default; GLBs, textures and the effect stack settle
 * over several seconds and a shot taken before them is a picture of a
 * half-built world.
 */
const SETTLE_MS = 8_000;

/**
 * Playwright establishes stability by taking the screenshot twice, 100 ms
 * apart, and requiring the pair to match. Each capture is a readback + PNG
 * encode, so the 5 s default runs out mid-capture.
 */
const CAPTURE_TIMEOUT_MS = 30_000;

async function hideOverlays(page: Page): Promise<void> {
  await page.evaluate((selectors) => {
    const style = document.createElement('style');
    style.id = 'visual-baseline-hide';
    style.textContent = `${selectors.join(',\n')} { display: none !important; }`;
    document.head.appendChild(style);
  }, [...HUD_SELECTORS]);
}

for (const tier of TIERS) {
  for (const { width, height } of VIEWPORTS) {
    test(`willowbrook at ${tier} renders the same scene at ${width}x${height}`, async ({ page }) => {
      test.slow();

      await page.setViewportSize({ width, height });
      await installRideHarness(page);
      await pinTier(page, tier);

      await startDemoRide(page);
      const outcome = await waitForRideOutcome(page, 45_000);

      if (outcome !== 'ready') {
        // No hardware WebGPU adapter on this VM; let the deploy keep the
        // committed baseline rather than reading the fleet gap as a visual
        // regression. Same shape as `marketing-screenshots.spec.ts`.
        await assertWellFormedDecline(page);
        const health = await readHealth(page);
        test.skip(
          true,
          `scene baseline skipped — engine declined (fallback=${health?.fallbackReason ?? 'unknown'})`,
        );
        return;
      }

      const canvas = page.locator('.rower3d-canvas-container canvas').first();
      await expect(canvas).toBeVisible({ timeout: 20_000 });
      await expect(canvas).toHaveAttribute('data-backend', 'webgpu');

      const settleStart = Date.now();
      while (Date.now() - settleStart < SETTLE_MS) {
        await forceRender(page);
        await page.waitForTimeout(250);
      }

      await assertCanvasNotBlank(page, canvas);
      await hideOverlays(page);
      await forceRender(page);

      // A perceptual comparison, not an exact one. Even on one GPU the engine
      // is not bit-identical across Chromium builds, and a baseline that fails
      // on a browser bump is a baseline nobody keeps.
      await expect(canvas).toHaveScreenshot(`willowbrook-${tier}-${width}x${height}.png`, {
        maxDiffPixelRatio: 0.01,
        threshold: 0.3,
        animations: 'disabled',
        mask: HUD_SELECTORS.map((selector) => page.locator(selector)),
        timeout: CAPTURE_TIMEOUT_MS,
      });
    });
  }
}
