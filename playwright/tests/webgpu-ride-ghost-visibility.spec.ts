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
  __ROWER3D_GHOST_MASK?: (on: boolean) => void;
  __ROWER3D_HOLD_FRAME?: (on: boolean) => void;
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
    return { w, h, data: Array.from(ctx.getImageData(x0, y0, w, h).data) };
  }, box);

/**
 * The ghost's silhouette against the water right behind it. Three frames
 * of the same box (test-mode seams): the ghost drawn flat magenta
 * (`__ROWER3D_GHOST_MASK`) marks exactly its own pixels, not its
 * reflection or shadow on the water; the normal frame gives the ghost's
 * colour there, and the frame without it (`__ROWER3D_HIDE_GHOST`) the
 * water under those same pixels.
 */
const sampleGhost = async (page: Page, box: Rect) => {
  // Hold the ride still so all three frames show the boat in one place.
  await page.evaluate(() => (window as W).__ROWER3D_HOLD_FRAME?.(true));
  await forceRender(page);
  const withGhost = await grab(page, box);
  await page.evaluate(() => (window as W).__ROWER3D_GHOST_MASK?.(true));
  await forceRender(page);
  const mask = await grab(page, box);
  await page.evaluate(() => (window as W).__ROWER3D_GHOST_MASK?.(false));
  await page.evaluate(() => (window as W).__ROWER3D_HIDE_GHOST?.(true));
  await forceRender(page);
  const without = await grab(page, box);
  await page.evaluate(() => (window as W).__ROWER3D_HIDE_GHOST?.(false));
  await page.evaluate(() => (window as W).__ROWER3D_HOLD_FRAME?.(false));
  await forceRender(page);
  if (!withGhost || !mask || !without) return null;
  if (withGhost.data.length !== without.data.length || mask.data.length !== without.data.length) return null;
  // Magenta: red and blue high, green low. A reflection of it in the
  // water is tinted by the water and fails this.
  const { w, h } = mask;
  const isMask = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const i = (y * w + x) * 4;
    return mask.data[i] > 150 && mask.data[i + 2] > 150 && mask.data[i + 1] < 100;
  };
  // Keep only the mask's interior: a pixel whose neighbours ERODE_PX away
  // are magenta too. The thin oar shafts and the antialiased edges blend
  // with the water in the normal frame and would pull the ghost's colour
  // towards it.
  const ERODE_PX = 2;
  const ghostPx: number[][] = [];
  const waterPx: number[][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isMask(x, y)) continue;
      if (!(isMask(x - ERODE_PX, y) && isMask(x + ERODE_PX, y) && isMask(x, y - ERODE_PX) && isMask(x, y + ERODE_PX))) continue;
      const i = (y * w + x) * 4;
      ghostPx.push([withGhost.data[i], withGhost.data[i + 1], withGhost.data[i + 2]]);
      waterPx.push([without.data[i], without.data[i + 1], without.data[i + 2]]);
    }
  }
  // Medians by luminance, so a few stray pixels don't move the result.
  const medianByLuminance = (px: number[][]): number[] => {
    if (px.length === 0) return [0, 0, 0];
    const sorted = [...px].sort((a, b) => luminance(a) - luminance(b));
    return sorted[Math.floor(sorted.length / 2)];
  };
  return {
    ghostPixels: ghostPx.length,
    ghost: medianByLuminance(ghostPx),
    water: medianByLuminance(waterPx),
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
    // WCAG: the lighter over the darker. The ghost is the darker one (a
    // dark hull, #728 FR2), but either way round counts.
    const [lg, lw] = [luminance(s!.ghost) + 0.05, luminance(s!.water) + 0.05];
    const ratio = Math.max(lg, lw) / Math.min(lg, lw);
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
