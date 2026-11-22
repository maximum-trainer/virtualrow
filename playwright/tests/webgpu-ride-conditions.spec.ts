import { test, expect, type Page } from '../fixtures/crash-watch';
import { assertCanvasNotBlank } from './helpers/assertCanvasNotBlank';
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
test.describe.configure({ mode: 'serial' });

/**
 * #730 VP-12 — the Conditions picker (Dawn / Midday / Golden hour /
 * Overcast / Dusk) reaches the engine.
 *
 * Scenario Outline: conditions change the scene
 *   Given a demo row with conditions <c>, at 40 m
 *   Then __ROWER3D_CONDITIONS.name is <c>
 *   And the sun elevation and the sky's mean colour match the table below
 *   And the frame differs from the Midday frame
 *
 * Scenario: switching mid-row
 *   Given a running row at Midday
 *   When the conditions change to Dusk
 *   Then the next frame is lit for Dusk, with no device or scene rebuild
 *
 * The condition is set the way a rower sets it: the home screen's picker
 * stores it under `virtualrow:conditions` and the ride view reads it. Runs on
 * the GPU runner; on a VM without a hardware adapter the engine declines and
 * the spec asserts the fallback instead.
 */

const ROW_METRES = 40;

interface Conditions {
  name: string;
  sunElevationDeg: number;
  sunDisc: number;
  cloudCover: number;
  updates: number;
}
type W = Window & {
  __ROWER3D_CONDITIONS?: Conditions;
  __ROWER3D_BOAT?: { distanceMeters: number };
  __ROWER3D_FRAME_STATS?: { frame: number };
  __ROWER3D_SET_CONDITIONS?: (c: string) => void;
};

/** Mean RGB of the top fifth of the canvas: the sky above the far bank. */
const meanSky = (page: Page): Promise<[number, number, number]> =>
  page.locator('.rower3d-canvas-container canvas').first().evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const tmp = document.createElement('canvas');
    tmp.width = c.width;
    tmp.height = c.height;
    const ctx = tmp.getContext('2d');
    if (!ctx) return [0, 0, 0] as [number, number, number];
    ctx.drawImage(c, 0, 0);
    const rows = Math.max(1, Math.floor(c.height / 5));
    const d = ctx.getImageData(0, 0, c.width, rows).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      sum[0] += d[i];
      sum[1] += d[i + 1];
      sum[2] += d[i + 2];
    }
    const n = d.length / 4;
    return [sum[0] / n, sum[1] / n, sum[2] / n] as [number, number, number];
  });

const rideWith = async (page: Page, conditions: string): Promise<'ready' | 'fallback'> => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript((c) => {
    try {
      localStorage.setItem('virtualrow:conditions', c);
    } catch {
      /* storage off: the spec will fail on the name check */
    }
  }, conditions);
  await installRideHarness(page);
  await pinTier(page, 'medium');
  await startDemoRide(page);
  const outcome = await waitForRideOutcome(page, 45_000);
  if (outcome !== 'ready') return outcome;
  await expect(page.locator('.rower3d-canvas-container canvas').first()).toHaveAttribute('data-backend', 'webgpu');
  await expect
    .poll(
      async () => {
        await forceRender(page);
        return page.evaluate(() => (window as W).__ROWER3D_BOAT?.distanceMeters ?? 0);
      },
      { timeout: 60_000, intervals: [250] },
    )
    .toBeGreaterThanOrEqual(ROW_METRES);
  await forceRender(page);
  return outcome;
};

const middaySky: { value?: [number, number, number] } = {};

test('Midday is the reference frame and the engine default', async ({ page }) => {
  test.slow();
  if ((await rideWith(page, 'midday')) !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }
  await assertCanvasNotBlank(page, page.locator('.rower3d-canvas-container canvas').first());
  const c = await page.evaluate(() => (window as W).__ROWER3D_CONDITIONS);
  expect(c?.name).toBe('midday');
  expect(c?.sunDisc).toBe(1);
  middaySky.value = await meanSky(page);
  console.log(`[conditions] midday sky ${middaySky.value.map((v) => v.toFixed(1)).join(',')}`);
});

const TABLE = [
  // name, sun elevation (themeConfig presets), and how the sky must differ from Midday.
  { name: 'dawn', elevation: 8, sky: (s: number[], m: number[]) => s[2] < m[2] },
  { name: 'golden', elevation: 12, sky: (s: number[], m: number[]) => s[0] - s[2] > m[0] - m[2] },
  { name: 'overcast', elevation: 40, sky: (s: number[], m: number[]) => s[2] - s[0] < m[2] - m[0] },
  { name: 'dusk', elevation: 4, sky: (s: number[], m: number[]) => s[0] + s[1] + s[2] < m[0] + m[1] + m[2] },
] as const;

for (const row of TABLE) {
  test(`${row.name} changes the scene`, async ({ page }) => {
    test.slow();
    if ((await rideWith(page, row.name)) !== 'ready') {
      await assertWellFormedDecline(page);
      return;
    }
    const c = await page.evaluate(() => (window as W).__ROWER3D_CONDITIONS);
    expect(c?.name).toBe(row.name);
    expect(c?.sunElevationDeg).toBe(row.elevation);
    if (row.name === 'overcast') {
      expect(c?.sunDisc, 'no sun disc under Overcast (FR4)').toBe(0);
      expect(c?.cloudCover).toBeGreaterThanOrEqual(0.8);
    }
    const sky = await meanSky(page);
    console.log(`[conditions] ${row.name} sky ${sky.map((v) => v.toFixed(1)).join(',')}`);
    test.skip(!middaySky.value, 'the Midday reference did not render');
    const m = middaySky.value as [number, number, number];
    const delta = Math.max(...sky.map((v, i) => Math.abs(v - m[i])));
    expect(delta, `${row.name} sky differs from Midday`).toBeGreaterThan(8);
    expect(row.sky(sky, m), `${row.name} sky moves the expected way from Midday`).toBe(true);
  });
}

test('switching mid-row relights the next frame without a rebuild', async ({ page }) => {
  test.slow();
  if ((await rideWith(page, 'midday')) !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }
  const canvas = page.locator('.rower3d-canvas-container canvas').first();
  const before = await page.evaluate(() => ({
    frame: (window as W).__ROWER3D_FRAME_STATS?.frame ?? 0,
    updates: (window as W).__ROWER3D_CONDITIONS?.updates ?? 0,
  }));
  const skyBefore = await meanSky(page);
  await page.evaluate(() => (window as W).__ROWER3D_SET_CONDITIONS?.('dusk'));
  await forceRender(page);
  const after = await page.evaluate(() => ({
    name: (window as W).__ROWER3D_CONDITIONS?.name,
    updates: (window as W).__ROWER3D_CONDITIONS?.updates ?? 0,
    frame: (window as W).__ROWER3D_FRAME_STATS?.frame ?? 0,
  }));
  expect(after.name).toBe('dusk');
  expect(after.updates).toBe(before.updates + 1);
  // The same scene kept drawing: its frame counter carried on rather than
  // restarting, and the canvas is still the engine's.
  expect(after.frame).toBeGreaterThan(before.frame);
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu');
  const skyAfter = await meanSky(page);
  expect(skyAfter[0] + skyAfter[1] + skyAfter[2]).toBeLessThan(skyBefore[0] + skyBefore[1] + skyBefore[2]);
});
