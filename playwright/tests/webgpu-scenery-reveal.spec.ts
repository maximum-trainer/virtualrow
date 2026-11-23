import { test, expect } from '../fixtures/crash-watch';
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
 * #726 VP-08 FR3 — kit models streamed in mid-ride fade in instead of
 * popping in at full opacity.
 *
 * Scenario: nothing pops inside the visible range
 *   Given a forced-frame traverse of the demo route at 5 m/s on the GPU runner
 *   When a model's instance count goes from 0 to n
 *   Then every one of those instances is either beyond the visibility
 *     distance or has reveal alpha < 0.1 on that frame
 *
 * The visibility distance is the camera's far plane, so every drawn
 * instance takes the fade: the check is on the model's reveal alpha on the
 * frame it registered. The shader runs the same curve (`sceneryReveal.ts`,
 * `sceneryMesh.wgsl`).
 *
 * GPU runner only; without a hardware adapter the engine declines and the
 * spec asserts the fallback instead.
 */

type Reveal = { id: string; registeredAtFrame: number; registeredAt: number; revealAlpha: number };
type W = Window & {
  __ROWER3D_ROUTE?: { totalDistance: number };
  __ROWER3D_SCENERY?: { frame: number; reveals?: Reveal[] };
  __ROWER3D_SEEK_METERS?: (metres: number | null) => void;
  __ROWER3D_FORCE_RENDER?: () => void;
};

test('models streamed in mid-ride start their fade on the frame they appear', async ({ page }) => {
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

  // 5 m/s at one forced frame per simulated second; the seek and the
  // read share one evaluate, so no free-running frame slips in between.
  const firstSeen = new Map<string, { lag: number; alpha: number }>();
  const end = Math.min(total, 3000);
  for (let m = 0; m <= end; m += 5) {
    const scenery = await page.evaluate((metres) => {
      const w = window as W;
      w.__ROWER3D_SEEK_METERS?.(metres);
      w.__ROWER3D_FORCE_RENDER?.();
      const s = w.__ROWER3D_SCENERY;
      return s ? { frame: s.frame, reveals: (s.reveals ?? []).map((r) => ({ ...r })) } : null;
    }, m);
    expect(scenery, 'scenery telemetry').toBeTruthy();
    for (const r of scenery!.reveals) {
      if (firstSeen.has(r.id)) continue;
      firstSeen.set(r.id, { lag: scenery!.frame - r.registeredAtFrame, alpha: r.revealAlpha });
    }
  }
  await page.evaluate(() => (window as W).__ROWER3D_SEEK_METERS?.(null));

  expect(firstSeen.size, 'the traverse streamed at least one model in').toBeGreaterThan(0);
  for (const [id, seen] of firstSeen) {
    if (seen.lag > 0) continue; // registered on a free-running frame between reads
    expect(seen.alpha, `${id} on the frame it registered`).toBeLessThan(0.1);
  }

  // Each fade completes: 1.5 s later every model is fully drawn.
  await page.waitForTimeout(1_700);
  await forceRender(page);
  const alphas = await page.evaluate(() =>
    ((window as W).__ROWER3D_SCENERY?.reveals ?? []).map((r) => [r.id, r.revealAlpha] as const),
  );
  for (const [id, alpha] of alphas) {
    if (firstSeen.has(id)) expect(alpha, `${id} fully revealed`).toBe(1);
  }
});
