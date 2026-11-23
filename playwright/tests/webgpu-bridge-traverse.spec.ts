import { test, expect, type Page } from '../fixtures/crash-watch';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  installRideHarness,
  pinTier,
  startDemoRide,
  waitForRideOutcome,
  forceRender,
  assertWellFormedDecline,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/**
 * #724 VP-06 — the Willowbrook arches lay along the river and the camera
 * travelled inside the masonry.
 *
 * Scenario: rowing under the Willowbrook bridge
 *   Given a forced-frame traverse past the first arch in chase and high views
 *   Then the camera position is never inside any bridge mesh bounds
 *
 * "Inside" is read from the engine: while the camera is over a span,
 * `__ROWER3D_CAMERA.ceiling` is the deck underside there, and the camera
 * must stay 1 m below it. The per-model fit (axis across the river, an
 * opening on the racing line, headroom) is covered for every bridge model
 * in bridgeSpan.test.ts.
 *
 * GPU runner only; without a hardware adapter the engine declines and the
 * spec asserts the fallback instead.
 */

type Span = { id: string; x: number; z: number; scale: number; ceiling: number | null };
type W = Window & {
  __ROWER3D_ROUTE?: { totalDistance: number; spans?: Span[] };
  __ROWER3D_CAMERA?: { x: number; y: number; z: number; ceiling?: number | null };
  __ROWER3D_SEEK_METERS?: (metres: number | null) => void;
};

const traverse = async (page: Page, from: number, to: number) => {
  let under = 0;
  let highest = 0;
  for (let m = from; m <= to; m += 2) {
    await page.evaluate((metres) => (window as W).__ROWER3D_SEEK_METERS?.(metres), m);
    await forceRender(page);
    const camera = await page.evaluate(() => (window as W).__ROWER3D_CAMERA);
    expect(camera, 'camera telemetry').toBeTruthy();
    highest = Math.max(highest, camera!.y);
    if (camera!.ceiling !== null && camera!.ceiling !== undefined) {
      under += 1;
      expect(camera!.y, `camera under the deck at ${m} m`).toBeLessThanOrEqual(camera!.ceiling - 1 + 1e-3);
    }
  }
  return { under, highest };
};

test('the camera stays under the Willowbrook arch in the high and chase views', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 720 });
  await installRideHarness(page);
  await pinTier(page, 'medium');
  await page.addInitScript(() => {
    try { localStorage.setItem('virtualrow:camera-view', 'high'); } catch { /* private mode */ }
  });
  await startDemoRide(page);
  if ((await waitForRideOutcome(page, 45_000)) !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }
  await forceRender(page);
  const route = await page.evaluate(() => (window as W).__ROWER3D_ROUTE);
  const arches = (route?.spans ?? []).filter((s) => s.id === 'c01-bridge-arch-masonry');
  expect(arches.length, 'both Willowbrook arches are placed').toBe(2);
  for (const arch of arches) expect(arch.ceiling ?? 0, 'headroom').toBeGreaterThanOrEqual(4.5);

  // The first arch is at 15% of the route; the camera trails the boat.
  const at = 0.15 * (route?.totalDistance ?? 0);
  const high = await traverse(page, at - 40, at + 60);
  expect(high.under, 'the high camera passed under the arch').toBeGreaterThan(0);

  await page.keyboard.press('v'); // high → chase
  const chase = await traverse(page, at - 40, at + 60);
  expect(chase.highest, 'the chase view is lower than the high view').toBeLessThan(high.highest);
  await page.evaluate(() => (window as W).__ROWER3D_SEEK_METERS?.(null));
});
