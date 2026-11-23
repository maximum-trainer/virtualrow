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
import { latticePeakShare } from '../../src/lib/renderer/engine/latticeSpectrum';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/**
 * #734 VP-16 — the river was a regular checkerboard from the high camera,
 * and the boat and the kit scenery took no shadow.
 *
 * Scenario: no lattice
 *   Given a frozen high-camera frame over open water
 *   When the 2D FFT of the water region's luma is taken
 *   Then no single non-DC peak holds more than 8% of the spectral energy
 *
 * Scenario: the rower is shaded under a bridge
 *   Given the boat frozen directly beneath the Willowbrook bridge deck at tier medium
 *   Then the mean luma of the hull pixels is <= 0.6x its value 30 m before the bridge
 *
 * The spectrum is `latticePeakShare` (rows detrended for the distance
 * gradient, Hann window); its CPU twin runs in waterWaves.test.ts. The hull
 * is found by drawing it flat magenta (`__ROWER3D_PLAYER_MASK`).
 *
 * GPU runner only; without a hardware adapter the engine declines and the
 * spec asserts the fallback instead.
 */

type Rect = { left: number; top: number; right: number; bottom: number };
type Span = { id: string; ceiling: number | null };
type W = Window & {
  __ROWER3D_ROUTE?: { totalDistance: number; spans?: Span[] };
  __ROWER3D_BOAT?: { distanceMeters: number; screenBounds?: Rect | null };
  __ROWER3D_SEEK_METERS?: (metres: number | null) => void;
  __ROWER3D_HOLD_FRAME?: (on: boolean) => void;
  __ROWER3D_PLAYER_MASK?: (on: boolean) => void;
  __ROWER3D_HIDE_GHOST?: (hidden: boolean) => void;
};

const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luma = (d: number[], i: number): number =>
  0.2126 * srgbToLinear(d[i]) + 0.7152 * srgbToLinear(d[i + 1]) + 0.0722 * srgbToLinear(d[i + 2]);

/** RGBA bytes inside `box` (CSS px of the canvas), from a page screenshot. */
const grab = async (page: Page, box: Rect) => {
  const canvas = page.locator('.rower3d-canvas-container canvas').first();
  const at = await canvas.boundingBox();
  if (!at) return null;
  const clip = {
    x: Math.floor(at.x + Math.max(0, box.left)),
    y: Math.floor(at.y + Math.max(0, box.top)),
    width: Math.ceil(Math.min(box.right, at.width) - Math.max(0, box.left)),
    height: Math.ceil(Math.min(box.bottom, at.height) - Math.max(0, box.top)),
  };
  if (clip.width < 4 || clip.height < 4) return null;
  const png = (await page.screenshot({ clip, scale: 'css' })).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
  }, png);
};

const settle = async (page: Page) => {
  await forceRender(page);
  await forceRender(page);
};

const seek = async (page: Page, metres: number) => {
  await page.evaluate(() => (window as W).__ROWER3D_HOLD_FRAME?.(false));
  await page.evaluate((m) => (window as W).__ROWER3D_SEEK_METERS?.(m), metres);
  await settle(page);
  await page.evaluate(() => (window as W).__ROWER3D_HOLD_FRAME?.(true));
  await settle(page);
};

/** Mean luma of the hull's own pixels (the magenta mask, eroded 2 px), or null. */
const hullLuma = async (page: Page): Promise<number | null> => {
  const box = await page.evaluate(() => (window as W).__ROWER3D_BOAT?.screenBounds ?? null);
  if (!box) return null;
  const shot = await grab(page, box);
  await page.evaluate(() => (window as W).__ROWER3D_PLAYER_MASK?.(true));
  await settle(page);
  const mask = await grab(page, box);
  await page.evaluate(() => (window as W).__ROWER3D_PLAYER_MASK?.(false));
  await settle(page);
  if (!shot || !mask || shot.data.length !== mask.data.length) return null;
  const { w, h } = mask;
  const isMask = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const i = (y * w + x) * 4;
    return mask.data[i] > 150 && mask.data[i + 2] > 150 && mask.data[i + 1] < 100;
  };
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!(isMask(x, y) && isMask(x - 2, y) && isMask(x + 2, y) && isMask(x, y - 2) && isMask(x, y + 2))) continue;
      sum += luma(shot.data, (y * w + x) * 4);
      n += 1;
    }
  }
  return n >= 30 ? sum / n : null;
};

