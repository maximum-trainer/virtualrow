/**
 * #647 Phase 5 / AC5 — real-GPU smoke that the boat wraps around the loop
 * seam. Lives at `/smoke/loop`: a 100 m straight route and a stub `getFrame`
 * whose cumulative `distanceMeters` grows at 50 m/s past the route length,
 * with `loop: true`. The test polls `__ROWER3D_POS.progress` for a sample
 * near the end of a lap and a sample near the start of the next, so a
 * modulo wrap is observed on the real GPU and not just in unit tests.
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

type PosWin = Window & typeof globalThis & {
  __ROWER3D_POS?: { progress: number };
};

test('webgpu loop smoke — progress wraps across the seam', async ({ page }) => {
  await page.goto('./smoke/loop');
  const main = page.getByTestId('webgpu-loop-smoke');
  await expect(main).toBeVisible();

  // Reach `ready` (or `unavailable` on a runner with no WebGPU — the gpu
  // runner is where the real assertion lives; software adapters are allowed
  // to decline).
  await expect(main).toHaveAttribute('data-status', /ready|unavailable/, { timeout: 20_000 });
  const status = await main.getAttribute('data-status');
  if (status === 'unavailable') {
    test.skip(true, 'WebGPU unavailable on this runner — loop wrap is checked on the GPU runner.');
    return;
  }

  // The stub advances at 50 m/s past a 100 m route length (loop:true), so a
  // sample at a near-1 progress and a sample a short time later should land
  // on a smaller progress — the modulo wrap. Poll several samples and
  // assert the sequence contains at least one decrease greater than 0.5
  // (unambiguously a wrap rather than noise).
  const progresses: number[] = [];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && progresses.length < 20) {
    const p = await page.evaluate(() => (window as unknown as PosWin).__ROWER3D_POS?.progress ?? null);
    if (typeof p === 'number') progresses.push(p);
    await page.waitForTimeout(300);
  }

  let sawWrap = false;
  for (let i = 1; i < progresses.length; i++) {
    if (progresses[i - 1] - progresses[i] > 0.5) {
      sawWrap = true;
      break;
    }
  }
  expect(
    sawWrap,
    `expected a 1 → 0 wrap in __ROWER3D_POS.progress; got ${progresses.join(', ')}`,
  ).toBe(true);

  // Every sampled progress must be in [0, 1) — never clamp at 1 on a looped
  // row, which is what Phase 1's modulo wrap in characterPlacement delivers.
  for (const p of progresses) {
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
  }
});
