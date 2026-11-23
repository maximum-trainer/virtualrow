import { test, expect } from '../fixtures/crash-watch';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  installRideHarness,
  pinTier,
  startDemoRide,
  waitForRideOutcome,
  assertWellFormedDecline,
} from './helpers/engineRide';
import { RENDER_BUDGET } from '../../src/lib/renderer/renderBudget';
import type { PerformanceMode } from '../../src/components/rower3d/constants';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/**
 * #737 VP-19 FR7 — play is smooth at every tier.
 *
 * Rows the demo route for 90 s at each tier and holds the frame pacing the
 * engine publishes (`__ROWER3D_FRAME_PACING`, a 600-frame window of real
 * frame intervals, #795) to the tier's budget:
 *   - p95 <= RENDER_BUDGET[tier].p95Ms,
 *   - no frame over 50 ms after the first 5 s,
 *   - longestStallMs < 100.
 *
 * The harness's test mode does not free-run the render loop, so the spec
 * draws a frame (`__ROWER3D_FORCE_RENDER`) on every animation frame: the
 * engine then runs at the display's own cadence, as it does for a rower.
 * Each frame's interval is read from `__ROWER3D_FRAME_STATS.dtMs`, so the
 * 50 ms check covers all 85 s, not only the last window.
 *
 * GPU runner only; without a hardware adapter the engine declines and the
 * spec asserts the fallback instead.
 */

const ROW_MS = 90_000;
const SETTLE_MS = 5_000;

type Pacing = { samples: number; p50: number; p95: number; p99: number; max: number; over25ms: number; over50ms: number; longestStallMs: number };
type W = Window & {
  __ROWER3D_FORCE_RENDER?: () => void;
  __ROWER3D_FRAME_STATS?: { frame: number; dtMs: number };
  __ROWER3D_FRAME_PACING?: Pacing;
};

const TIERS: PerformanceMode[] = ['basic', 'low', 'medium', 'high', 'extra-high'];

for (const tier of TIERS) {
  test(`frame pacing holds to the ${tier} budget over 90 s of rowing`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await installRideHarness(page);
    await pinTier(page, tier);
    await startDemoRide(page);
    if ((await waitForRideOutcome(page, 60_000)) !== 'ready') {
      await assertWellFormedDecline(page);
      return;
    }
    const result = await page.evaluate(
      ({ rowMs, settleMs }) =>
        new Promise<{ frames: number; slow: number[]; pacing: Pacing | null }>((resolve) => {
          const w = window as W;
          const slow: number[] = [];
          let frames = 0;
          let lastFrame = -1;
          const t0 = performance.now();
          const tick = (now: number) => {
            w.__ROWER3D_FORCE_RENDER?.();
            const stats = w.__ROWER3D_FRAME_STATS;
            if (stats && stats.frame !== lastFrame) {
              lastFrame = stats.frame;
              frames += 1;
              if (now - t0 >= settleMs && stats.dtMs > 50) slow.push(Math.round(stats.dtMs));
            }
            if (now - t0 < rowMs) requestAnimationFrame(tick);
            else resolve({ frames, slow, pacing: w.__ROWER3D_FRAME_PACING ? { ...w.__ROWER3D_FRAME_PACING } : null });
          };
          requestAnimationFrame(tick);
        }),
      { rowMs: ROW_MS, settleMs: SETTLE_MS },
    );
    test.info().annotations.push({ type: 'frame-pacing', description: `${tier}: ${JSON.stringify(result.pacing)}` });
    expect(result.frames, 'frames were drawn').toBeGreaterThan(600);
    expect(result.pacing, '__ROWER3D_FRAME_PACING is published').not.toBeNull();
    const pacing = result.pacing!;
    expect(pacing.samples, 'the pacing window is full').toBe(600);
    expect(pacing.p95, `p95 frame interval (ms) against the ${tier} budget`).toBeLessThanOrEqual(RENDER_BUDGET[tier].p95Ms);
    expect(result.slow, 'frames over 50 ms after the first 5 s').toEqual([]);
    expect(pacing.longestStallMs, 'longest stall in the window (ms)').toBeLessThan(100);
  });
}
