/**
 * #870 — what the llm-cad scenery kit costs, on the WebGPU engine.
 *
 * Replaces `scenery-kit-budgets.spec.ts` (#232, #332, #333), which measured
 * the retired three.js scene and has not run since the cutover (#625). The
 * budgets are the same (#870 D3); what they read is the engine's own
 * telemetry:
 *   - geometry: `__ROWER3D_RENDER_STATS.residentMeshBytes`, the GPU bytes
 *     every registered kit mesh holds (#727 FR5, #870 D1);
 *   - the forest: one indirect draw per foliage pool in view and in range,
 *     counted as `__ROWER3D_FOLIAGE.draws` (#870 D2: 6 at medium and up, 3 at
 *     basic and low);
 *   - fetches and bytes: the `.glb` requests the row makes, on the wire.
 *
 * Like the other ride specs it needs a hardware WebGPU adapter. Where the
 * engine declines (SwiftShader CI, the cloud) it asserts the decline is
 * well-formed and skips. On a laptop, run it with system Chrome
 * (`PW_LOCAL_CHROME=...`) and `--headed`, or headless Chromium declines.
 */
import { test, expect, type Page } from '../fixtures/crash-watch';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  assertWellFormedDecline,
  forceRender,
  installRideHarness,
  pinTier,
  startDemoRide,
  waitForRideOutcome,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/** The #224 ceiling the kit has to fit inside, not a budget of its own. */
const GEOMETRY_BUDGET_BYTES = 80 * 1024 * 1024;
/** #333 / #870 D2: draw calls the whole forest may cost in the colour pass. */
const FOREST_DRAW_BUDGET: Record<'basic' | 'medium', number> = { basic: 3, medium: 6 };
/** #287: GLB fetches in flight at once before a static host answers 503. */
const MAX_GLB_IN_FLIGHT = 20;
/** #332: what a short row may download in scenery models. */
const GLB_BYTES_BUDGET = 4 * 1024 * 1024;

const METERS_PER_DEGREE_LAT = 111_195;

/** A winding course `lengthMeters` long, as GeoJSON `[lng, lat]` pairs. */
function windingCourse(points: number, lengthMeters: number, bends: number, amplitude = 60): number[][] {
  const originLat = 51.45;
  const lngScale = METERS_PER_DEGREE_LAT * Math.cos((originLat * Math.PI) / 180);
  return Array.from({ length: points }, (_, i) => {
    const t = i / (points - 1);
    return [
      (Math.sin(t * bends * 2 * Math.PI) * amplitude) / lngScale,
      originLat + (t * lengthMeters) / METERS_PER_DEGREE_LAT,
    ];
  });
}

const isGlb = (url: string): boolean => /\.glb(\?|$)/.test(url);

/** The fields of `__ROWER3D_SCENERY` this spec reads. */
interface KitScenery {
  registered: number;
  failedIds: string[];
}
const readScenery = (page: Page): Promise<KitScenery | undefined> =>
  page.evaluate(() => (window as unknown as { __ROWER3D_SCENERY?: KitScenery }).__ROWER3D_SCENERY);
/** `__ROWER3D_RENDER_STATS.residentMeshBytes` (#727 FR5). */
const readResidentMeshBytes = (page: Page): Promise<number> =>
  page.evaluate(
    () => (window as unknown as { __ROWER3D_RENDER_STATS?: { residentMeshBytes?: number } }).__ROWER3D_RENDER_STATS
      ?.residentMeshBytes ?? 0,
  );

