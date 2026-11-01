/**
 * Loop-row targets (#647 Phase 3, AC2 / AC3 / AC4).
 *
 * Walks the three loop targets end to end through the PM5 BLE mock. Doesn't
 * exercise the engine seam (that's AC5, covered by `__ROWER3D_POS.progress`
 * in the unit tests and in Phase 5's GPU-runner smoke); here the assertions
 * are on the finish detector, the summary and the HUD lap badge, which run
 * fine on SwiftShader.
 *
 * Loop state is seeded through the `virtualrow:ride-loop` localStorage entry
 * the `LoopConfigPanel` reads at mount, so the spec drives real UI code
 * without having to click through the picker on every test.
 */
import { test, expect, type Page } from '../fixtures/crash-watch';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';
// Mirrors `RideLoopTargetKind` in src/lib/ui/rideLoop.ts without crossing the
// Playwright tsconfig include boundary.
type RideLoopTargetKind = 'route' | 'distance' | 'time' | 'free';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockBluetoothPath = path.resolve(__dirname, '../mock-bluetooth.js');

type PM5CharWindow = Window & typeof globalThis & {
  __pm5CharGeneral?: { _dispatch: (value: DataView) => void };
  __pm5CharAdditional?: { _dispatch: (value: DataView) => void };
};

/** Mirrors `dispatchGeneralStatus` in virtualrow.spec.ts (PM5 wire format). */
function dispatchGeneralStatus(page: Page, distanceMeters: number, elapsedSeconds: number) {
  return page.evaluate(({ distanceMeters, elapsedSeconds }) => {
    const buf = new ArrayBuffer(11);
    const v = new Uint8Array(buf);
    const cs = Math.round(elapsedSeconds * 100);
    v[0] = cs & 0xff; v[1] = (cs >> 8) & 0xff; v[2] = (cs >> 16) & 0xff;
    const dm = Math.round(distanceMeters * 10);
    v[3] = dm & 0xff; v[4] = (dm >> 8) & 0xff; v[5] = (dm >> 16) & 0xff;
    v[10] = 2;
    (window as unknown as PM5CharWindow).__pm5CharGeneral?._dispatch(new DataView(buf));
  }, { distanceMeters, elapsedSeconds });
}

function dispatchAdditionalStatus(
  page: Page,
  { elapsedSeconds, strokeRate, heartRate }: { elapsedSeconds: number; strokeRate: number; heartRate: number },
) {
  return page.evaluate(({ elapsedSeconds, strokeRate, heartRate }) => {
    const buf = new ArrayBuffer(11);
    const v = new Uint8Array(buf);
    const cs = Math.round(elapsedSeconds * 100);
    v[0] = cs & 0xff; v[1] = (cs >> 8) & 0xff; v[2] = (cs >> 16) & 0xff;
    v[3] = 0xd0; v[4] = 0x07;
    v[5] = strokeRate;
    v[6] = heartRate;
    v[7] = 0x1c; v[8] = 0x2e;
    v[9] = 0x1c; v[10] = 0x2e;
    (window as unknown as PM5CharWindow).__pm5CharAdditional?._dispatch(new DataView(buf));
  }, { elapsedSeconds, strokeRate, heartRate });
}

async function waitForPM5Connected(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(() => {
    const names = Array.from(document.querySelectorAll('.device-name'));
    const pm5 = names.find((n) => String(n.textContent).includes('Concept2 PM5')) as HTMLElement | undefined;
    if (!pm5) return false;
    const status = pm5.closest('.bluetooth-device-container')?.querySelector('.device-status');
    return !!(status && String(status.textContent).includes('Connected'));
  }, undefined, { timeout });
}

async function waitForHRConnected(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForFunction(() => {
    const containers = Array.from(document.querySelectorAll('.bluetooth-device-container'));
    const hrContainer = containers.find((c) => {
      const name = c.querySelector('.device-name');
      return name && String(name.textContent).includes('Heart Rate Monitor');
    });
    if (!hrContainer) return false;
    const status = hrContainer.querySelector('.device-status');
    return !!(status && String(status.textContent).includes('Connected'));
  }, undefined, { timeout });
}

