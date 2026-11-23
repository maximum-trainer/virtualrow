import { test, expect, type Page } from '../fixtures/crash-watch';
import { installRideHarness, startDemoRide } from './helpers/engineRide';

/**
 * #815 — an on-screen camera-angle button on the ride screen.
 *
 * Scenario: the button and the V key share one camera view
 *   Given a demo row
 *   Then a camera button sits in the HUD corner, named for the view and the V key
 *   When the rower clicks it, the view moves on and is remembered
 *   And pressing V afterwards moves it on again from there (AC2)
 *
 * Scenario Outline: the button covers none of the other HUD controls (AC3)
 *   Given a demo row at <viewport>
 *   Then the camera button overlaps no metric tile, ride control, lap or gap badge
 */

const VIEW_KEY = 'virtualrow:camera-view';

const cameraButton = (page: Page) => page.locator('.row-hud-actions .btn-hud-camera');

const storedView = (page: Page) =>
  page.evaluate((key) => localStorage.getItem(key) ?? 'chase', VIEW_KEY);

test('the camera button cycles the view, in step with the V key (#815 AC2)', async ({ page }) => {
  await installRideHarness(page);
  await startDemoRide(page);

  const button = cameraButton(page);
  await expect(button).toBeVisible({ timeout: 20_000 });
  const start = await storedView(page);
  await expect(button).toHaveAttribute('aria-label', `Camera: ${start} (press V to cycle)`);

  // A DOM click, as the other ride specs do: on a software rasteriser the
  // renderer can hold the main thread past the action timeout.
  await page.evaluate(() =>
    (document.querySelector('.row-hud-actions .btn-hud-camera') as HTMLButtonElement | null)?.click(),
  );
  await expect.poll(() => storedView(page)).not.toBe(start);
  const afterClick = await storedView(page);
  await expect(button).toHaveAttribute('aria-label', `Camera: ${afterClick} (press V to cycle)`);

  await page.keyboard.press('v');
  await expect.poll(() => storedView(page)).not.toBe(afterClick);
  const afterKey = await storedView(page);
  await expect(button).toHaveAttribute('data-view', afterKey);
});

for (const vp of [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`${vp.width}x${vp.height}: the camera button covers no other HUD control (#815 AC3)`, async ({ page }) => {
    await page.setViewportSize(vp);
    await installRideHarness(page);
    await startDemoRide(page);
    await expect(cameraButton(page)).toBeVisible({ timeout: 20_000 });

    const overlaps = await page.evaluate(() => {
      const button = document.querySelector('.row-hud-actions .btn-hud-camera')!.getBoundingClientRect();
      const others = [
        ...document.querySelectorAll(
          '.activity-stat-card, .activity-controls button, .row-hud-lap, .row-hud-gap, .btn-hud-fullscreen',
        ),
      ];
      return others
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0)
        .filter(
          ({ r }) =>
            r.left < button.right && r.right > button.left && r.top < button.bottom && r.bottom > button.top,
        )
        .map(({ el }) => el.className);
    });
    expect(overlaps, 'HUD controls under the camera button').toEqual([]);
  });
}
