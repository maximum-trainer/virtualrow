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

// Run against the full Chrome-for-Testing build, not Playwright's default
// headless_shell. The headless_shell binary (installed by
// `playwright install chromium` with no `channel`) does NOT expose
// `navigator.gpu`, so WebGPU is unavailable regardless of Vulkan ICD state.
// PR #671's probe confirmed this on linux-nvidia-gpu-runner-847: the T4
// kernel driver was fully loaded, libGLX_nvidia resolved, but
// `navigator.gpu` was `absent` inside the browser. `channel: 'chromium'`
// swaps to the full Chrome-for-Testing build Playwright installs
// alongside, which ships WebGPU.
//
// The regen-marketing-shots.yml workflow installs that build with
// `npx playwright install chromium --channel chromium`.
test.use({
  channel: 'chrome',
  launchOptions: {
    ...(process.env.PW_LOCAL_CHROME ? { executablePath: process.env.PW_LOCAL_CHROME } : {}),
    // Marketing shots need the HARDWARE WebGPU path, not SwiftShader. The
    // engine-smoke spec can mix `--use-gl=swiftshader` with
    // `--enable-unsafe-webgpu` because its contract covers the fallback
    // branch too; here we only care about the real-GPU render. Combining
    // `--use-gl=swiftshader` + `--disable-gpu-{compositing,rasterization}`
    // puts Chrome's GPU process into a software/off state that drops the
    // WebGPU surface entirely (`navigator.gpu === undefined` — confirmed on
    // runner-884, PR #671 run 41351188410, even with libGLX_nvidia and all
    // the userspace NVIDIA libs resolved on disk).
    //
    // Instead: let Chrome's GPU process start with the real driver, point
    // ANGLE at Vulkan, and keep only the stability flags that CI needs.
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-angle=vulkan',
      '--no-sandbox',
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

    // #648 black-canvas debug: capture every console message and page error
    // the browser emits during the run — WebGPU validation errors land on
    // `page.on('console')` with type 'error', and uncaught throws land on
    // `page.on('pageerror')`. Both are attached to the report entry so a
    // blank-frame failure carries the Chromium-side reason.
    const consoleLines: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        consoleLines.push(`[${type}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    });

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

      // #648 blank-frame debug: capture adapter info + readback stats BEFORE
      // the assertion fires, so a blank-frame report entry carries why it
      // was blank even when the test errors mid-way.
      const health = await page.evaluate(() => window.__VIRTUALROW_WEBGPU_HEALTH);
      const rawAdapter = await page.evaluate(async () => {
        try {
          const nav = navigator as Navigator & { gpu?: { requestAdapter(o?: unknown): Promise<unknown> } };
          const a = (await nav.gpu?.requestAdapter({ powerPreference: 'high-performance' })) as
            | {
                info?: { vendor?: string; architecture?: string; device?: string; description?: string };
                isFallbackAdapter?: boolean;
              }
            | undefined;
          if (!a) return undefined;
          const info = a.info ?? {};
          return {
            vendor: info.vendor,
            architecture: info.architecture,
            device: info.device,
            description: info.description,
            isFallbackAdapter: a.isFallbackAdapter,
          };
        } catch {
          return undefined;
        }
      });
      const readback = await canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const w = c.width;
        const h = c.height;
        const tmp = document.createElement('canvas');
        tmp.width = w;
        tmp.height = h;
        const ctx = tmp.getContext('2d');
        if (!ctx) return { w, h, nonBlank: 0, total: 0 };
        try {
          ctx.drawImage(c, 0, 0);
        } catch {
          return { w, h, nonBlank: 0, total: 0 };
        }
        let total = 0;
        let nonBlank = 0;
        for (let yi = 0; yi < 20; yi += 1) {
          for (let xi = 0; xi < 20; xi += 1) {
            const x = Math.floor(((xi + 0.5) / 20) * w);
            const y = Math.floor(((yi + 0.5) / 20) * h);
            const d = ctx.getImageData(x, y, 1, 1).data;
            total += 1;
            if (d[0] + d[1] + d[2] >= 15) nonBlank += 1;
          }
        }
        return { w, h, nonBlank, total };
      });

      const telemetry = await readRideTelemetry(page);
      const renderStats = await readRenderStats(page);

      // Record a provisional entry BEFORE the assertion so a blank frame
      // still lands with its adapter/readback diagnostics attached.
      appendReport({
        file: shot.file,
        label: shot.label,
        tier: shot.tier,
        lighting: shot.lighting,
        view: shot.view,
        viewport: shot.viewport,
        outcome: readback.nonBlank > 0 ? 'ready' : 'error',
        bytes: 0,
        nonZeroPixelRatio: 0,
        gpuMs: telemetry.frame?.gpuMs,
        drawCalls: renderStats?.draws,
        sceneryDraws: renderStats?.sceneryDraws,
        adapter: health?.adapter,
        isSoftware: health?.isSoftware,
        rawAdapter,
        canvasSize: { w: readback.w, h: readback.h },
        readback: { nonBlank: readback.nonBlank, total: readback.total },
        error:
          readback.nonBlank === 0
            ? `blank frame (0/${readback.total} non-black); adapter=${health?.adapter ?? '?'} isSoftware=${health?.isSoftware ?? '?'}; draws=${renderStats?.draws ?? '?'} gpuMs=${telemetry.frame?.gpuMs ?? '?'}; consoleErrors=${consoleLines.length} pageErrors=${pageErrors.length}\n--- console (${consoleLines.length}) ---\n${consoleLines.slice(0, 80).join('\n')}\n--- pageerror (${pageErrors.length}) ---\n${pageErrors.slice(0, 20).join('\n')}`
            : undefined,
      });
      reported = true;

      await assertCanvasNotBlank(page, canvas);
      await hideOverlays(page, shot.hiddenOverlays);
      await forceRender(page);

      const pngBytes = await page.screenshot({ fullPage: false });
      fs.writeFileSync(outPath, pngBytes);

      const nzr = await nonZeroPixelRatio(pngBytes);
      // Overwrite the provisional entry with the real success record. The
      // report file holds a list, so the duplicate is harmless; the
      // "Summarise rendered shots" step treats the latest entry per file.
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
        adapter: health?.adapter,
        isSoftware: health?.isSoftware,
        rawAdapter,
        canvasSize: { w: readback.w, h: readback.h },
        readback: { nonBlank: readback.nonBlank, total: readback.total },
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
          error:
            `${message}\n--- console (${consoleLines.length}) ---\n${consoleLines.slice(0, 80).join('\n')}` +
            `\n--- pageerror (${pageErrors.length}) ---\n${pageErrors.slice(0, 20).join('\n')}`,
        });
      }
      throw err;
    }
  });
}