/** Seed the loop state the LoopConfigPanel reads at mount. */
async function seedLoop(
  page: Page,
  kind: RideLoopTargetKind,
  value?: number,
): Promise<void> {
  await page.addInitScript((state) => {
    try {
      window.localStorage.setItem('virtualrow:ride-loop', JSON.stringify(state));
    } catch { /* ignore */ }
  }, {
    enabled: true,
    kind,
    distanceMeters: kind === 'distance' ? value : 5000,
    timeSeconds: kind === 'time' ? value : 1200,
  });
}

/** Connect PM5 + HR and start the workout; shared across the three target tests. */
async function startRow(page: Page): Promise<void> {
  const initScript = fs.readFileSync(mockBluetoothPath, 'utf8');
  await page.addInitScript({ content: initScript });
  await page.goto('./');

  await page.click('button:has-text("Connect PM5")');
  await waitForPM5Connected(page);

  await page.evaluate(() => {
    const containers = Array.from(document.querySelectorAll('.bluetooth-device-container'));
    const hrContainer = containers.find((c) =>
      c.querySelector('.device-name')?.textContent?.includes('Heart Rate Monitor'),
    );
    (hrContainer?.querySelector('button.btn-connect') as HTMLButtonElement)?.click();
  });
  await waitForHRConnected(page);

  // The loop toggle must be visible and reflect the seeded state.
  await expect(page.getByTestId('loop-config-toggle')).toBeChecked();

  // Keep the harness from short-circuiting the finish test (same gate the
  // base finish spec uses).
  await page.evaluate(() => {
    window.__VIRTUALROW_AUTO_FINISH = true;
  });

  await page.evaluate(() => {
    (document.querySelector('.btn-start-workout') as HTMLButtonElement)?.click();
  });
  await expect(page.locator('.activity-view')).toBeVisible({ timeout: 15_000 });
}

test.describe('ride loop targets (#647 Phase 3)', () => {
  test('loop + distance target: ignores route length, finishes at the chosen metres', async ({ page }) => {
    // AC2: 10 000 m target over the default short demo route. The ride-session
    // store holds laps and the finish; the summary opens after the banner.
    await seedLoop(page, 'distance', 10_000);
    await startRow(page);

    // One lap of a small route — looping holds the finish back.
    await dispatchGeneralStatus(page, 0, 0);
    await dispatchAdditionalStatus(page, { elapsedSeconds: 1, strokeRate: 24, heartRate: 140 });
    await dispatchGeneralStatus(page, 3000, 300); // well past most routes

    const finish = page.getByTestId('finish-banner');
    await expect(finish).toHaveCount(0);

    // Past the target.
    await dispatchGeneralStatus(page, 10_050, 1000);
    await expect(finish).toBeVisible({ timeout: 10_000 });
    await expect(finish).toHaveText(/Finished — 10 000 m/);
  });

  test('loop + time target: never ends on distance, fires on elapsed seconds', async ({ page }) => {
    // AC3: 1200-second target. Dispatch distance past any route length then push
    // elapsed over 1200 to trigger the finish.
    await seedLoop(page, 'time', 1200);
    await startRow(page);

    await dispatchGeneralStatus(page, 0, 0);
    await dispatchAdditionalStatus(page, { elapsedSeconds: 1, strokeRate: 24, heartRate: 140 });
    await dispatchGeneralStatus(page, 50_000, 900); // way past, time short

    const finish = page.getByTestId('finish-banner');
    await expect(finish).toHaveCount(0);

    await dispatchGeneralStatus(page, 55_000, 1210);
    await expect(finish).toBeVisible({ timeout: 10_000 });
  });

  test('loop + free target: never auto-finishes, HUD shows lap count past the seam', async ({ page }) => {
    // AC4: a free row never auto-finishes. AC6: the lap badge appears once the
    // boat crosses the first seam.
    await seedLoop(page, 'free');
    await startRow(page);

    await dispatchGeneralStatus(page, 0, 0);
    await dispatchAdditionalStatus(page, { elapsedSeconds: 1, strokeRate: 24, heartRate: 140 });

    // 10 km past any catalogue route — a free row keeps going.
    await dispatchGeneralStatus(page, 10_000, 1800);
    await expect(page.getByTestId('finish-banner')).toHaveCount(0);

    // Give the HUD a tick and assert the lap pill rendered. The route length
    // isn't fixed by this spec so we only assert the badge appeared.
    await expect(page.getByTestId('row-hud-lap')).toBeVisible({ timeout: 10_000 });
  });
});
