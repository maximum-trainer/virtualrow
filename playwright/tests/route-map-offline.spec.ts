import { test, expect, type Page } from '../fixtures/crash-watch';
import { installRideHarness, startDemoRide } from './helpers/engineRide';

/**
 * #738 FR2/FR3 — with no map tiles, the route map is still a map.
 *
 * Scenario: offline map is still a map
 *   Given the Row screen with all tile requests blocked
 *   Then the map canvas contains a water-coloured region along the route
 *   And start/finish labels
 *
 * The 2D route map has no tile source at all (the demo route and guests need
 * no external map data), so blocking the tile hosts only proves that. The
 * labels are canvas text; the component lists the ones it drew in
 * `data-labels`.
 */

/** `ROUTE_MAP_COLOURS.water` in routeMapDraw.ts. */
const WATER = [0x4f, 0x97, 0xc9];

const blockTiles = (page: Page) =>
  page.route(/tile\.openstreetmap\.org|\/\d+\/\d+\/\d+\.(png|pbf|mvt)/, (r) => r.abort());

/** Share of the canvas's pixels within 14 of the water colour on each channel. */
const waterShare = (page: Page, selector: string) =>
  page.evaluate(
    ({ selector, water }) => {
      const canvas = document.querySelector(selector) as HTMLCanvasElement | null;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx || canvas.width === 0 || canvas.height === 0) return 0;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let hits = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - water[0]) <= 14 &&
          Math.abs(data[i + 1] - water[1]) <= 14 &&
          Math.abs(data[i + 2] - water[2]) <= 14
        ) {
          hits += 1;
        }
      }
      return hits / (data.length / 4);
    },
    { selector, water: WATER },
  );

test('the route preview draws water and start/finish labels with tiles blocked (#738 FR2)', async ({
  page,
}) => {
  await blockTiles(page);
  await page.goto('./');
  const map = page.locator('.map-container .route-map');
  await expect(map).toBeVisible({ timeout: 20_000 });
  await expect(map).toHaveAttribute('data-labels', /Start/);
  await expect.poll(() => waterShare(page, '.map-container .route-map canvas')).toBeGreaterThan(0.005);
});

test('the ride minimap draws the same water and labels (#738 FR3)', async ({ page }) => {
  await blockTiles(page);
  await installRideHarness(page);
  await startDemoRide(page);
  const minimap = page.locator('.activity-map-overlay .route-map');
  await expect(minimap).toBeVisible({ timeout: 30_000 });
  await expect(minimap).toHaveAttribute('data-labels', /Start/);
  await expect
    .poll(() => waterShare(page, '.activity-map-overlay .route-map canvas'), { timeout: 15_000 })
    .toBeGreaterThan(0.005);
});
