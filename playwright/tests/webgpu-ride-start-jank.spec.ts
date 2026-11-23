import { test, expect } from '../fixtures/crash-watch';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  installRideHarness,
  pinTier,
  startDemoRide,
  waitForRideOutcome,
  assertWellFormedDecline,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/**
 * #729 VP-11 FR6 — starting a row does not freeze the UI.
 *
 * Scenario: starting a row does not freeze the UI
 *   Given the home screen on a hardware GPU with a longtask observer installed
 *   When the demo row is started and the ride reports ready (its first frames
 *     have been presented behind the loading screen, #803)
 *   Then no long task exceeds 50 ms in that window
 *   And the measures vr:attach:pipelines, vr:attach:atlas, vr:attach:route exist
 *
 * Needs a hardware GPU (declines elsewhere). Every long task in the window
 * is logged with its start and length, so a failure says where to look.
 */

const LONG_TASK_BUDGET_MS = 50;

type JankWindow = Window & {
  __JANK?: { tasks: { start: number; duration: number }[]; clickAt: number | null };
};

test('starting a demo row has no main-thread task over 50 ms (#729 FR6)', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await installRideHarness(page);
  await pinTier(page, 'medium');
  await page.addInitScript(() => {
    const jank = { tasks: [] as { start: number; duration: number }[], clickAt: null as number | null };
    (window as JankWindow).__JANK = jank;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) jank.tasks.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* no longtask support: the spec reports zero tasks */
    }
    document.addEventListener(
      'click',
      (event) => {
        if ((event.target as Element | null)?.closest?.('.btn-try-demo')) jank.clickAt = performance.now();
      },
      true,
    );
  });

  await startDemoRide(page);
  if ((await waitForRideOutcome(page, 60_000)) !== 'ready') {
    await assertWellFormedDecline(page);
    return;
  }
  const readyAt = await page.evaluate(() => performance.now());

  const result = await page.evaluate(
    (end) => {
      const jank = (window as JankWindow).__JANK!;
      const from = jank.clickAt ?? 0;
      const measures = ['pipelines', 'atlas', 'route'].map((p) => ({
        phase: p,
        count: performance.getEntriesByName(`vr:attach:${p}`, 'measure').length,
        ms: Math.round(
          performance
            .getEntriesByName(`vr:attach:${p}`, 'measure')
            .reduce((sum, m) => sum + m.duration, 0),
        ),
      }));
      return {
        clickAt: jank.clickAt,
        tasks: jank.tasks
          .filter((t) => t.start + t.duration >= from && t.start <= end)
          .map((t) => ({ atMs: Math.round(t.start - from), ms: Math.round(t.duration) })),
        measures,
      };
    },
    readyAt,
  );
  console.log(`[ride-start] long tasks after the click: ${JSON.stringify(result.tasks)}`);
  console.log(`[ride-start] attach measures: ${JSON.stringify(result.measures)}`);

  expect(result.clickAt, 'the demo click was seen').not.toBeNull();
  for (const m of result.measures) expect(m.count, `vr:attach:${m.phase}`).toBeGreaterThan(0);
  const over = result.tasks.filter((t) => t.ms > LONG_TASK_BUDGET_MS);
  expect(over, `main-thread tasks over ${LONG_TASK_BUDGET_MS} ms between the click and ready`).toEqual([]);
});
