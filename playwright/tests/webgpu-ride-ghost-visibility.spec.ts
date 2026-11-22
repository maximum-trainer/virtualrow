import { test, expect, type Page } from '../fixtures/crash-watch';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  installRideHarness,
  pinTier,
  selectPaceGhost,
  waitForRideOutcome,
  forceRender,
  assertWellFormedDecline,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/**
 * #728 VP-10 — the race ghost was a pale cyan placeholder hull, nearly
 * invisible over teal water, with no oars, 2.5 m off the player's blades.
 *
 * Scenario: ghost is visible
 *   Given the ghost a few metres ahead in each of the five lighting conditions
 *   Then the ghost silhouette contrast ratio against adjacent water is >= 3
 *
 * Scenario: ghost is the scull, a full lane off, and rows
 *   Then __ROWER3D_GHOST_METERS reports model 'scull', lane <= -7 m, and a cadence
 *
 * Scenario: the marker
 *   Given the ghost more than 30 m ahead
 *   Then the canvas shows a "Ghost N m" marker
 *
 * GPU runner only; on a VM without a hardware adapter the engine declines
 * and the spec asserts the fallback instead. The blade-clearance and the
 * fleet "does not blink" scenarios are covered in fleet.test.ts.
 */

type Rect = { left: number; top: number; right: number; bottom: number };
type Ghost = {
  active: boolean;
  value: number;
  model?: string;
  lane?: number;
  cadenceSpm?: number;
  screenBounds?: Rect | null;
};
type W = Window & {
  __ROWER3D_GHOST_METERS?: Ghost;
  __ROWER3D_BOAT?: { distanceMeters: number };
  __ROWER3D_SET_CONDITIONS?: (c: string) => void;
  __ROWER3D_HIDE_GHOST?: (hidden: boolean) => void;
};

const startWithGhost = async (page: Page, pace: string): Promise<'ready' | 'fallback'> => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installRideHarness(page);
  await pinTier(page, 'medium');
  await page.goto('./');
  await page.waitForSelector('.route-info-overlay h2', { timeout: 15_000 });
  await selectPaceGhost(page, pace);
  await page.evaluate(() => {
    (document.querySelector('.btn-try-demo') as HTMLButtonElement | null)?.click();
  });
  await page.waitForURL(/\/row(\/)?$/, { timeout: 15_000 });
  return waitForRideOutcome(page, 45_000);
};

/** Metres the ghost leads the rower by (positive = ghost ahead). */
const ghostLead = async (page: Page): Promise<number> => {
  await forceRender(page);
  return page.evaluate(() => {
    const w = window as W;
    return (w.__ROWER3D_GHOST_METERS?.value ?? 0) - (w.__ROWER3D_BOAT?.distanceMeters ?? 0);
  });
};

const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: number[]): number =>
  0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);

/** The canvas pixels inside `box` (CSS px), as RGBA bytes. */
const grab = (page: Page, box: Rect) =>
  page.locator('.rower3d-canvas-container canvas').first().evaluate((el, b) => {
    const c = el as HTMLCanvasElement;
    const sx = c.width / c.clientWidth;
    const sy = c.height / c.clientHeight;
    const tmp = document.createElement('canvas');
    tmp.width = c.width;
    tmp.height = c.height;
    const ctx = tmp.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(c, 0, 0);
    const x0 = Math.max(0, Math.floor(b.left * sx));
    const y0 = Math.max(0, Math.floor(b.top * sy));
    const w = Math.min(c.width, Math.ceil(b.right * sx)) - x0;
    const h = Math.min(c.height, Math.ceil(b.bottom * sy)) - y0;
    if (w < 4 || h < 4) return null;
    return Array.from(ctx.getImageData(x0, y0, w, h).data);
  }, box);

/**
 * The ghost's silhouette against the water right behind it: the same box
 * drawn with and without the ghost (`__ROWER3D_HIDE_GHOST`, test mode).
 * Pixels the ghost changed are its silhouette; the hidden frame gives the
 * water under exactly those pixels. Nothing else on screen counts.
 */
