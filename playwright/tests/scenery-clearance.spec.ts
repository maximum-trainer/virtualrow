import { test, expect } from '../fixtures/crash-watch';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  assertWellFormedDecline,
  forceRender,
  installRideHarness,
  pinTier,
  startDemoRide,
  waitForRideOutcome,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/**
 * #761 (VP-05 follow-up) — no drawn scenery model intrudes on the racing
 * corridor anywhere on the demo route.
 *
 * Scenario: the whole of Willowbrook is clear of scenery
 *   Given a forced-frame traverse of the demo route, start to finish
 *   Then at every step `__ROWER3D_SCENERY_CLEARANCE.min` (centreline to the
 *     nearest drawn footprint edge, buoys, bridges, pontoon, flagpoles and
 *     distance posts excepted) is at least its `thresholdM`: the placement
 *     corridor less 1 m for bends, the same rule as clearanceProperty.test.ts.
 *
 * Without a hardware adapter the engine declines and the spec asserts the
 * fallback instead.
 */

type Clearance = {
  samples: number;
  min: number | null;
  minId: string | null;
  minProgress: number | null;
  thresholdM: number;
};
type W = Window & {
  __ROWER3D_ROUTE?: { totalDistance: number };
  __ROWER3D_SEEK_METERS?: (metres: number | null) => void;
  __ROWER3D_SCENERY_CLEARANCE?: Clearance;
};

const STEP_METERS = 20;

test('no scenery model stands in the racing corridor on the demo route (#761)', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 720 });
  await installRideHarness(page);
  await pinTier(page, 'medium');
  await startDemoRide(page);
  if ((await waitForRideOutcome(page, 45_000)) !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }
  await forceRender(page);
  const total = await page.evaluate(() => (window as W).__ROWER3D_ROUTE?.totalDistance ?? 0);
  expect(total, 'route length').toBeGreaterThan(0);

  let measured = 0;
  let worst: Clearance | null = null;
  for (let m = 0; m <= total; m += STEP_METERS) {
    await page.evaluate((metres) => (window as W).__ROWER3D_SEEK_METERS?.(metres), m);
    // Streamed models register one a frame once decoded.
    for (let i = 0; i < 3; i += 1) await forceRender(page);
    const c = await page.evaluate(() => {
      const v = (window as W).__ROWER3D_SCENERY_CLEARANCE;
      return v ? { ...v } : null;
    });
    expect(c, '__ROWER3D_SCENERY_CLEARANCE is published').toBeTruthy();
    if (!c || c.min === null) continue;
    measured = Math.max(measured, c.samples);
    if (!worst || (worst.min ?? Infinity) > c.min) worst = c;
    expect(
      c.min,
      `${c.minId} is ${c.min.toFixed(2)} m from the centreline at ${c.minProgress?.toFixed(0)} m (boat at ${m} m)`,
    ).toBeGreaterThanOrEqual(c.thresholdM);
  }
  await page.evaluate(() => (window as W).__ROWER3D_SEEK_METERS?.(null));
  expect(measured, 'some scenery was drawn and measured').toBeGreaterThan(0);
  test.info().annotations.push({
    type: 'scenery-clearance',
    description: worst ? `${worst.minId} ${worst.min?.toFixed(2)} m at ${worst.minProgress?.toFixed(0)} m` : 'none',
  });
});
