/**
 * #584 AC5.4 — scene quality follows the tier on the WebGPU engine.
 *
 * Ported from the retired `scene-quality-match.spec.ts`, which checked that the
 * React canvas surface (antialias / powerPreference / DPR) matched the scene.
 * The WebGPU engine owns none of that — the UI shell owns the canvas — so the
 * ported contract is the engine's half: a tier change actually changes what the
 * engine *builds* (shadow cascades climb, draw count never drops), not the
 * adapter.
 *
 * The unit half (ac4PortedBehaviors.test.ts "(D) scene quality") asserts the
 * same against the mock device; this is the real-`/row` e2e half. It mounts the
 * ride at `basic` and `extra-high` in two separate contexts and compares. On a
 * runner without a hardware adapter both decline, and the spec asserts the
 * well-formed decline for each (#542 NFR5).
 */
import { expect, test, type Browser } from '../fixtures/crash-watch';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  assertWellFormedDecline,
  forceRender,
  installRideHarness,
  pinTier,
  readRenderStats,
  readShadows,
  startDemoRide,
  waitForRideOutcome,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

interface TierSample {
  outcome: 'ready' | 'fallback';
  draws: number;
  cascades: number;
}

async function sampleTier(
  browser: Browser,
  tier: 'basic' | 'extra-high',
): Promise<{ sample: TierSample; assertDecline: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await pinTier(page, tier);
  await installRideHarness(page);
  await startDemoRide(page);
  const outcome = await waitForRideOutcome(page);

  if (outcome === 'ready') await forceRender(page);
  const stats = await readRenderStats(page);
  const shadows = await readShadows(page);
  const sample: TierSample = {
    outcome,
    draws: stats?.draws ?? 0,
    cascades: shadows?.cascades ?? 0,
  };
  return {
    sample,
    assertDecline: async () => {
      await assertWellFormedDecline(page);
      await context.close();
    },
  };
}

test('higher tier builds a richer scene than basic (#584 AC5.4)', async ({ browser }) => {
  const basic = await sampleTier(browser, 'basic');
  const top = await sampleTier(browser, 'extra-high');

  // No hardware adapter on either: both declined cleanly, nothing to compare.
  if (basic.sample.outcome === 'fallback' || top.sample.outcome === 'fallback') {
    await basic.assertDecline();
    await top.assertDecline();
    return;
  }

  // Both attached on a real adapter: the tier changed what the engine built.
  // Shadow cascades are a config-driven, route-independent signal that must
  // strictly climb; draw count must never drop (extra-high adds SSAO/DOF,
  // clouds, building + crew shadows on top of basic's flat lit scene).
  expect(top.sample.cascades, 'extra-high has more shadow cascades than basic').toBeGreaterThan(
    basic.sample.cascades,
  );
  expect(top.sample.draws, 'extra-high never draws fewer passes than basic').toBeGreaterThanOrEqual(
    basic.sample.draws,
  );
});

/**
 * #732 FR4 — `high` must not look worse than `medium`. The same frozen frame
 * (demo route, held at the same distance) is read back from the GPU at both
 * tiers and scored by the engine's pixel probe (`frameQuality`).
 */
interface FrameQuality {
  meanLuma: number;
  laplacianVariance: number;
  edgeFringe: number;
  edgePixels: number;
}
type QualityWindow = {
  __ROWER3D_SEEK_METERS?: (metres: number | null) => void;
  __ROWER3D_HOLD_FRAME?: (on: boolean) => void;
  __ROWER3D_READ_PIXELS?: (grid: number, minBrightness: number) => Promise<{ quality?: FrameQuality; error?: string }>;
};

const HELD_AT_METERS = 300;

async function frozenFrameQuality(
  browser: Browser,
  tier: 'medium' | 'high',
): Promise<{ quality: FrameQuality | null; finish: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await pinTier(page, tier);
  await installRideHarness(page);
  await startDemoRide(page);
  const outcome = await waitForRideOutcome(page);
  if (outcome !== 'ready') {
    return {
      quality: null,
      finish: async () => {
        await assertWellFormedDecline(page);
        await context.close();
      },
    };
  }
  await page.evaluate((m) => {
    const w = window as unknown as QualityWindow;
    w.__ROWER3D_SEEK_METERS?.(m);
    w.__ROWER3D_HOLD_FRAME?.(true);
  }, HELD_AT_METERS);
  // Let streamed scenery land and auto-exposure settle on the held view.
  await page.waitForTimeout(3_000);
  for (let i = 0; i < 3; i += 1) await forceRender(page);
  const result = await page.evaluate(async () => {
    const read = (window as unknown as QualityWindow).__ROWER3D_READ_PIXELS;
    return read ? read(20, 15) : null;
  });
  expect(result?.error, `${tier}: pixel readback failed`).toBeUndefined();
  return { quality: result?.quality ?? null, finish: () => context.close() };
}

test('high is at least as sharp and as bright as medium, with no colour fringing (#732 FR4)', async ({ browser }) => {
  const medium = await frozenFrameQuality(browser, 'medium');
  const high = await frozenFrameQuality(browser, 'high');
  try {
    if (!medium.quality || !high.quality) return; // no hardware adapter: both declined above
    const m = medium.quality;
    const h = high.quality;
    expect(h.laplacianVariance, 'high is at least 0.95x as sharp as medium').toBeGreaterThanOrEqual(
      0.95 * m.laplacianVariance,
    );
    expect(Math.abs(h.meanLuma - m.meanLuma) / m.meanLuma, 'high mean luma within 12% of medium').toBeLessThanOrEqual(0.12);
    expect(h.edgeFringe - m.edgeFringe, 'edge fringing within 8/255 of medium').toBeLessThanOrEqual(8);
  } finally {
    await medium.finish();
    await high.finish();
  }
});