const sampleGhost = async (page: Page, box: Rect) => {
  const withGhost = await grab(page, box);
  await page.evaluate(() => (window as W).__ROWER3D_HIDE_GHOST?.(true));
  await forceRender(page);
  const without = await grab(page, box);
  await page.evaluate(() => (window as W).__ROWER3D_HIDE_GHOST?.(false));
  await forceRender(page);
  if (!withGhost || !without || withGhost.length !== without.length) return null;
  const ghost = [0, 0, 0];
  const water = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < withGhost.length; i += 4) {
    const d =
      Math.abs(withGhost[i] - without[i]) +
      Math.abs(withGhost[i + 1] - without[i + 1]) +
      Math.abs(withGhost[i + 2] - without[i + 2]);
    if (d < 24) continue;
    for (let k = 0; k < 3; k++) {
      ghost[k] += withGhost[i + k];
      water[k] += without[i + k];
    }
    n += 1;
  }
  return {
    ghostPixels: n,
    ghost: ghost.map((v) => v / Math.max(1, n)),
    water: water.map((v) => v / Math.max(1, n)),
  };
};

test('the ghost is the scull, a full lane off, rowing, and stands off the water in every light', async ({ page }) => {
  test.slow();
  if ((await startWithGhost(page, '1:55')) !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }
  // A 1:55 ghost against the ~2:00 demo row pulls ahead slowly; wait until
  // it leads by a few metres, still close enough to be large on screen.
  await expect.poll(() => ghostLead(page), { timeout: 90_000, intervals: [500] }).toBeGreaterThanOrEqual(3);

  const g = await page.evaluate(() => (window as W).__ROWER3D_GHOST_METERS);
  expect(g?.model, 'drawn from the scull GLB (FR1)').toBe('scull');
  expect(g?.lane ?? 0, 'a full lane to port (FR3)').toBeLessThanOrEqual(-7);
  expect(g?.cadenceSpm ?? 0, 'the ghost rows (FR1)').toBeGreaterThan(18);

  for (const c of ['dawn', 'midday', 'golden', 'overcast', 'dusk']) {
    await page.evaluate((name) => (window as W).__ROWER3D_SET_CONDITIONS?.(name), c);
    for (let i = 0; i < 3; i++) await forceRender(page);
    const b = await page.evaluate(() => (window as W).__ROWER3D_GHOST_METERS?.screenBounds ?? null);
    expect(b, `${c}: ghost on screen`).not.toBeNull();
    const s = await sampleGhost(page, b as Rect);
    expect(s, `${c}: ghost box readable`).not.toBeNull();
    const ratio = (luminance(s!.ghost) + 0.05) / (luminance(s!.water) + 0.05);
    console.log(
      `[ghost] ${c} pixels ${s!.ghostPixels} ghost ${s!.ghost.map((v) => v.toFixed(0))} water ${s!.water.map((v) => v.toFixed(0))} ratio ${ratio.toFixed(2)}`,
    );
    expect(s!.ghostPixels, `${c}: the ghost shows`).toBeGreaterThan(40);
    expect(ratio, `${c}: contrast against the water (FR2)`).toBeGreaterThanOrEqual(3);
  }
});

test('a ghost more than 30 m ahead carries a marker with the gap', async ({ page }) => {
  test.slow();
  if ((await startWithGhost(page, '1:40')) !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }
  await expect.poll(() => ghostLead(page), { timeout: 120_000, intervals: [1_000] }).toBeGreaterThan(32);
  await forceRender(page);
  const marker = page.locator('.rower3d-canvas-container .ghost-marker');
  await expect(marker).toBeVisible({ timeout: 5_000 });
  await expect(marker).toHaveText(/Ghost \d+ m/);
  await expect(marker).toHaveAttribute('data-ahead', 'true');
});
