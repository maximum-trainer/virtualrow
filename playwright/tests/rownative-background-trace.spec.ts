/**
 * #750 VP-27 — a gates-only river course is in My routes at once, on its gate
 * chain, and the same route takes the mapped river when the waterway lookup
 * answers. Overpass is served from the test, delayed, so the import is timed
 * against a lookup that is still running.
 */
import { test, expect, type Page } from '../fixtures/crash-watch';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockBluetoothPath = path.resolve(__dirname, '../mock-bluetooth.js');

/** A 2 km gates-only course on a river (the name says nothing of a lake). */
const COURSE = {
  id: '900',
  name: 'Bend Head',
  country: 'United Kingdom',
  distance_m: 2000,
  status: 'established',
  polygons: [
    { name: 'Start', order: 0, points: [{ lat: 51.9999, lon: -0.0002 }, { lat: 51.9999, lon: 0.0002 }, { lat: 52.0001, lon: 0.0002 }, { lat: 52.0001, lon: -0.0002 }] },
    { name: 'Finish', order: 1, points: [{ lat: 52.0179, lon: -0.0002 }, { lat: 52.0179, lon: 0.0002 }, { lat: 52.0181, lon: 0.0002 }, { lat: 52.0181, lon: -0.0002 }] },
  ],
};

/** The river between the gates swings about 400 m east. */
const RIVER = {
  elements: [
    {
      type: 'way',
      id: 1,
      tags: { waterway: 'river' },
      geometry: Array.from({ length: 21 }, (_, i) => ({
        lat: 52.0 + (0.018 * i) / 20,
        lon: 0.006 * Math.sin((i / 20) * Math.PI),
      })),
    },
  ],
};

const LOOKUP_DELAY_MS = 4_000;

async function bootstrap(page: Page, overpass: 'river' | 'busy') {
  await page.addInitScript({ content: fs.readFileSync(mockBluetoothPath, 'utf8') });
  // The crash-watch fixture refuses the map hosts by default; this spec
  // serves Overpass itself, so let the requests reach `page.route`.
  await page.addInitScript(() => {
    (window as unknown as { __E2E_ENRICHMENT_NETWORK?: boolean }).__E2E_ENRICHMENT_NETWORK = true;
  });
  await page.route('**/rownative/courses/**/900.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COURSE) }),
  );
  await page.route('**/rownative.icu/api/**', (route) => route.abort());
  // The browser checks CORS on a fulfilled cross-origin answer too.
  const headers = { 'Access-Control-Allow-Origin': '*' };
  await page.route((url) => url.hostname === 'overpass-api.de', async (route) => {
    if (overpass === 'busy') {
      await route.fulfill({ status: 502, contentType: 'text/plain', headers, body: 'at capacity' });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, LOOKUP_DELAY_MS));
    await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(RIVER) });
  });
}

async function importCourse(page: Page) {
  await page.goto('./');
  await page.getByRole('button', { name: 'Routes', exact: true }).click();
  await page.getByLabel('Rownative course import').waitFor({ state: 'visible' });
  await page.getByLabel('Rownative course ID or link').fill('900');
  const started = Date.now();
  await page.getByRole('button', { name: /^Import$/ }).click();
  await expect(page.locator('.route-info-overlay h2')).toContainText('Bend Head', { timeout: 15_000 });
  return Date.now() - started;
}

const selected = (page: Page) => page.evaluate(() => window.__SELECTED_ROUTE);

test.describe('rownative river import refines in the background (#750)', () => {
  test('imports at once on the gate chain, then the same route follows the river', async ({ page }) => {
    await bootstrap(page, 'river');
    const elapsed = await importCourse(page);
    // FR1: the import does not wait for the lookup.
    expect(elapsed).toBeLessThan(LOOKUP_DELAY_MS);

    const first = await selected(page);
    expect(first?.geometrySource).toBe('gate-chain');
    await expect(page.getByTestId('route-tracing')).toHaveText('Tracing the river…');

    // FR2: the same route id takes the mapped river and a longer distance.
    await expect.poll(async () => (await selected(page))?.geometrySource, { timeout: 30_000 }).toBe('osm-derived');
    const after = await selected(page);
    expect(after?.id).toBe(first?.id);
    expect(after!.distanceKm).toBeGreaterThan(first!.distanceKm);
    await expect(page.getByTestId('route-tracing')).toHaveCount(0);
  });

  test('a busy map server leaves the gate chain and says nothing alarming', async ({ page }) => {
    await bootstrap(page, 'busy');
    await importCourse(page);
    await expect(page.getByTestId('route-tracing')).toHaveCount(0, { timeout: 30_000 });
    expect((await selected(page))?.geometrySource).toBe('gate-chain');
    await expect(page.locator('[role="alert"]')).toHaveCount(0);

    // FR5: the Routes list offers to try again.
    await page.getByRole('button', { name: 'Routes', exact: true }).click();
    await expect(page.getByTestId('route-refresh-geometry').getByRole('button', { name: 'Refresh geometry' })).toBeVisible();
  });
});
