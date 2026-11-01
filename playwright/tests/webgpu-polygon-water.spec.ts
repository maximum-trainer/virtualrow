import { test, expect } from '../fixtures/crash-watch';

// `--enable-unsafe-webgpu` so Chromium exposes `navigator.gpu`. On a runner
// without a WebGPU backend the engine falls back to null and the spec
// asserts the unavailable path (same shape as the other smokes).
test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgl',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-unsafe-webgpu',
      '--no-sandbox',
      '--disable-gpu-rasterization',
      '--disable-gpu-compositing',
      '--disable-dev-shm-usage',
    ],
  },
});

interface PolygonWaterTelemetry {
  lakeCount: number;
  maxRingVertices: number;
  totalVertices: number;
  tierCap: number;
  fallback: boolean;
}

/**
 * #493 AC6 follow-up — polygon-water end-to-end coverage.
 *
 * `src/__tests__/lakeRouteOnWater.test.ts` already pins the D21-ii fall-
 * back at the enrichment level: samples off the lake are recorded in
 * `lakes.offWater` and surfaced on the detection telemetry. What was
 * missing was proof that the engine's Phase 3+ polygon-water path
 * actually fires on a route whose enrichment carries lakes — so a
 * Playwright run can distinguish the polygon pass from the ribbon
 * fallback. The new `__ROWER3D_POLYGON_WATER` global closes that gap.
 *
 * This spec loads the hidden `/smoke/water` route, which mounts the
 * engine with a canned square lake + one island hole, and asserts:
 *
 *   - polygon water is wired (`lakeCount === 1`, `fallback === false`);
 *   - the simplified ring count stays under the tier cap (Phase 5 /
 *     FR9 / AC7);
 *   - hole vertices are summed into `totalVertices`;
 *   - the kill switch (`__VIRTUALROW_POLYGON_WATER = false`) flips the
 *     engine to the ribbon on reattach (`fallback === true`,
 *     `lakeCount === 0`).
 *
 * On a runner without a WebGPU adapter the fallback branch mirrors the
 * engine smoke: `data-status === "unavailable"` and
 * `__VIRTUALROW_WEBGPU_HEALTH` publishes a fallback reason.
 */
test('webgpu polygon-water smoke', async ({ page }) => {
  await page.goto('./smoke/water');
  const main = page.getByTestId('webgpu-polygon-water-smoke');
  await expect(main).toBeVisible();

  const status = await main.getAttribute('data-status');
  if (status === 'ready') {
    const canvas = main.locator('canvas').first();
    await expect(canvas).toHaveAttribute('data-backend', 'webgpu');

    const telemetry = await page.evaluate(
      () =>
        (window as unknown as {
          __ROWER3D_POLYGON_WATER?: PolygonWaterTelemetry;
        }).__ROWER3D_POLYGON_WATER,
    );
    expect(telemetry, '__ROWER3D_POLYGON_WATER must be published').toBeDefined();
    expect(telemetry?.lakeCount).toBe(1);
    expect(telemetry?.fallback).toBe(false);
    // Outer 4 + hole 4 = 8 before simplification. The 4-vertex outer
    // ring is already under every tier cap, so the simplifier returns
    // it by reference (per `polygonSimplify.ts`).
    expect(telemetry?.maxRingVertices).toBe(4);
    expect(telemetry?.totalVertices).toBe(8);
    // tierCap is per-tier; the smoke runs on the default (`medium`),
    // whose polygonWaterMaxVertices is 1024. We only assert the ring
    // count is UNDER the cap — the exact tier value is pinned by
    // `tierCaps.test.ts`.
    expect(telemetry?.tierCap).toBeGreaterThan(0);
    expect(telemetry?.maxRingVertices).toBeLessThanOrEqual(telemetry!.tierCap);
  } else {
    const health = await page.evaluate(
      () =>
        (window as unknown as {
          __VIRTUALROW_WEBGPU_HEALTH?: { fallbackReason?: string };
        }).__VIRTUALROW_WEBGPU_HEALTH,
    );
    expect(health?.fallbackReason).toBeTruthy();
  }
});

/**
 * The kill switch (`__VIRTUALROW_POLYGON_WATER = false`) is a live
 * rollback for the Phase 4 default-on behaviour (#493 AC13 / NFR7).
 * Flipping it before attach must send the engine to the ribbon.
 */
test('webgpu polygon-water kill switch falls back to the ribbon', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __VIRTUALROW_POLYGON_WATER?: boolean }).__VIRTUALROW_POLYGON_WATER = false;
  });
  await page.goto('./smoke/water');
  const main = page.getByTestId('webgpu-polygon-water-smoke');
  await expect(main).toBeVisible();

  const status = await main.getAttribute('data-status');
  if (status === 'ready') {
    const telemetry = await page.evaluate(
      () =>
        (window as unknown as {
          __ROWER3D_POLYGON_WATER?: PolygonWaterTelemetry;
        }).__ROWER3D_POLYGON_WATER,
    );
    expect(telemetry, '__ROWER3D_POLYGON_WATER must still publish on fallback').toBeDefined();
    expect(telemetry?.fallback).toBe(true);
    expect(telemetry?.lakeCount).toBe(0);
    expect(telemetry?.totalVertices).toBe(0);
  } else {
    const health = await page.evaluate(
      () =>
        (window as unknown as {
          __VIRTUALROW_WEBGPU_HEALTH?: { fallbackReason?: string };
        }).__VIRTUALROW_WEBGPU_HEALTH,
    );
    expect(health?.fallbackReason).toBeTruthy();
  }
});
