import { test, expect } from '../fixtures/crash-watch';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  installRideHarness,
  pinTier,
  startDemoRide,
  waitForRideOutcome,
  assertWellFormedDecline,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/**
 * #735 VP-17 — steady rowing has a steady FOV.
 *
 * Scenario: steady rowing has steady FOV
 *   Given 20 s of a demo row
 *   Then max(fov) - min(fov) over any 1 s window is < 0.5 degree
 *
 * `__ROWER3D_CAMERA.fov` is the FOV the frame was drawn with. It is sampled
 * once per animation frame inside the page, so the spec sees every frame.
 *
 * GPU runner only; without a hardware adapter the engine declines and the
 * spec asserts the fallback instead.
 */

type W = Window & { __ROWER3D_CAMERA?: { fov: number } };

test('the FOV holds steady through 20 s of rowing', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 720 });
  await installRideHarness(page);
  await pinTier(page, 'medium');
  await startDemoRide(page);
  if ((await waitForRideOutcome(page, 60_000)) !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }
  // Let the row get up to speed first.
  await page.waitForTimeout(5_000);
  const samples = await page.evaluate(
    () =>
      new Promise<{ t: number; fov: number }[]>((resolve) => {
        const out: { t: number; fov: number }[] = [];
        const t0 = performance.now();
        const tick = (now: number) => {
          const fov = (window as W).__ROWER3D_CAMERA?.fov;
          if (typeof fov === 'number') out.push({ t: now - t0, fov });
          if (now - t0 < 20_000) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  expect(samples.length, 'frames were drawn').toBeGreaterThan(100);
  let worst = 0;
  for (let i = 0; i < samples.length; i += 1) {
    let lo = samples[i].fov;
    let hi = samples[i].fov;
    for (let j = i; j < samples.length && samples[j].t - samples[i].t <= 1_000; j += 1) {
      lo = Math.min(lo, samples[j].fov);
      hi = Math.max(hi, samples[j].fov);
    }
    worst = Math.max(worst, hi - lo);
  }
  expect(worst, 'largest FOV swing in any 1 s window (degrees)').toBeLessThan(0.5);
});
