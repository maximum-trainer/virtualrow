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
 * #731 VP-13 — anti-aliasing and the device pixel ratio.
 *
 * Scenario: edges are anti-aliased
 *   Given a frozen frame at tier medium
 *   Then along the boat's silhouette the count of intermediate pixels per
 *   100 edge pixels is >= 60
 *
 * The silhouette is read from the player's scull drawn flat magenta
 * (`__ROWER3D_PLAYER_MASK`): with 4x MSAA its edge pixels blend magenta with
 * what is behind; without anti-aliasing they are one or the other.
 *
 * Scenario: the backing store follows the device pixel ratio within the tier cap
 *   Given deviceScaleFactor 2 at tier medium (cap 1.5)
 *   Then __ROWER3D_SURFACE reports scale 1.5, a backing store 1.5x the CSS
 *   size, and MSAA
 *
 * GPU runner only; without a hardware adapter the engine declines and the
 * spec asserts the fallback instead.
 */

type Rect = { left: number; top: number; right: number; bottom: number };
type Surface = {
  cssWidth: number;
  cssHeight: number;
  devicePixelRatio: number;
  scale: number;
  width: number;
  height: number;
  antialias: string;
};
type W = Window & {
  __ROWER3D_BOAT?: { screenBounds?: Rect | null };
  __ROWER3D_SEEK_METERS?: (metres: number | null) => void;
  __ROWER3D_HOLD_FRAME?: (on: boolean) => void;
  __ROWER3D_PLAYER_MASK?: (on: boolean) => void;
  __ROWER3D_HIDE_GHOST?: (hidden: boolean) => void;
  __ROWER3D_SURFACE?: Surface;
};

const settle = async (page: Page) => {
  await forceRender(page);
  await forceRender(page);
};

const start = async (page: Page): Promise<boolean> => {
  await installRideHarness(page);
  await pinTier(page, 'medium');
  await page.addInitScript(() => {
    try { localStorage.setItem('virtualrow:camera-view', 'chase'); } catch { /* private mode */ }
  });
  await startDemoRide(page);
  if ((await waitForRideOutcome(page, 45_000)) !== 'ready') {
    await assertWellFormedDecline(page);
    return false;
  }
  await page.evaluate(() => (window as W).__ROWER3D_HIDE_GHOST?.(true));
  await forceRender(page);
  return true;
};

/** RGBA of the canvas inside `box` (CSS px), at device resolution. */
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
  if (clip.width < 8 || clip.height < 8) return null;
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

test('Scenario: edges are anti-aliased — the boat silhouette blends into what is behind it at medium', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 720 });
  if (!(await start(page))) return;
  await page.evaluate(() => (window as W).__ROWER3D_SEEK_METERS?.(300));
  await settle(page);
  await page.evaluate(() => (window as W).__ROWER3D_HOLD_FRAME?.(true));
  await page.evaluate(() => (window as W).__ROWER3D_PLAYER_MASK?.(true));
  await settle(page);
  const surface = await page.evaluate(() => (window as W).__ROWER3D_SURFACE);
  expect(surface?.antialias).toBe('msaa');
  const box = await page.evaluate(() => (window as W).__ROWER3D_BOAT?.screenBounds ?? null);
  expect(box, 'the boat is on screen').not.toBeNull();
  const shot = await grab(page, { left: box!.left - 8, top: box!.top - 8, right: box!.right + 8, bottom: box!.bottom + 8 });
  expect(shot).not.toBeNull();
  const { w, h, data } = shot!;
  // How magenta a pixel is: 1 inside the flat mask, 0 on water or bank.
  const score = new Float32Array(w * h);
  let top = 0;
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    score[i] = Math.max(0, (r + b) / 2 - g);
    if (score[i] > top) top = score[i];
  }
  expect(top, 'the magenta mask is drawn').toBeGreaterThan(100);
  const inside = (i: number) => score[i] >= 0.85 * top;
  const between = (i: number) => score[i] > 0.15 * top && score[i] < 0.85 * top;
  // Edge pixels: not inside the mask but touching it, or part-way between.
  let edges = 0;
  let intermediate = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (inside(i)) continue;
      const touches = inside(i - 1) || inside(i + 1) || inside(i - w) || inside(i + w);
      if (!touches && !between(i)) continue;
      edges += 1;
      if (between(i)) intermediate += 1;
    }
  }
  test.info().annotations.push({ type: 'aa-edge', description: `${intermediate} intermediate of ${edges} edge pixels` });
  expect(edges, 'enough silhouette to judge').toBeGreaterThan(40);
  expect((100 * intermediate) / edges).toBeGreaterThanOrEqual(60);
});

test.describe('at deviceScaleFactor 2', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 720 } });

  test('Scenario: the backing store follows the device pixel ratio within the tier cap', async ({ page }) => {
    test.slow();
    if (!(await start(page))) return;
    await settle(page);
    const s = await page.evaluate(() => (window as W).__ROWER3D_SURFACE);
    expect(s).toBeDefined();
    expect(s!.devicePixelRatio).toBe(2);
    // medium caps the ratio at 1.5; 1.5x the CSS size stays under its 2.1 MP ceiling here.
    expect(s!.scale).toBeCloseTo(1.5, 2);
    expect(Math.abs(s!.width - s!.cssWidth * 1.5)).toBeLessThanOrEqual(1);
    expect(Math.abs(s!.height - s!.cssHeight * 1.5)).toBeLessThanOrEqual(1);
    expect(s!.antialias).toBe('msaa');
  });
});
