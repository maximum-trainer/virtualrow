/**
 * #449 AC9 — a route with entries in `route-placements.json` draws its tier-r
 * models (the llm-cad output of the monthly scenery run); a route without
 * any fetches none.
 *
 * Imports recorded rownative courses through the same Routes screen a rower
 * uses, with the mirror and Overpass answered locally. Like the other ride
 * specs it needs a hardware WebGPU adapter; where the engine declines it
 * asserts the decline is well-formed and skips. On a laptop, run it with
 * system Chrome (`PW_LOCAL_CHROME=...`) and `--headed`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '../fixtures/crash-watch';
import {
  GPU_RIDE_LAUNCH_OPTIONS,
  assertWellFormedDecline,
  forceRender,
  installRideHarness,
  startDemoRide,
  waitForRideOutcome,
} from './helpers/engineRide';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rownativeCourse = (id: string): string =>
  readFileSync(path.join(ROOT, 'src/__tests__/fixtures/rownative', `${id}.json`), 'utf8');
const registry = JSON.parse(readFileSync(path.join(ROOT, 'public/assets/scenery/route-placements.json'), 'utf8')) as {
  placements: Record<string, { modelId: string; assetPath: string }[]>;
};

/** Import rownative course `id` from its recorded file and start a demo row on it. */
async function rowRownativeCourse(page: Page, id: string, tierR: string[]): Promise<'ready' | 'fallback'> {
  await installRideHarness(page);
  await page.route(`**/rownative/courses/**/${id}.json`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: rownativeCourse(id) }),
  );
  await page.route('**/rownative.icu/api/**', (route) => route.abort());
  const overpassHosts = new Set(['overpass-api.de', 'overpass.kumi.systems']);
  await page.route(
    (url) => overpassHosts.has(url.hostname),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ elements: [] }),
      }),
  );
  page.on('request', (request) => {
    if (request.url().includes('/assets/scenery/tier-r/')) tierR.push(new URL(request.url()).pathname);
  });

  await page.goto('./');
  await page.getByRole('button', { name: 'Routes', exact: true }).click();
  await page.getByLabel('Rownative course import').waitFor({ state: 'visible' });
  await page.getByLabel('Rownative course ID or link').fill(id);
  await page.getByRole('button', { name: /^Import$/ }).click();
  await expect(page.locator('.route-info-overlay h2')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Row', exact: true }).click();
  await page.waitForSelector('.btn-try-demo', { timeout: 15_000 });
  await page.evaluate(() => (document.querySelector('.btn-try-demo') as HTMLButtonElement | null)?.click());
  const startNow = page.getByRole('button', { name: 'Start now with simple scenery' });
  if (await startNow.isVisible().catch(() => false)) await startNow.click();
  await page.waitForURL(/\/row(\/)?$/, { timeout: 15_000 });
  return waitForRideOutcome(page);
}

/** Draw frames for a few seconds so the near-start models stream in. */
async function rowAWhile(page: Page): Promise<void> {
  for (let i = 0; i < 16; i += 1) {
    await forceRender(page);
    await page.waitForTimeout(500);
  }
}

test('a course with tier-r placements draws its generated models (#449 AC9)', async ({ page }) => {
  test.setTimeout(120_000);
  // Course 1 (Lake Quinsigamond) has a gazebo 40 m from the start, inside the first look-ahead.
  const id = '1';
  const entries = registry.placements[id] ?? [];
  expect(entries.length, `route-placements.json has entries for course ${id}`).toBeGreaterThan(0);
  const tierR: string[] = [];
  if ((await rowRownativeCourse(page, id, tierR)) !== 'ready') {
    await assertWellFormedDecline(page);
    test.skip(true, 'the engine declined (no hardware adapter)');
    return;
  }
  await expect
    .poll(
      async () => {
        await forceRender(page);
        return tierR.length;
      },
      { timeout: 30_000, intervals: [500] },
    )
    .toBeGreaterThan(0);
  await rowAWhile(page);

  // Only this course's models, and only ones the registry names.
  const named = new Set(entries.map((entry) => entry.assetPath.replace(/^\//, '')));
  for (const fetched of tierR) {
    expect(fetched, 'a tier-r model of this course').toContain(`/assets/scenery/tier-r/${id}/`);
    const asset = fetched.slice(fetched.indexOf('assets/scenery/tier-r/')).replace(/\.lod1\.glb$/, '.glb');
    expect(named.has(asset), `${asset} is in the registry for course ${id}`).toBe(true);
  }
  const failed = await page.evaluate(
    () => (window as unknown as { __ROWER3D_SCENERY?: { failedIds: string[] } }).__ROWER3D_SCENERY?.failedIds ?? [],
  );
  expect(failed.filter((modelId) => modelId.startsWith(`r-${id}-`)), 'tier-r models that failed to load').toEqual([]);
});

test('a course without tier-r placements fetches none (#449 AC9)', async ({ page }) => {
  test.setTimeout(120_000);
  const id = '61';
  expect(registry.placements[id], `route-placements.json has no entry for course ${id}`).toBeUndefined();
  const tierR: string[] = [];
  if ((await rowRownativeCourse(page, id, tierR)) !== 'ready') {
    await assertWellFormedDecline(page);
    test.skip(true, 'the engine declined (no hardware adapter)');
    return;
  }
  await rowAWhile(page);
  expect(tierR, 'tier-r models fetched for a course with no placements').toEqual([]);
});

test('the Willowbrook demo keeps its own extras, not those of rownative course 1 (#449 AC9)', async ({ page }) => {
  test.setTimeout(120_000);
  // The demo's app route id is '1', which is also a rownative course id with
  // tier-r entries; the registry is keyed on the course, so the demo is not.
  expect(registry.placements['1']?.length ?? 0).toBeGreaterThan(0);
  const tierR: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/assets/scenery/tier-r/')) tierR.push(new URL(request.url()).pathname);
  });
  await installRideHarness(page);
  await startDemoRide(page);
  if ((await waitForRideOutcome(page)) !== 'ready') {
    await assertWellFormedDecline(page);
    test.skip(true, 'the engine declined (no hardware adapter)');
    return;
  }
  await rowAWhile(page);
  const nearStart = await page.evaluate(
    () => (window as unknown as { __ROWER3D_SCENERY?: { nearStartIds: string[] } }).__ROWER3D_SCENERY?.nearStartIds ?? [],
  );
  expect(nearStart, 'the demo boathouse (ROUTE_EXTRAS)').toContain('b01-boathouse-new-england');
  expect(tierR, 'tier-r models fetched for the demo').toEqual([]);
});
