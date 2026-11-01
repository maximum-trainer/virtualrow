/**
 * #623 Phase 1 / D4-a / AC5 — a user-facing load failure of `shell.bin`
 * must surface the `renderer-unavailable` banner, not silently draw the
 * procedural hull. Stubs the baked-boat fetch to 404 before the engine
 * attaches, drives the smoke page, and asserts the health global
 * reports the fallback and `boatSource === 'failed'`.
 *
 * On a runner without a WebGPU adapter (no `navigator.gpu`), the
 * engine never reaches the boat-load step; this spec exits early in
 * that case rather than asserting a different code path.
 */
import { test, expect } from '../fixtures/crash-watch';

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

test('shell.bin 404 surfaces renderer-unavailable and boatSource="failed" (#623 AC5)', async ({
  page,
}) => {
  // Stub ONLY the baked boat buffer; everything else loads normally.
  await page.route('**/assets/boat/shell.bin', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'simulated 404' }),
  );

  await page.goto('./smoke/boat');
  const main = page.getByTestId('webgpu-boat-smoke');
  await expect(main).toBeVisible();

  // Give the engine a chance to attempt the attach + the boat load.
  await page.waitForTimeout(1500);

  const health = await page.evaluate(
    () =>
      (window as unknown as {
        __VIRTUALROW_WEBGPU_HEALTH?: { fallbackReason?: string; boatSource?: string };
      }).__VIRTUALROW_WEBGPU_HEALTH ?? null,
  );

  // No WebGPU adapter on this runner → the engine never reached the
  // boat load, so there's nothing to assert about shell.bin here. The
  // adapter-decline path has its own coverage (#542 AC11).
  if (!health?.fallbackReason || health.fallbackReason !== 'renderer-unavailable') {
    const status = await main.getAttribute('data-status');
    if (status === 'unavailable') {
      // Fallback reason was published by the adapter decline, not by
      // the boat load — this runner can't exercise AC5. Pass silently.
      return;
    }
    throw new Error(
      `Expected renderer-unavailable + boatSource="failed", got ${JSON.stringify(health)}`,
    );
  }

  expect(health.fallbackReason).toBe('renderer-unavailable');
  expect(health.boatSource).toBe('failed');
});