const start = async (page: Page, view: 'high' | 'chase'): Promise<boolean> => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installRideHarness(page);
  await pinTier(page, 'medium');
  await page.addInitScript((v) => {
    try { localStorage.setItem('virtualrow:camera-view', v); } catch { /* private mode */ }
  }, view);
  await startDemoRide(page);
  if ((await waitForRideOutcome(page, 45_000)) !== 'ready') {
    await assertWellFormedDecline(page);
    return false;
  }
  await page.evaluate(() => (window as W).__ROWER3D_HIDE_GHOST?.(true));
  await forceRender(page);
  return true;
};

test('Scenario: no lattice — the open water from the high camera has no dominant frequency', async ({ page }) => {
  test.slow();
  if (!(await start(page, 'high'))) return;
  const route = await page.evaluate(() => (window as W).__ROWER3D_ROUTE);
  // Between the two Willowbrook arches (15% and later): open river.
  await seek(page, 0.3 * (route?.totalDistance ?? 0));
  const boat = await page.evaluate(() => (window as W).__ROWER3D_BOAT?.screenBounds ?? null);
  expect(boat, 'boat on screen').toBeTruthy();
  // The river runs up the screen from the boat: a 96 px square of it,
  // centred over the boat and clear of its bow.
  const cx = Math.round((boat!.left + boat!.right) / 2);
  const box = { left: cx - 48, right: cx + 48, top: boat!.top - 120, bottom: boat!.top - 24 };
  const shot = await grab(page, box);
  expect(shot, 'water patch').toBeTruthy();
  const grid: number[][] = [];
  for (let y = 0; y < shot!.h; y++) {
    const row: number[] = [];
    for (let x = 0; x < shot!.w; x++) row.push(luma(shot!.data, (y * shot!.w + x) * 4));
    grid.push(row);
  }
  const share = latticePeakShare(grid);
  test.info().annotations.push({ type: 'lattice-peak-share', description: share.toFixed(4) });
  expect(share, 'largest non-DC peak share of the water patch').toBeLessThanOrEqual(0.08);
});

test('Scenario: the rower is shaded under a bridge', async ({ page }) => {
  test.slow();
  if (!(await start(page, 'chase'))) return;
  const route = await page.evaluate(() => (window as W).__ROWER3D_ROUTE);
  const arches = (route?.spans ?? []).filter((s) => s.id === 'c01-bridge-arch-masonry');
  expect(arches.length, 'the Willowbrook arches are placed').toBeGreaterThan(0);
  // The first arch is at 15% of the route (webgpu-bridge-traverse.spec.ts).
  // Walk the boat through it a metre at a time; the darkest hull is where
  // it sits in the deck's shadow.
  const at = 0.15 * (route?.totalDistance ?? 0);
  let darkest = { metres: at, luma: Infinity };
  for (let m = at - 20; m <= at + 20; m += 1) {
    await seek(page, m);
    const l = await hullLuma(page);
    if (l !== null && l < darkest.luma) darkest = { metres: m, luma: l };
  }
  expect(Number.isFinite(darkest.luma), 'hull pixels found under the bridge').toBe(true);
  await seek(page, darkest.metres - 30);
  const open = await hullLuma(page);
  expect(open, 'hull pixels found 30 m before the bridge').not.toBeNull();
  test.info().annotations.push({
    type: 'hull-luma',
    description: `under ${darkest.luma.toFixed(4)} at ${darkest.metres.toFixed(0)} m, open ${open!.toFixed(4)}`,
  });
  expect(darkest.luma, 'hull under the deck vs 30 m before').toBeLessThanOrEqual(0.6 * open!);
});
