import { test, expect, type Page } from '../../fixtures/crash-watch';
import * as fs from 'fs';
import * as path from 'path';
import { assertCanvasNotBlank } from '../helpers/assertCanvasNotBlank';
import {
  installRideHarness,
  pinTier,
  startDemoRide,
  waitForRideOutcome,
  forceRender,
  readRenderStats,
  readRideTelemetry,
} from '../helpers/engineRide';
import {
  MARKETING_SHOTS,
  type MarketingShot,
  type MarketingShotReport,
} from '../../visual/marketing-shots';

/**
 * #648 — the marketing screenshots the Pages deploy publishes under `docs/`.
 *
 * This replaces the retired `docs-screenshots.spec.ts`, which was built around
 * React selectors and SwiftShader baselines. Post-WebGPU cutover (#625) the
 * engine declines software adapters, so these only render on a real-GPU
 * runner; this spec lives inside the `regen-marketing-shots.yml` workflow run
 * on `linux-nvidia-gpu-runner` and never runs on SwiftShader CI.
 *
 * Shot definitions live in `playwright/visual/marketing-shots.ts` (#648 FR4 /
 * AC3). Adding a shot is a data edit there plus an `<img>` tag in
 * `docs/index.html`; this file does not change.
 *
 * The spec writes PNGs to `process.env.MARKETING_OUT_DIR` (default
 * `playwright-report/marketing-shots/`) and appends a per-shot entry to
 * `MARKETING_OUT_DIR/report.json` (#648 FR9 / AC8). The deploy job uploads
 * both as a workflow artifact and overlays the PNGs onto `docs/` before Pages
 * publish.
 */

const OUT_DIR = process.env.MARKETING_OUT_DIR
  ? path.resolve(process.env.MARKETING_OUT_DIR)
  : path.resolve(process.cwd(), 'playwright-report', 'marketing-shots');

const REPORT_PATH = path.join(OUT_DIR, 'report.json');

const LIGHTING_STORAGE_KEY = 'virtualrow:conditions';
const CAMERA_VIEW_STORAGE_KEY = 'virtualrow:camera-view';

// Mirror the webgpu-engine smoke's proven flag combo
// (playwright/tests/webgpu-engine-smoke.spec.ts), not GPU_RIDE_LAUNCH_OPTIONS.
// The ride-spec combo (`--enable-features=Vulkan` + no `--use-gl=swiftshader`)
// made Chromium's GPU process open a hardware GL context on the display-less
// fleet VM and crash it, bringing WebGPU down too, so Dawn fell back to the
// SwiftShader adapter and the engine's `software-adapter` guard rejected
// every shot. The engine smoke's combo keeps GL on software while leaving
// Dawn's Vulkan backend reachable, which is what the T4 needs here.
test.use({
  launchOptions: {
    ...(process.env.PW_LOCAL_CHROME ? { executablePath: process.env.PW_LOCAL_CHROME } : {}),
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

// Each shot sets its own viewport before boot; drop the config-wide default.
test.use({ viewport: null });

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(REPORT_PATH)) {
    fs.writeFileSync(REPORT_PATH, JSON.stringify({ shots: [] }, null, 2));
  }
});

function appendReport(entry: MarketingShotReport): void {
  const existing = fs.existsSync(REPORT_PATH)
    ? (JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')) as { shots: MarketingShotReport[] })
    : { shots: [] };
  existing.shots.push(entry);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(existing, null, 2));
}

async function pinLightingAndView(
  page: Page,
  lighting: MarketingShot['lighting'],
  view: MarketingShot['view'],
): Promise<void> {
  await page.addInitScript(
    ([light, viewPref, lightKey, viewKey]) => {
      try {
        localStorage.setItem(lightKey, light);
        localStorage.setItem(viewKey, viewPref);
      } catch {
        // Private mode: the chosen preset defaults harmlessly.
      }
    },
    [lighting, view, LIGHTING_STORAGE_KEY, CAMERA_VIEW_STORAGE_KEY] as const,
  );
}

async function hideOverlays(page: Page, selectors: readonly string[]): Promise<void> {
  if (selectors.length === 0) return;
  await page.evaluate((sel) => {
    const style = document.createElement('style');
    style.id = 'marketing-shot-hide';
    style.textContent = `${sel.join(',\n')} { display: none !important; }`;
    document.head.appendChild(style);
  }, [...selectors]);
}

async function nonZeroPixelRatio(pngBytes: Buffer): Promise<number> {
  // Cheap first-pass: a scene-rendered PNG is dominated by non-zero bytes
  // after the IHDR/IDAT headers, where a blank one compresses to a long run
  // of zeros. The hero-screenshot test does the proper decoded check; this
  // is a canary for the per-shot JSON only.
  const sampleStart = Math.min(256, pngBytes.length);
  const sample = pngBytes.subarray(sampleStart, Math.min(sampleStart + 4096, pngBytes.length));
  if (sample.length === 0) return 0;
  let nonZero = 0;
  for (const b of sample) if (b !== 0) nonZero += 1;
  return nonZero / sample.length;
}

