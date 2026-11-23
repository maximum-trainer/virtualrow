import { test, expect } from '../fixtures/crash-watch';
import { GPU_RIDE_LAUNCH_OPTIONS } from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/**
 * #742 VP-22 — the boat rows on water the whole way round a lap whose
 * return leg runs about 40 m from the outbound leg.
 *
 * Scenario: the boat is always on water
 *   Given /smoke/legs, the recorded Lake Quinsigamond lap (rownative 115)
 *   When frames are forced every 10 m of the whole course
 *   Then `__ROWER3D_CLEARANCE.surface` is "water" at every sample
 *
 * The same traverse runs for all four recorded courses and a synthetic
 * out-and-back on the mock device in parallelLegCourses.test.ts; this is
 * the real-adapter half. Without a hardware adapter the engine declines
 * and the spec asserts the fallback instead.
 */

type W = Window & {
  __SMOKE_LEGS_METERS?: number;
  __ROWER3D_FORCE_RENDER?: () => void;
  __ROWER3D_CLEARANCE?: { surface?: string };
  __VIRTUALROW_WEBGPU_HEALTH?: { fallbackReason?: string };
};

test('the boat is on water every 10 m of the Lake Quinsigamond lap (#742)', async ({ page }) => {
  test.slow();
  await page.goto('./smoke/legs');
  const main = page.getByTestId('webgpu-parallel-legs-smoke');
  await expect(main).toBeVisible();
  await expect(main).not.toHaveAttribute('data-status', 'pending', { timeout: 45_000 });

  if ((await main.getAttribute('data-status')) !== 'ready') {
    const health = await page.evaluate(() => (window as W).__VIRTUALROW_WEBGPU_HEALTH);
    expect(health?.fallbackReason).toBeTruthy();
    return;
  }

  const total = Number(await main.getAttribute('data-total-meters'));
  expect(total, 'the lap is about 8.7 km').toBeGreaterThan(8_000);
  const land = await page.evaluate((totalMeters) => {
    const w = window as W;
    const out: number[] = [];
    for (let m = 0; m <= totalMeters; m += 10) {
      w.__SMOKE_LEGS_METERS = m;
      w.__ROWER3D_FORCE_RENDER?.();
      if (w.__ROWER3D_CLEARANCE?.surface !== 'water') out.push(m);
    }
    return out;
  }, total);
  expect(land, 'metres where the hull was not on water').toEqual([]);
});
