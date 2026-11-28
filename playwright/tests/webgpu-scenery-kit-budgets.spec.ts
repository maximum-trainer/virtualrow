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
 *     counted as `__ROWER3D_FOLIAGE.draws` (capped at what the laptop GPU
 *     measured, as Dan chose on 2026-11-24);
 *   - fetches and bytes: the `.glb` requests the row makes, on the wire.
 *
 * Like the other ride specs it needs a hardware WebGPU adapter. Where the
 * engine declines (SwiftShader CI, the cloud) it asserts the decline is
 * well-formed and skips. On a laptop, run it with system Chrome
 * (`PW_LOCAL_CHROME=...`) and `--headed`, or headless Chromium declines.
 *
 * #885 adds the real-map layers (#763-#765): a signed-in row on a course whose
 * landscape comes from a fixture through the landscape port's test seam
 * (never the network), held to each layer's tier budget as the plans read it.
 * The same rows hold #886's grounding: no landform in the view across the
 * water (FR5), no kit tree inside a hill (FR6).
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
import { GPU_MS_BUDGET, median } from './helpers/gpuBudget';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

/** The #224 ceiling the kit has to fit inside, not a budget of its own. */
const GEOMETRY_BUDGET_BYTES = 80 * 1024 * 1024;
/**
 * #333 / #870: draw calls the forest may cost in the colour pass at the hero
 * frame. Only pools in view and in range are drawn; the laptop GPU measured 7
 * of the demo route's 102 at both tiers (2026-11-24), and one more is
 * headroom for a pool on the frustum edge.
 */
const FOREST_DRAW_BUDGET: Record<'basic' | 'medium', number> = { basic: 8, medium: 8 };
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

// ── #885 — the real-map layers (#763-#765) on the engine ─────────────────────

/** Only a signed-in rower's non-demo route gets a landscape (#762). */
const ATHLETE = { id: 'i12345', name: 'Test Athlete', email: 'athlete@example.com' };
/** #885 FR3 — the land-cover mask's ceiling, whatever the scene reports as its budget. */
const MASK_CAP_BYTES = 4 * 1024 * 1024;
/** #763 FR7 — landforms are budgeted per this much course. */
const RELIEF_WINDOW_METRES = 4_000;

