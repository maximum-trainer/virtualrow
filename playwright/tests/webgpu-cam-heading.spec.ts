/**
 * #753 VP-30 FR4 — on the Head of the Cam, imported against the recorded map
 * answer, the boat turns with the river: its heading
 * (`__ROWER3D_BOAT.heading`) changes by more than 60 degrees over the row and
 * never by more than 20 degrees between frames 5 m apart.
 *
 * Needs a hardware WebGPU adapter; where the engine declines it asserts the
 * decline is well-formed, like the other ride specs.
 */
import { test, expect } from '../fixtures/crash-watch';
import { importCamCourse, serveCamCourse } from './helpers/camCourse';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  assertWellFormedDecline,
  forceRender,
  readRideTelemetry,
  waitForRideOutcome,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

type W = Window & {
  __ROWER3D_ROUTE?: { totalDistance: number };
  __ROWER3D_SEEK_METERS?: (metres: number | null) => void;
};

const STEP_M = 5;

test('the boat turns with the Cam (#753 FR4)', async ({ page }) => {
  test.setTimeout(180_000);
  await serveCamCourse(page, 'recorded');
  await importCamCourse(page);
  await expect
    .poll(() => page.evaluate(() => window.__SELECTED_ROUTE?.geometrySource), { timeout: 30_000 })
    .toBe('osm-derived');

  await page.getByRole('button', { name: 'Row', exact: true }).click();
  await page.waitForSelector('.btn-try-demo', { timeout: 15_000 });
  await page.evaluate(() => (document.querySelector('.btn-try-demo') as HTMLButtonElement | null)?.click());
  await page.waitForURL(/\/row(\/)?$/, { timeout: 15_000 });
  if ((await waitForRideOutcome(page, 45_000)) !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }

  await forceRender(page);
  const total = (await page.evaluate(() => (window as W).__ROWER3D_ROUTE?.totalDistance)) ?? 0;
  expect(total, 'route length').toBeGreaterThan(2_000);

  // Walk the boat down the course 5 m at a time and read its heading.
  const headings: number[] = [];
  for (let m = 0; m <= total - STEP_M; m += STEP_M) {
    await page.evaluate((metres) => (window as W).__ROWER3D_SEEK_METERS?.(metres), m);
    await forceRender(page);
    // The engine's boat telemetry carries a heading in radians (telemetry.ts Rower3DBoat).
    const boat = (await readRideTelemetry(page)).boat as { heading?: number } | undefined;
    expect(typeof boat?.heading, 'boat heading').toBe('number');
    headings.push(boat!.heading!);
  }
  await page.evaluate(() => (window as W).__ROWER3D_SEEK_METERS?.(null));

  let swept = 0;
  let low = 0;
  let high = 0;
  let worstStep = 0;
  for (let i = 1; i < headings.length; i++) {
    let d = headings[i] - headings[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    worstStep = Math.max(worstStep, Math.abs(d));
    swept += d;
    low = Math.min(low, swept);
    high = Math.max(high, swept);
  }
  const deg = (r: number) => (r * 180) / Math.PI;
  expect(deg(high - low), 'heading range over the row').toBeGreaterThan(60);
  expect(deg(worstStep), 'largest heading change between frames 5 m apart').toBeLessThanOrEqual(20);
});
