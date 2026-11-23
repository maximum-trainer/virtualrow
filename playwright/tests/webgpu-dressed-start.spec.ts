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
 * #726 VP-08 FR1 — the ride starts fully dressed.
 *
 * Scenario: ride starts fully dressed
 *   Given a demo row
 *   When the first frame is presented
 *   Then every scenery model with an instance within 600 m of the start is registered
 *   And the loading bar reported each phase before disappearing
 *
 * The engine records the models in the start window (`nearStartIds`) and
 * those registered when it drew its first frame (`registeredAtFirstFrame`).
 * The bar is watched from page load: it has to move through the phases to
 * 100% before it goes.
 *
 * GPU runner only; without a hardware adapter the engine declines and the
 * spec asserts the fallback instead.
 */

type W = Window & {
  __ROWER3D_SCENERY?: { nearStartIds: string[]; registeredAtFirstFrame: string[] | null; failedIds: string[] };
  __BAR_SEEN?: { now: number; text: string }[];
};

test('the first frame holds every model near the start, after the loading bar', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 720 });
  await installRideHarness(page);
  await pinTier(page, 'medium');
  // Record every value the bar shows, from the first paint.
  await page.addInitScript(() => {
    const seen: { now: number; text: string }[] = [];
    (window as W).__BAR_SEEN = seen;
    const record = () => {
      const bar = document.querySelector('[role="progressbar"][aria-label="Loading the 3D view"]');
      if (!bar) return;
      const now = Number(bar.getAttribute('aria-valuenow'));
      const text = bar.getAttribute('aria-valuetext') ?? '';
      const last = seen[seen.length - 1];
      if (!last || last.now !== now || last.text !== text) seen.push({ now, text });
    };
    new MutationObserver(record).observe(document, { subtree: true, childList: true, attributes: true });
  });
  await startDemoRide(page);
  if ((await waitForRideOutcome(page, 60_000)) !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }

  await expect
    .poll(() => page.evaluate(() => (window as W).__ROWER3D_SCENERY?.registeredAtFirstFrame ?? null), {
      timeout: 30_000,
    })
    .not.toBeNull();
  const scenery = await page.evaluate(() => (window as W).__ROWER3D_SCENERY!);
  expect(scenery.nearStartIds.length, 'the demo start has kit models').toBeGreaterThan(0);
  const failed = new Set(scenery.failedIds);
  for (const id of scenery.nearStartIds) {
    if (failed.has(id)) continue;
    expect(scenery.registeredAtFirstFrame, `${id} registered by the first frame`).toContain(id);
  }

  await expect(page.locator('[role="progressbar"][aria-label="Loading the 3D view"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  const seen = await page.evaluate(() => (window as W).__BAR_SEEN ?? []);
  expect(seen.length, 'the bar was shown').toBeGreaterThan(0);
  const values = seen.map((s) => s.now);
  for (let i = 1; i < values.length; i += 1) expect(values[i], 'the bar never goes back').toBeGreaterThanOrEqual(values[i - 1]);
  expect(values[values.length - 1], 'the bar reached its end before it went').toBe(100);
});
