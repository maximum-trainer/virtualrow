/**
 * #588 FR10 / AC10 — perf-budget telemetry on the real-GPU runner.
 *
 * The retired `route-performance-budgets.spec.ts` lived under
 * `playwright.config.next.ts`'s ignore list because it was built around the
 * React/three.js `__ROWER3D_FPS`/`__ROWER3D_DRAW_CALLS` globals. The WebGPU
 * engine publishes `__ROWER3D_FRAME_STATS` (`gpuMs`, `cpuMs`, `dtMs`,
 * `frame`) and `__ROWER3D_RENDER_STATS` (`draws`, `drawCalls`), so the
 * budget assertion now reads those seams via the engine ride harness.
 *
 * Scope (D9-b — absolute budget per tier): a cap on median `gpuMs` per
 * tier over a short settle window. A tier that comfortably passed on the
 * T4 at merge time has headroom at the committed cap, so an unrelated
 * regression (an added pass, a texture upload per frame) flips the test
 * red before it ships. On a runner without a hardware adapter each tier
 * declines and the spec asserts the well-formed decline (#542 NFR5).
 */
import { expect, test } from '../fixtures/crash-watch';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  assertWellFormedDecline,
  forceRender,
  installRideHarness,
  pinTier,
  readRenderStats,
  readRideTelemetry,
  startDemoRide,
  waitForRideOutcome,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/**
 * Absolute `gpuMs` caps per tier (D9-b). Chosen with headroom over the T4
 * baseline so a non-regression PR never trips; a cap that regularly fails
 * is a cap that gets ignored. A real regression pushes gpuMs by double
 * digits (see #549's 272 B → 256 B replica in the issue scenarios), well
 * above the headroom here.
 *
 * To update after a deliberate pass-tree change: run this spec against
 * the GPU runner, read the recorded medians from the `::notice::` lines,
 * and bump the cap by one notch — never silently retire a failure.
 */
const GPU_MS_BUDGET: Record<'basic' | 'medium' | 'extra-high', number> = {
  basic: 6,
  medium: 12,
  'extra-high': 24,
};

/** Minimum draw calls per tier — a scene that drew nothing is a scene
 * whose budget doesn't mean anything. Mirrors #648 AC11's "zero draws is
 * a non-skippable failure". */
const MIN_DRAW_CALLS: Record<'basic' | 'medium' | 'extra-high', number> = {
  basic: 10,
  medium: 20,
  'extra-high': 40,
};

/** Frames to sample before computing the median; a few frames of warm-up
 * drop the one-off compile + first-draw outlier. */
const SAMPLE_FRAMES = 30;
const WARMUP_FRAMES = 5;

const median = (xs: readonly number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

for (const tier of ['basic', 'medium', 'extra-high'] as const) {
  test(`perf-budget: ${tier} gpuMs ≤ ${GPU_MS_BUDGET[tier]} (#588 FR10)`, async ({ page }, testInfo) => {
    testInfo.setTimeout(90_000);

    await pinTier(page, tier);
    await installRideHarness(page);
    await startDemoRide(page);

    if ((await waitForRideOutcome(page)) === 'fallback') {
      await assertWellFormedDecline(page);
      test.skip(true, `perf-budget: ${tier} skipped — engine declined (no hardware adapter)`);
      return;
    }

    // Warm up: compile pipelines, upload the first scenery batches.
    for (let i = 0; i < WARMUP_FRAMES; i++) {
      await forceRender(page);
      await page.waitForTimeout(80);
    }

    const gpuMsSamples: number[] = [];
    const cpuMsSamples: number[] = [];
    for (let i = 0; i < SAMPLE_FRAMES; i++) {
      await forceRender(page);
      await page.waitForTimeout(50);
      const telemetry = await readRideTelemetry(page);
      const g = telemetry.frame?.gpuMs ?? 0;
      const c = telemetry.frame?.cpuMs ?? 0;
      if (g > 0) gpuMsSamples.push(g);
      if (c > 0) cpuMsSamples.push(c);
    }

    const stats = await readRenderStats(page);
    expect(stats?.drawCalls ?? 0, 'the pass tree issues draws').toBeGreaterThanOrEqual(
      MIN_DRAW_CALLS[tier],
    );
    expect(gpuMsSamples.length, 'the GPU frame timer is live').toBeGreaterThan(0);

    const gpuMedian = median(gpuMsSamples);
    const cpuMedian = cpuMsSamples.length > 0 ? median(cpuMsSamples) : 0;

    // Surface the measurement for post-run triage even on green runs.
    testInfo.annotations.push({
      type: 'perf-budget',
      description:
        `tier=${tier} gpuMs median=${gpuMedian.toFixed(2)} ` +
        `cap=${GPU_MS_BUDGET[tier]} cpuMs median=${cpuMedian.toFixed(2)} ` +
        `draws=${stats?.drawCalls ?? 0} samples=${gpuMsSamples.length}`,
    });

    expect(
      gpuMedian,
      `tier=${tier} gpuMs median ${gpuMedian.toFixed(2)} ms exceeded cap ${GPU_MS_BUDGET[tier]} ms`,
    ).toBeLessThanOrEqual(GPU_MS_BUDGET[tier]);
  });
}
