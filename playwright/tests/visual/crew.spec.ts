import { test, expect, type Page } from '../../fixtures/crash-watch';
import { assertCanvasNotBlank } from '../helpers/assertCanvasNotBlank';
import {
  installRideHarness,
  pinTier,
  startDemoRide,
  waitForRideOutcome,
  forceRender,
  readHealth,
  assertWellFormedDecline,
} from '../helpers/engineRide';

/**
 * #672 Phase 3 / AC6 — visual baselines for the high-definition rower.
 *
 * One committed PNG per crew (male, female) per camera view (chase, bow), so a
 * regenerate of `scripts/crew_body.py` that changes how the rower looks shows
 * up as a diff rather than as a surprise on the next ride. Chase is the view a
 * ride opens on; bow looks back at the rower's face and hands, which is where
 * the HD body differs most from the placeholder it replaced.
 *
 * Recorded on `linux-nvidia-gpu-runner` with the same launch recipe the
 * marketing shots proved there (#671, agents.md §8 "the three traps"): Chrome
 * Stable rather than the headless shell, the Vulkan WebGPU flags, and headful
 * under Xvfb so the swap chain lands in the screenshot. On a VM without a
 * hardware adapter each shot skips with a well-formed decline, as
 * `scene.spec.ts` does.
 */

test.use({
  channel: 'chrome',
  headless: process.env.VISUAL_HEADFUL === '1' ? false : undefined,
  launchOptions: {
    ...(process.env.PW_LOCAL_CHROME ? { executablePath: process.env.PW_LOCAL_CHROME } : {}),
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=vulkan',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  },
  viewport: null,
});

const CREW_STORAGE_KEY = 'virtualrow:crew';
const CAMERA_VIEW_STORAGE_KEY = 'virtualrow:camera-view';

const CREWS = ['male', 'female'] as const;
const VIEWS = ['chase', 'bow'] as const;

/** The DOM over the stage. Same list as `scene.spec.ts`: the HUD is a live clock. */
const HUD_SELECTORS = [
  '.row-hud-strip',
  '.row-hud-actions',
  '.ghost-picker',
  '.route-info-overlay',
  '.race-callout',
] as const;

/** Long enough for the crew GLB, textures and post-FX to settle (scene.spec.ts). */
const SETTLE_MS = 8_000;
const CAPTURE_TIMEOUT_MS = 30_000;

async function pinCrewAndView(page: Page, crew: string, view: string): Promise<void> {
  await page.addInitScript(
    ([crewKey, crewValue, viewKey, viewValue]) => {
      try {
        localStorage.setItem(crewKey, crewValue);
        localStorage.setItem(viewKey, viewValue);
      } catch {
        // Private mode: the shot would show the defaults, and the GLB check
        // below fails loudly rather than recording the wrong rower.
      }
    },
    [CREW_STORAGE_KEY, crew, CAMERA_VIEW_STORAGE_KEY, view] as const,
  );
}

async function hideOverlays(page: Page): Promise<void> {
  await page.evaluate((selectors) => {
    const style = document.createElement('style');
    style.id = 'visual-baseline-hide';
    style.textContent = `${selectors.join(',\n')} { display: none !important; }`;
    document.head.appendChild(style);
  }, [...HUD_SELECTORS]);
}

for (const crew of CREWS) {
  for (const view of VIEWS) {
    test(`the ${crew} HD rower looks the same from the ${view} view`, async ({ page }) => {
      test.slow();

      await page.setViewportSize({ width: 1280, height: 720 });
      await installRideHarness(page);
      await pinTier(page, 'medium');
      await pinCrewAndView(page, crew, view);

      // The picked rower is the one in the boat: the engine fetches its GLB.
      // Settled to a boolean so a declined run that never fetches it leaves
      // no unhandled rejection behind.
      const crewGlb = page
        .waitForResponse(
          (res) => res.url().endsWith(`/assets/boat/scull-${crew}.glb`) && res.ok(),
          { timeout: 60_000 },
        )
        .then(
          () => true,
          () => false,
        );

      await startDemoRide(page);
      const outcome = await waitForRideOutcome(page, 45_000);

      if (outcome !== 'ready') {
        await assertWellFormedDecline(page);
        const health = await readHealth(page);
        test.skip(
          true,
          `crew baseline skipped — engine declined (fallback=${health?.fallbackReason ?? 'unknown'})`,
        );
        return;
      }

      expect(await crewGlb, `scull-${crew}.glb is the rower in the boat`).toBe(true);

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

      // Perceptual, as in scene.spec.ts. The stroke is live, so the rower is
      // never in quite the same pose twice; the tolerance has to admit that
      // while still catching a body that has changed shape or colour.
      await expect(canvas).toHaveScreenshot(`crew-${crew}-${view}.png`, {
        maxDiffPixelRatio: 0.02,
        threshold: 0.3,
        animations: 'disabled',
        mask: HUD_SELECTORS.map((selector) => page.locator(selector)),
        timeout: CAPTURE_TIMEOUT_MS,
      });
    });
  }
}
