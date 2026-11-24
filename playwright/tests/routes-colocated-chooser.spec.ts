import { test, expect } from '../fixtures/crash-watch';

/**
 * #822 phase 2 — routes that start within 1 km of each other open an in-map
 * chooser instead of a cluster that never splits (AC1, AC3, AC6, AC9), and a
 * guest's map draws the bundled outlines with no OSM tile requests (AC8).
 *
 * Fixture: rownative courses 175 "Stonehaven Return" and 181 "CCRC - Stonehaven
 * Return" share one centre in `public/assets/rownative/rownative-index.json`.
 */

const STONEHAVEN = { lng: -2.199599, lat: 56.959194 };

test('a co-located pair opens the chooser; Escape closes it; a guest loads no OSM tiles (#822)', async ({
  page,
}) => {
  const tileRequests: string[] = [];
  page.on('request', (req) => {
    if (/tile\.openstreetmap\.org/i.test(req.url())) tileRequests.push(req.url());
  });

  await page.goto('/virtualrow/app/search', { waitUntil: 'networkidle' });
  await expect(page.getByTestId('route-overview-credit')).toBeVisible();

  await page.waitForFunction(() => typeof window.__ROUTE_OVERVIEW_JUMP === 'function');
  await page.evaluate(
    ({ lng, lat }) => window.__ROUTE_OVERVIEW_JUMP?.(lng, lat, 15),
    STONEHAVEN,
  );

  const pair = page.locator('[data-testid="route-cluster"][data-cluster-count="2"]');
  await expect(pair).toHaveCount(1);
  await pair.click();

  const chooser = page.getByTestId('route-chooser-popup');
  await expect(chooser).toBeVisible();
  await expect(chooser.getByTestId('route-chooser-item')).toHaveCount(2);
  await expect(chooser.getByTestId('route-chooser-item').nth(0)).toContainText('CCRC - Stonehaven Return');
  await expect(chooser.getByTestId('route-chooser-item').nth(1)).toContainText('Stonehaven Return');

  await page.keyboard.press('Escape');
  await expect(chooser).toHaveCount(0);

  expect(tileRequests).toEqual([]);
});
