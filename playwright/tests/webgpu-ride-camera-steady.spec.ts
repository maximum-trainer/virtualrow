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
 * `__ROWER3D_CAMERA.fov` is the FOV the frame was drawn with. The harness's
 * test mode does not free-run the render loop, so the spec draws a frame
 * (`__ROWER3D_FORCE_RENDER`) and samples it on every animation frame.
 *
 * GPU runner only; without a hardware adapter the engine declines and the
 * spec asserts the fallback instead.
 */

type W = Window & { __ROWER3D_CAMERA?: { fov: number }; __ROWER3D_FORCE_RENDER?: () => void };

test('the FOV holds steady through 20 s of rowing', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 720 });
  // An OS that asks for less motion pins the FOV to its base (#344), which
  // would pass this spec without testing the filter: ask for full motion.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await installRideHarness(page);
  await pinTier(page, 'medium');
  await startDemoRide(page);
  if ((await waitForRideOutcome(page, 60_000)) !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }
  // Test mode does not free-run the render loop, so drive a frame on every
  // animation frame for 30 s: 10 s for the countdown and to get up to speed,
  // then 20 s sampled.
  const samples = await page.evaluate(
    () =>
      new Promise<{ t: number; fov: number }[]>((resolve) => {
        const w = window as W;
        const out: { t: number; fov: number }[] = [];
        const t0 = performance.now();
        const tick = (now: number) => {
          w.__ROWER3D_FORCE_RENDER?.();
          const t = now - t0;
          const fov = w.__ROWER3D_CAMERA?.fov;
          if (t >= 10_000 && typeof fov === 'number') out.push({ t, fov });
          if (t < 30_000) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  expect(samples.length, 'frames were drawn').toBeGreaterThan(100);
  // The boat is moving, so the speed coupling has opened the lens past its
  // 58 degree base: the steadiness below is the filter's, not a pinned FOV.
  const widest = Math.max(...samples.map((s) => s.fov));
  expect(widest, 'the FOV follows speed at all').toBeGreaterThan(58.5);
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