/** Import a generated course from a GeoJSON file and start a demo row on it. */
async function rowGeneratedCourse(page: Page, name: string, coordinates: number[][]): Promise<'ready' | 'fallback'> {
  await installRideHarness(page);
  await page.goto('./');
  await page.getByRole('button', { name: 'Routes', exact: true }).click();
  await page.getByRole('button', { name: /import a file/i }).click();
  await page.getByLabel('Route name').fill(name);
  await page.locator('.route-import input[type="file"]').setInputFiles({
    name: `${name}.geojson`,
    mimeType: 'application/geo+json',
    buffer: Buffer.from(
      JSON.stringify({ type: 'Feature', properties: { name }, geometry: { type: 'LineString', coordinates } }),
    ),
  });
  await expect(page.locator('.route-info-overlay h2')).toContainText(name, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Row', exact: true }).click();
  await page.waitForSelector('.btn-try-demo', { timeout: 15_000 });
  await page.evaluate(() => (document.querySelector('.btn-try-demo') as HTMLButtonElement | null)?.click());
  await page.waitForURL(/\/row(\/)?$/, { timeout: 15_000 });
  return waitForRideOutcome(page);
}

/** Draw frames until `read` returns the same value twice running. */
async function settle(page: Page, read: () => Promise<number>, timeout: number): Promise<number> {
  let previous = Number.NaN;
  await expect
    .poll(
      async () => {
        await forceRender(page);
        const current = await read();
        const settled = current > 0 && current === previous;
        previous = current;
        return settled;
      },
      { timeout, intervals: [2_000] },
    )
    .toBe(true);
  return previous;
}

async function declined(page: Page): Promise<void> {
  await assertWellFormedDecline(page);
  test.skip(true, 'the engine declined (no hardware adapter)');
}

test('a 20 km route stays inside the geometry budget with the kit on (#870 FR2)', async ({ page }, testInfo) => {
  testInfo.setTimeout(180_000);
  await pinTier(page, 'high');
  if ((await rowGeneratedCourse(page, 'Twenty Kilometre Kit Course', windingCourse(4000, 20_000, 16))) !== 'ready') {
    return declined(page);
  }

  const bytes = await settle(page, () => readResidentMeshBytes(page), 120_000);
  const scenery = await readScenery(page);
  testInfo.annotations.push({
    type: 'kit-geometry',
    description: `${(bytes / 1024 / 1024).toFixed(2)} MB resident in ${scenery?.registered ?? 0} kit models`,
  });

  expect(scenery?.failedIds ?? [], 'kit models that failed to load').toEqual([]);
  expect(scenery?.registered ?? 0, 'the kit registered no models').toBeGreaterThan(0);
  expect(bytes, `${(bytes / 1024 / 1024).toFixed(2)} MB of kit geometry resident`).toBeLessThanOrEqual(
    GEOMETRY_BUDGET_BYTES,
  );
});

for (const tier of ['basic', 'medium'] as const) {
  test(`a forest of hundreds of trees costs a handful of draw calls at ${tier} (#870 FR3)`, async ({ page }, testInfo) => {
    testInfo.setTimeout(120_000);
    await pinTier(page, tier);
    // The same frame every run: the hero's, which is where the trees are.
    await page.addInitScript(() => {
      window.__ROWER3D_FREEZE = { time: 12.5, progress: 0.3 };
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await installRideHarness(page);
    await startDemoRide(page);
    if ((await waitForRideOutcome(page)) !== 'ready') return declined(page);

    await settle(page, async () => (await page.evaluate(() => window.__ROWER3D_FOLIAGE?.trees ?? 0)), 60_000);
    // The GPU cull's count is read back every few frames; −1 until it lands.
    await expect
      .poll(
        async () => {
          await forceRender(page);
          return page.evaluate(() => window.__ROWER3D_FOLIAGE?.drawn ?? -1);
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toBeGreaterThanOrEqual(0);

    const foliage = await page.evaluate(() => ({ draws: 0, ...window.__ROWER3D_FOLIAGE! }));
    const budget = FOREST_DRAW_BUDGET[tier];
    testInfo.annotations.push({
      type: 'forest-draws',
      description: `${tier}: ${foliage.trees} trees in ${foliage.meshes} pools, ${foliage.draws} drawn this frame, ${foliage.drawn} trees in sight`,
    });

    expect(foliage.trees, 'the demo route was not planted as a forest').toBeGreaterThanOrEqual(400);
    expect(foliage.drawn, 'no tree was in sight of the hero frame').toBeGreaterThan(0);
    expect(foliage.draws, `the forest cost ${foliage.draws} draw calls`).toBeGreaterThan(0);
    expect(foliage.draws, `the forest cost ${foliage.draws} draw calls`).toBeLessThanOrEqual(budget);
  });
}

test('a short row fetches a few compressed models, a few at a time (#870 FR4, FR5, FR6)', async ({ page }, testInfo) => {
  testInfo.setTimeout(120_000);
  let inFlight = 0;
  let peak = 0;
  const glbs: { url: string; bytes: number }[] = [];
  page.on('request', (request) => {
    if (!isGlb(request.url())) return;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
  });
  page.on('requestfailed', (request) => {
    if (isGlb(request.url())) inFlight -= 1;
  });
  page.on('requestfinished', (request) => {
    if (isGlb(request.url())) inFlight -= 1;
  });
  page.on('response', async (response) => {
    if (!isGlb(response.url())) return;
    try {
      glbs.push({ url: response.url(), bytes: (await response.body()).byteLength });
    } catch {
      // A body that has already gone (redirect, abort) says nothing about
      // size, and counting it as zero would understate the total.
    }
  });

  await pinTier(page, 'high');
  if ((await rowGeneratedCourse(page, 'Kit Bytes Course', windingCourse(600, 3_000, 4))) !== 'ready') {
    return declined(page);
  }
  for (let i = 0; i < 24; i += 1) {
    await forceRender(page);
    await page.waitForTimeout(500);
  }

  const total = glbs.reduce((sum, glb) => sum + glb.bytes, 0);
  const scenery = await readScenery(page);
  testInfo.annotations.push({
    type: 'kit-download',
    description: `${glbs.length} GLBs, ${(total / 1024 / 1024).toFixed(2)} MB, peak ${peak} in flight`,
  });

  expect(glbs.length, 'the row downloaded no kit models').toBeGreaterThan(0);
  expect(scenery?.failedIds ?? [], 'kit models that failed to load').toEqual([]);
  expect(peak, `${peak} GLB fetches in flight at once`).toBeLessThanOrEqual(MAX_GLB_IN_FLIGHT);
  expect(total, `the row pulled ${(total / 1024 / 1024).toFixed(2)} MB of scenery`).toBeLessThanOrEqual(
    GLB_BYTES_BUDGET,
  );

  // Every model is meshopt-encoded. A GLB lists its extensions in the JSON
  // chunk, so this reads the bytes that arrived, not the manifest.
  const uncompressed: string[] = [];
  for (const glb of glbs) {
    const body = await (await page.request.get(glb.url)).body();
    const json = body.subarray(20, 20 + body.readUInt32LE(12)).toString('utf8');
    if (!json.includes('EXT_meshopt_compression')) uncompressed.push(glb.url.split('/').pop()!);
  }
  expect(uncompressed, `shipped uncompressed: ${uncompressed.join(', ')}`).toEqual([]);
});
