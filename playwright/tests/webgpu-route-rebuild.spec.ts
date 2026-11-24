/**
 * #753 VP-30 FR5 — late route data rebuilds the scene once, mid-row, and the
 * boat keeps its place (#746).
 *
 * Test mode normally keeps the host from rebuilding, so a spec creates exactly
 * one device. Here `__ROWER3D_REBUILD_ON_ROUTE_CHANGE` turns the rebuild back
 * on. The route is a gates-only river course whose OSM enrichment is held by
 * the test until the row is under way, as the live deploy's ~30 s Overpass
 * answer is.
 *
 * Like the other ride specs it needs a hardware WebGPU adapter: where the
 * engine declines (SwiftShader CI, the cloud) it asserts the decline is
 * well-formed instead.
 */
import { test, expect, type Page } from '../fixtures/crash-watch';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  assertWellFormedDecline,
  forceRender,
  installRideHarness,
  readRideTelemetry,
  waitForRideOutcome,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/** A 2 km gates-only course on a river. */
const COURSE = {
  id: '901',
  name: 'Rebuild Reach',
  country: 'United Kingdom',
  distance_m: 2000,
  status: 'established',
  polygons: [
    { name: 'Start', order: 0, points: [{ lat: 51.9999, lon: -0.0002 }, { lat: 51.9999, lon: 0.0002 }, { lat: 52.0001, lon: 0.0002 }, { lat: 52.0001, lon: -0.0002 }] },
    { name: 'Finish', order: 1, points: [{ lat: 52.0179, lon: -0.0002 }, { lat: 52.0179, lon: 0.0002 }, { lat: 52.0181, lon: 0.0002 }, { lat: 52.0181, lon: -0.0002 }] },
  ],
};

const riverLine = Array.from({ length: 21 }, (_, i) => ({ lat: 51.998 + (0.022 * i) / 20, lon: 0 }));
/** The waterway the import walks, and the water the enrichment dresses it with. */
const RIVER = {
  elements: [
    { type: 'way', id: 1, tags: { waterway: 'river', name: 'Test River' }, geometry: riverLine },
    {
      type: 'way',
      id: 2,
      tags: { natural: 'water', water: 'river' },
      geometry: [
        { lat: 51.997, lon: -0.0006 },
        { lat: 51.997, lon: 0.0006 },
        { lat: 52.021, lon: 0.0006 },
        { lat: 52.021, lon: -0.0006 },
        { lat: 51.997, lon: -0.0006 },
      ],
    },
  ],
};

/** Only a signed-in rower fetches map data (guests row the fallback scene). */
const ATHLETE = { id: 'i12345', name: 'Test Athlete', email: 'athlete@example.com' };

/** Longest the enrichment is held, inside the service's own 20 s water timeout. */
const HOLD_LIMIT_MS = 15_000;

/** Serve the course and Overpass; enrichment answers wait for `release()`. */
async function bootstrap(page: Page) {
  await installRideHarness(page);
  await page.addInitScript((athlete) => {
    const w = window as unknown as {
      __AUTH_USER?: unknown;
      __E2E_ENRICHMENT_NETWORK?: boolean;
      __ROWER3D_REBUILD_ON_ROUTE_CHANGE?: boolean;
    };
    // Signed in, as in lake-offline.spec.ts: a seeded user and refresh token.
    w.__AUTH_USER = athlete;
    sessionStorage.setItem('vr_auth_user', JSON.stringify(athlete));
    sessionStorage.setItem('vr_auth_refresh_token', 'e2e-refresh-token');
    w.__E2E_ENRICHMENT_NETWORK = true;
    w.__ROWER3D_REBUILD_ON_ROUTE_CHANGE = true;
  }, ATHLETE);
  await page.route('**/proxy/api/oauth/token**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: 'e2e-access-token', expires_in: 3600, token_type: 'Bearer', athlete_id: 12345 }),
    }),
  );
  await page.route('**/rownative/courses/**/901.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COURSE) }),
  );
  await page.route('**/rownative.icu/api/**', (route) => route.abort());

  // The first Overpass request is the import's river walk; every later one
  // (the selected route's enrichment) waits for `release()` once `hold()`
  // is set, or from the start when it overlaps the import.
  let requests = 0;
  let holding = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const headers = { 'Access-Control-Allow-Origin': '*' };
  const overpassHosts = new Set(['overpass-api.de', 'overpass.kumi.systems']);
  await page.route((url) => overpassHosts.has(url.hostname), async (route) => {
    requests += 1;
    if (holding || requests > 1) {
      await Promise.race([released, new Promise((resolve) => setTimeout(resolve, HOLD_LIMIT_MS))]);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(RIVER) }).catch(() => {});
  });
  return {
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      release();
    },
  };
}

test('late enrichment rebuilds the scene once and the boat keeps its distance (#753 FR5)', async ({ page }) => {
  test.setTimeout(120_000);
  const overpass = await bootstrap(page);

  // Import the course and let its river walk settle before the row.
  await page.goto('./');
  await page.getByRole('button', { name: 'Routes', exact: true }).click();
  await page.getByLabel('Rownative course import').waitFor({ state: 'visible' });
  await page.getByLabel('Rownative course ID or link').fill('901');
  await page.getByRole('button', { name: /^Import$/ }).click();
  await expect(page.locator('.route-info-overlay h2')).toContainText('Rebuild Reach', { timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => window.__SELECTED_ROUTE?.geometrySource), { timeout: 30_000 })
    .toBe('osm-derived');

  // From here every Overpass answer (the enrichment) waits for the test.
  overpass.hold();
  await page.getByRole('button', { name: 'Row', exact: true }).click();
  await page.waitForSelector('.btn-try-demo', { timeout: 15_000 });
  await page.evaluate(() => (document.querySelector('.btn-try-demo') as HTMLButtonElement | null)?.click());
  // While the map data is out, a signed-in row waits for it unless the rower
  // chooses to start now: the case a mid-row rebuild exists for.
  await page.getByRole('button', { name: 'Start now with simple scenery' }).click();
  await page.waitForURL(/\/row(\/)?$/, { timeout: 15_000 });

  const outcome = await waitForRideOutcome(page);
  if (outcome !== 'ready') {
    overpass.release();
    await assertWellFormedDecline(page);
    return;
  }

  // Row a little on the placeholder scene.
  await expect
    .poll(
      async () => {
        await forceRender(page);
        return (await readRideTelemetry(page)).boat?.distanceMeters ?? 0;
      },
      { timeout: 15_000, intervals: [300, 500, 800] },
    )
    .toBeGreaterThan(2);
  expect(await page.evaluate(() => window.__ROWER3D_REBUILDS ?? 0), 'no rebuild before the data lands').toBe(0);
  const before = (await readRideTelemetry(page)).boat?.distanceMeters ?? 0;

  overpass.release();

  // Exactly one rebuild once the enrichment lands, and it stays at one.
  await expect
    .poll(() => page.evaluate(() => window.__ROWER3D_REBUILDS ?? 0), { timeout: 30_000 })
    .toBe(1);
  await page.waitForTimeout(3_000);
  expect(await page.evaluate(() => window.__ROWER3D_REBUILDS ?? 0), 'a single rebuild').toBe(1);

  // The rebuilt scene picks the boat up where it was, not at the start.
  await forceRender(page);
  const after = (await readRideTelemetry(page)).boat?.distanceMeters ?? 0;
  expect(after).toBeGreaterThanOrEqual(before);
  expect((await readRideTelemetry(page)).context?.kind).toBe('ready');
});