for (const shot of MARKETING_SHOTS) {
  test(`marketing: ${shot.label}`, async ({ page, browserName }, testInfo) => {
    testInfo.setTimeout(90_000);

    await page.setViewportSize(shot.viewport);

    await installRideHarness(page);
    await pinTier(page, shot.tier);
    await pinLightingAndView(page, shot.lighting, shot.view);

    const outPath = path.join(OUT_DIR, shot.file);

    // Prevents the catch below from re-logging a report entry that the
    // fallback branch already wrote: a software-adapter outcome is a clean
    // skip, not an error.
    let reported = false;

    try {
      await startDemoRide(page);
      const outcome = await waitForRideOutcome(page, 45_000);

      if (outcome !== 'ready') {
        // #648 D5/FR8 — the regen workflow's job landed on a fleet VM
        // whose NVIDIA Vulkan ICD isn't live, so Chromium's WebGPU got a
        // software adapter and the engine declined (expected and
        // documented in agents.md). Record the fallback entry, mark the
        // test skipped, and let the deploy job publish the committed
        // `docs/*.png` unchanged. Failing the job would turn a routine
        // fleet-VM gap into a red deploy for no gain — the site stays
        // served by the fallback either way.
        const telemetry = await readRideTelemetry(page);
        const health = await page.evaluate(() => window.__VIRTUALROW_WEBGPU_HEALTH);
        appendReport({
          file: shot.file,
          label: shot.label,
          tier: shot.tier,
          lighting: shot.lighting,
          view: shot.view,
          viewport: shot.viewport,
          outcome: 'fallback',
          bytes: 0,
          nonZeroPixelRatio: 0,
          fallbackReason: health?.fallbackReason ?? 'unknown',
          error: `engine declined (${browserName}, backend=${telemetry.context?.backend ?? '?'}); keeping committed fallback PNG`,
        });
        reported = true;
        test.skip(
          true,
          `marketing: ${shot.file} skipped — engine declined ` +
            `(fallback=${health?.fallbackReason ?? 'unknown'}); keeping committed fallback`,
        );
        return;
      }

      const canvas = page.locator('.rower3d-canvas-container canvas').first();
      await expect(canvas).toBeVisible({ timeout: 20_000 });
      await expect(canvas).toHaveAttribute('data-backend', 'webgpu');

      // Settle the scene — GLBs, textures and post-FX arrive after the first
      // frame, and the activity HUD needs a few sim frames before the tiles
      // stop reading zero. Force a render on each wait tick so test-mode's
      // non-free-running loop advances.
      const settleStart = Date.now();
      while (Date.now() - settleStart < shot.settleMs) {
        await forceRender(page);
        await page.waitForTimeout(250);
      }

      await assertCanvasNotBlank(page, canvas);
      await hideOverlays(page, shot.hiddenOverlays);
      await forceRender(page);

      const telemetry = await readRideTelemetry(page);
      const renderStats = await readRenderStats(page);

      const pngBytes = await page.screenshot({ fullPage: false });
      fs.writeFileSync(outPath, pngBytes);

      const nzr = await nonZeroPixelRatio(pngBytes);
      appendReport({
        file: shot.file,
        label: shot.label,
        tier: shot.tier,
        lighting: shot.lighting,
        view: shot.view,
        viewport: shot.viewport,
        outcome: 'ready',
        bytes: pngBytes.length,
        nonZeroPixelRatio: nzr,
        gpuMs: telemetry.frame?.gpuMs,
        drawCalls: renderStats?.draws,
        sceneryDraws: renderStats?.sceneryDraws,
      });

      // #648 AC11: zero draws is a non-skippable failure — never publish a
      // blank frame. The nonZeroPixelRatio canary catches a different class
      // (encoded-but-empty).
      expect(renderStats?.draws ?? 0, 'engine drew zero commands').toBeGreaterThan(0);
      expect(nzr, 'png is empty/zero after the header').toBeGreaterThan(0.1);
    } catch (err) {
      // Record the error entry so report.json always carries every shot.
      // The fallback branch above already appends its own entry and sets
      // `reported`, so we skip here to avoid a duplicate row.
      if (!reported) {
        const message = err instanceof Error ? err.message : String(err);
        appendReport({
          file: shot.file,
          label: shot.label,
          tier: shot.tier,
          lighting: shot.lighting,
          view: shot.view,
          viewport: shot.viewport,
          outcome: 'error',
          bytes: 0,
          nonZeroPixelRatio: 0,
          error: message,
        });
      }
      throw err;
    }
  });
}
