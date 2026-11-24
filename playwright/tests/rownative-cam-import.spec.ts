/**
 * #753 VP-30 FR3 — a gates-only river course, imported end to end against a
 * recorded Overpass answer: rownative course 171, the Head of the Cam. The
 * course file and the answer are the ones the unit tests use
 * (`src/__tests__/fixtures/overpass/`), recorded from the live servers on
 * 2026-11-24 and trimmed to the corridor.
 */
import { test, expect, type Page } from '../fixtures/crash-watch';
import { importCamCourse, serveCamCourse } from './helpers/camCourse';

const selected = (page: Page) => page.evaluate(() => window.__SELECTED_ROUTE);

test.describe('Head of the Cam import (#753 FR3)', () => {
  test('follows the Cam from the recorded map answer: map-derived, 2.6 to 2.8 km', async ({ page }) => {
    await serveCamCourse(page, 'recorded');
    await importCamCourse(page);

    await expect.poll(async () => (await selected(page))?.geometrySource, { timeout: 30_000 }).toBe('osm-derived');
    const route = await selected(page);
    expect(route!.distanceKm).toBeGreaterThan(2.6);
    expect(route!.distanceKm).toBeLessThan(2.8);

    // The card says so.
    await page.getByRole('button', { name: 'Row', exact: true }).click();
    const card = page.locator('.route-info-overlay');
    await expect(card.locator('.meta-badge--osm')).toHaveText('path from map data');
    const distance = await card.locator('.meta-badge', { hasText: 'km' }).first().textContent();
    const km = Number(/([\d.]+)\s*km/.exec(distance ?? '')?.[1]);
    expect(km).toBeGreaterThan(2.6);
    expect(km).toBeLessThan(2.8);
  });

  test('still imports on the gate chain when Overpass fails', async ({ page }) => {
    await serveCamCourse(page, 'failing');
    await importCamCourse(page);
    await expect(page.getByTestId('route-tracing')).toHaveCount(0, { timeout: 30_000 });
    expect((await selected(page))?.geometrySource).toBe('gate-chain');
    await page.getByRole('button', { name: 'Row', exact: true }).click();
    await expect(page.locator('.route-info-overlay .meta-badge--outline')).toBeVisible();
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
  });
});