const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/__tests__/fixtures/landscape');
interface RecordedLandscape {
  courseId: string;
  name: string;
  route: { lat: number; lng: number }[];
  elevation: unknown;
}
const recorded = (id: string): RecordedLandscape =>
  JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${id}.json`), 'utf8')) as RecordedLandscape;

/** The 4 km gently bending course `realMapLayerBudgets.test.ts` lays the dense fixture along. */
const DENSE_COURSE = Array.from({ length: 41 }, (_, i) => [5.1 + Math.sin(i / 8) * 0.004, 52.2 + i * 0.0009]);

/** What the engine and the landscape port publish about the real-map layers. */
interface RealMapReading {
  landscape?: { elevation: { source: string }; landCover: { source: string }; built: { source: string } };
  landCover?: { treelineInstances: number; woodlandTrees: number; maskBytes: number } | null;
  relief?: { placed: number } | null;
  buildings?: { near: number; mid: number; skylineInstances: number; landmarks: number; pool: number };
  /**
   * #885 FR6 — the budgets the plans held each layer to (`tierCaps` and the
   * plan modules), published beside the counts so this spec reads the one
   * source rather than a copy of it.
   */
  budgets?: {
    treelines: number;
    woodlandTrees: number;
    reliefPer4Km: number;
    skylines: number;
    landmarks: number;
    buildingsPerKm: number;
    maskBytes: number;
  } | null;
  /** The course line's length (`__ROWER3D_ROUTE.curveLength`), which the per-km budgets are counted over. */
  courseMetres: number;
  residentMeshBytes: number;
  /** #886 FR5, FR6 — how the landforms and kit trees sit against the hills. */
  grounding?: { landforms: number; minLandformClearanceM: number | null; trees: number; treesInsideLandforms: number } | null;
  /** This frame's triangles by what drew them (#737 FR2), for the annotation. */
  groups?: Record<string, { draws: number; triangles: number }>;
}
const readRealMap = (page: Page): Promise<RealMapReading> =>
  page.evaluate(() => {
    const w = window as unknown as {
      __ROWER3D_LANDSCAPE?: RealMapReading['landscape'];
      __ROWER3D_SCENERY?: Pick<RealMapReading, 'landCover' | 'relief' | 'grounding'> & { layerBudgets?: RealMapReading['budgets'] };
      __ROWER3D_BUILDINGS?: RealMapReading['buildings'];
      __ROWER3D_ROUTE?: { curveLength: number };
      __ROWER3D_RENDER_STATS?: { residentMeshBytes: number; groups?: RealMapReading['groups'] };
    };
    return {
      landscape: w.__ROWER3D_LANDSCAPE,
      landCover: w.__ROWER3D_SCENERY?.landCover,
      relief: w.__ROWER3D_SCENERY?.relief,
      buildings: w.__ROWER3D_BUILDINGS,
      budgets: w.__ROWER3D_SCENERY?.layerBudgets,
      grounding: w.__ROWER3D_SCENERY?.grounding,
      courseMetres: w.__ROWER3D_ROUTE?.curveLength ?? 0,
      residentMeshBytes: w.__ROWER3D_RENDER_STATS?.residentMeshBytes ?? 0,
      groups: w.__ROWER3D_RENDER_STATS?.groups,
    };
  });

/** Signed in as in `webgpu-route-rebuild.spec.ts`, with the landscape port handed `fixture`. */
async function signInWithLandscape(page: Page, fixture: unknown): Promise<void> {
  await page.addInitScript(
    ({ athlete, landscape }) => {
      const w = window as unknown as { __AUTH_USER?: unknown; __E2E_LANDSCAPE_FIXTURE?: unknown };
      w.__AUTH_USER = athlete;
      sessionStorage.setItem('vr_auth_user', JSON.stringify(athlete));
      sessionStorage.setItem('vr_auth_refresh_token', 'e2e-refresh-token');
      w.__E2E_LANDSCAPE_FIXTURE = landscape;
    },
    { athlete: ATHLETE, landscape: fixture },
  );
  await page.route('**/proxy/api/oauth/token**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: 'e2e-access-token', expires_in: 3600, token_type: 'Bearer', athlete_id: 12345 }),
    }),
  );
}

/** Row `coordinates` signed in with `fixture` as its landscape; null when the engine declined. */
async function rowWithLandscape(
  page: Page,
  tier: 'basic' | 'medium',
  name: string,
  coordinates: number[][],
  fixture: unknown,
): Promise<RealMapReading | null> {
  await pinTier(page, tier);
  await signInWithLandscape(page, fixture);
  if ((await rowGeneratedCourse(page, name, coordinates)) !== 'ready') {
    await declined(page);
    return null;
  }
  // The landscape lands beside the enrichment; the scene is laid out again
  // once it has (#753 FR5). Draw until the layers stop changing.
  let previous = '';
  await expect
    .poll(
      async () => {
        await forceRender(page);
        const reading = await readRealMap(page);
        const now = JSON.stringify([reading.landCover, reading.relief, reading.buildings, reading.residentMeshBytes]);
        const settled = reading.landscape?.elevation.source === 'cache' && reading.residentMeshBytes > 0 && now === previous;
        previous = now;
        return settled;
      },
      { timeout: 90_000, intervals: [2_000] },
    )
    .toBe(true);
  return readRealMap(page);
}

/** #885 FR5 — the GPU frame time with every layer present, median of 30 frames. */
async function gpuMedian(page: Page): Promise<number | null> {
  const samples: number[] = [];
  for (let i = 0; i < 35; i += 1) {
    await forceRender(page);
    await page.waitForTimeout(50);
    const gpuMs = await page.evaluate(() => (window as unknown as { __ROWER3D_FRAME_STATS?: { gpuMs: number } }).__ROWER3D_FRAME_STATS?.gpuMs ?? 0);
    if (i >= 5 && gpuMs > 0) samples.push(gpuMs);
  }
  return samples.length > 0 ? median(samples) : null;
}

/** Each layer's count against the budget the plans read (#885 FR2, FR3, FR4, FR6). */
function expectWithinLayerBudgets(reading: RealMapReading): NonNullable<RealMapReading['budgets']> {
  const budgets = reading.budgets;
  expect(budgets, 'the scene published its layer budgets').toBeTruthy();
  const km = reading.courseMetres / 1000;
  const reliefWindows = Math.max(1, Math.ceil(reading.courseMetres / RELIEF_WINDOW_METRES));
  expect(reading.landCover?.treelineInstances ?? 0, 'treelines').toBeLessThanOrEqual(budgets!.treelines);
  expect(reading.landCover?.woodlandTrees ?? 0, 'kit trees in woods').toBeLessThanOrEqual(budgets!.woodlandTrees);
  expect(reading.relief?.placed ?? 0, 'horizon landforms').toBeLessThanOrEqual(budgets!.reliefPer4Km * reliefWindows);
  expect(reading.buildings?.skylineInstances ?? 0, 'skylines').toBeLessThanOrEqual(budgets!.skylines);
  expect(reading.buildings?.landmarks ?? 0, 'landmarks').toBeLessThanOrEqual(budgets!.landmarks);
  // The plan keeps every real footprint (near + mid); the engine draws the
  // most visible of them up to the tier's per-km budget (#765 FR2), so the
  // budget holds what is resident on the pool.
  expect(reading.buildings?.pool ?? 0, 'buildings drawn').toBeLessThanOrEqual(Math.ceil(budgets!.buildingsPerKm * km));
  expect(budgets!.maskBytes, 'the mask budget is the 4 MB ceiling').toBeLessThanOrEqual(MASK_CAP_BYTES);
  expect(reading.landCover?.maskBytes ?? 0, 'land-cover mask').toBeLessThanOrEqual(budgets!.maskBytes);
  expect(reading.residentMeshBytes, 'kit geometry resident').toBeLessThanOrEqual(GEOMETRY_BUDGET_BYTES);
  // #886 FR5 — no landform across the water or in the view along it; FR6 —
  // no kit tree standing inside a hill.
  if (reading.grounding && reading.grounding.landforms > 0) {
    expect(reading.grounding.minLandformClearanceM ?? -1, 'a landform reaches into the view of the water').toBeGreaterThanOrEqual(0);
  }
  expect(reading.grounding?.treesInsideLandforms ?? 0, 'kit trees inside a hill').toBe(0);
  return budgets!;
}

const annotate = (testInfo: { annotations: { type: string; description?: string }[] }, label: string, r: RealMapReading, gpu: number | null) =>
  testInfo.annotations.push({
    type: 'real-map-layers',
    description:
      `${label}: ${(r.courseMetres / 1000).toFixed(1)} km, treelines ${r.landCover?.treelineInstances ?? 0}, ` +
      `wood trees ${r.landCover?.woodlandTrees ?? 0}, landforms ${r.relief?.placed ?? 0}, ` +
      `skylines ${r.buildings?.skylineInstances ?? 0}, landmarks ${r.buildings?.landmarks ?? 0}, ` +
      `footprints ${(r.buildings?.near ?? 0) + (r.buildings?.mid ?? 0)} (${r.buildings?.pool ?? 0} drawn), mask ${((r.landCover?.maskBytes ?? 0) / 1024).toFixed(0)} KB, ` +
      `resident ${(r.residentMeshBytes / 1024 / 1024).toFixed(1)} MB, gpuMs ${gpu?.toFixed(2) ?? 'n/a'}, ` +
      `landform clearance ${r.grounding?.minLandformClearanceM ?? 'n/a'} m, trees in hills ${r.grounding?.treesInsideLandforms ?? 'n/a'}/${r.grounding?.trees ?? 0}; ` +
      Object.entries(r.groups ?? {})
        .map(([group, g]) => `${group} ${g.draws} draws / ${(g.triangles / 1000).toFixed(0)}k tris`)
        .join(', '),
  });

for (const tier of ['basic', 'medium'] as const) {
  test(`the real-map layers stay inside their budgets at ${tier} (#885 FR1-FR6)`, async ({ page }, testInfo) => {
    testInfo.setTimeout(240_000);
    const glbBytes: number[] = [];
    page.on('response', async (response) => {
      if (!isGlb(response.url())) return;
      try {
        glbBytes.push((await response.body()).byteLength);
      } catch {
        // A body that has already gone says nothing about its size.
      }
    });
    const reading = await rowWithLandscape(page, tier, `Real Map Budget ${tier}`, DENSE_COURSE, 'dense');
    if (!reading) return;
    const gpu = await gpuMedian(page);
    annotate(testInfo, `dense ${tier}`, reading, gpu);

    expect(reading.landscape?.landCover.source, 'the dense fixture reached the scene').toBe('cache');
    const budgets = expectWithinLayerBudgets(reading);
    if (tier === 'basic') {
      // #885 AC "Basic draws no far layer".
      expect(reading.relief?.placed ?? 0).toBe(0);
      expect(reading.buildings?.skylineInstances ?? 0).toBe(0);
      expect(reading.buildings?.landmarks ?? 0).toBe(0);
      expect(reading.landCover?.woodlandTrees ?? 0).toBe(0);
    } else {
      // The fixture exceeds every budget, so the caps are what stop each layer.
      expect(reading.landCover?.treelineInstances).toBe(budgets.treelines);
      expect(reading.landCover?.woodlandTrees).toBe(budgets.woodlandTrees);
      expect(reading.buildings?.skylineInstances).toBe(budgets.skylines);
      expect(reading.buildings?.landmarks).toBe(budgets.landmarks);
      expect(reading.relief?.placed ?? 0).toBeGreaterThan(0);
    }
    const downloaded = glbBytes.reduce((sum, bytes) => sum + bytes, 0);
    expect(downloaded, `the row pulled ${(downloaded / 1024 / 1024).toFixed(2)} MB of scenery`).toBeLessThanOrEqual(GLB_BYTES_BUDGET);
    if (gpu !== null) expect(gpu, `gpuMs median with every layer present`).toBeLessThanOrEqual(GPU_MS_BUDGET[tier]);
  });
}

for (const id of ['180', '277']) {
  test(`recorded terrain ${id} keeps its landforms inside the medium budget (#885 FR7)`, async ({ page }, testInfo) => {
    testInfo.setTimeout(240_000);
    const fixture = recorded(id);
    const course = fixture.route.map(({ lat, lng }) => [lng, lat]);
    const reading = await rowWithLandscape(page, 'medium', fixture.name, course, fixture);
    if (!reading) return;
    const gpu = await gpuMedian(page);
    annotate(testInfo, `${id} medium`, reading, gpu);

    expect(reading.landscape?.elevation.source, 'the recorded terrain reached the scene').toBe('cache');
    expectWithinLayerBudgets(reading);
    if (gpu !== null) expect(gpu, `gpuMs median on ${fixture.name}`).toBeLessThanOrEqual(GPU_MS_BUDGET.medium);
  });
}
