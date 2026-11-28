/**
 * #727 VP-09 — GLB scenery is culled, LODed and unloaded, so a long row costs
 * the same at the finish as at the start.
 *
 * On the demo route, with the boat moved along it by the test seam
 * (`__ROWER3D_SEEK_METERS`):
 *   - AC "cost stays flat": shadow triangles every 250 m stay within 1.5x
 *     their median, and resident mesh bytes at 6 km within 1.25x of those
 *     at the start (the realism pass's AC-R1 asks the same of shadows).
 *     "The start" is the most resident over the first kilometre: a single
 *     0.5 km reading moved 6.4-7.1 MB between runs on the same GPU,
 *     depending on which near-start models had loaded and unloaded first.
 *   - AC-R3: the medium tier's GPU frame time stays within 12 ms at p95.
 *
 * Needs a hardware WebGPU adapter; declines are asserted well-formed. On a
 * laptop, run it with system Chrome (`PW_LOCAL_CHROME=...`) and `--headed`.
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
import { GPU_MS_BUDGET } from './helpers/gpuBudget';

test.use({ launchOptions: GPU_RIDE_LAUNCH_OPTIONS });

const STEP_METERS = 250;
const FIRST_METERS = 500;
const LAST_METERS = 6_000;
/** The stretch the start's resident set is read over. */
const START_REFERENCE_METERS = 1_000;

interface W {
  __ROWER3D_SEEK_METERS?: (metres: number | null) => void;
  __ROWER3D_ROUTE?: { totalDistance: number };
  __ROWER3D_RENDER_STATS?: {
    shadowTriangles: number;
    residentMeshBytes: number;
    groups: { sceneryMesh: { draws: number } };
  };
  __ROWER3D_FRAME_STATS?: { gpuMs: number };
}

interface Sample {
  metres: number;
  shadowTriangles: number;
  residentMeshBytes: number;
  sceneryDraws: number;
  gpuMs: number;
}

/** Put the boat at `metres`, let the models near it stream in, and read the frame's cost. */
async function sampleAt(page: Page, metres: number): Promise<Sample> {
  await page.evaluate((m) => (window as W).__ROWER3D_SEEK_METERS?.(m), metres);
  // Models register one a frame once decoded, and models behind unload:
  // draw until the resident set stops changing.
  let previous = -1;
  for (let stable = 0, i = 0; stable < 6 && i < 120; i += 1) {
    await forceRender(page);
    await page.waitForTimeout(150);
    const bytes = await page.evaluate(() => (window as W).__ROWER3D_RENDER_STATS?.residentMeshBytes ?? 0);
    stable = bytes === previous ? stable + 1 : 0;
    previous = bytes;
  }
  // The far shadow cascades redraw every 2nd and 4th frame below
  // extra-high (#727 FR2), so one frame alternates; average a full cycle.
  const frames: Omit<Sample, 'metres'>[] = [];
  for (let i = 0; i < 4; i += 1) {
    await forceRender(page);
    frames.push(
      await page.evaluate(() => {
        const w = window as W;
        const r = w.__ROWER3D_RENDER_STATS!;
        return { shadowTriangles: r.shadowTriangles, residentMeshBytes: r.residentMeshBytes, sceneryDraws: r.groups.sceneryMesh.draws, gpuMs: w.__ROWER3D_FRAME_STATS?.gpuMs ?? 0 };
      }),
    );
  }
  const mean = (key: keyof Omit<Sample, 'metres'>) => frames.reduce((sum, f) => sum + f[key], 0) / frames.length;
  return {
    metres,
    shadowTriangles: mean('shadowTriangles'),
    residentMeshBytes: frames[frames.length - 1].residentMeshBytes,
    sceneryDraws: mean('sceneryDraws'),
    gpuMs: Math.max(...frames.map((f) => f.gpuMs)),
  };
}

const median = (xs: readonly number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
};
const p95 = (xs: readonly number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};

for (const tier of ['medium', 'high'] as const) {
  test(`scenery cost stays flat along the demo route at ${tier} (#727)`, async ({ page }, testInfo) => {
    testInfo.setTimeout(240_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await installRideHarness(page);
    await pinTier(page, tier);
    await startDemoRide(page);
    if ((await waitForRideOutcome(page, 45_000)) !== 'ready') {
      await assertWellFormedDecline(page);
      test.skip(true, 'the engine declined (no hardware adapter)');
      return;
    }
    await forceRender(page);
    const total = await page.evaluate(() => (window as W).__ROWER3D_ROUTE?.totalDistance ?? 0);
    expect(total, 'the demo route is long enough for the 6 km check').toBeGreaterThan(LAST_METERS);

    const samples: Sample[] = [];
    for (let m = FIRST_METERS; m <= LAST_METERS; m += STEP_METERS) samples.push(await sampleAt(page, m));
    const shadows = samples.map((s) => s.shadowTriangles);
    const first = samples
      .filter((s) => s.metres <= START_REFERENCE_METERS)
      .reduce((a, b) => (b.residentMeshBytes > a.residentMeshBytes ? b : a));
    const last = samples[samples.length - 1];

    await page.evaluate(() => (window as W).__ROWER3D_SEEK_METERS?.(null));

    const gpu = samples.map((s) => s.gpuMs).filter((g) => g > 0);
    testInfo.annotations.push({
      type: 'scenery-cull',
      description:
        `${tier}: shadow triangles median ${(median(shadows) / 1000).toFixed(0)}k, max ${(Math.max(...shadows) / 1000).toFixed(0)}k; ` +
        `resident ${(first.residentMeshBytes / 1048576).toFixed(1)} MB at the start, ${(last.residentMeshBytes / 1048576).toFixed(1)} MB at ${LAST_METERS} m; ` +
        `gpuMs p95 ${gpu.length > 0 ? p95(gpu).toFixed(2) : 'n/a'}`,
    });
    testInfo.annotations.push({
      type: 'scenery-cull-samples',
      description: samples
        .map((s) => `${s.metres}: ${(s.shadowTriangles / 1000).toFixed(0)}k tris, ${(s.residentMeshBytes / 1048576).toFixed(1)} MB`)
        .join('; '),
    });

    expect(Math.max(...shadows), 'shadow triangles at their worst against their median').toBeLessThanOrEqual(1.5 * median(shadows));
    expect(last.residentMeshBytes, `resident mesh bytes at ${LAST_METERS} m against the start`).toBeLessThanOrEqual(
      1.25 * first.residentMeshBytes,
    );
    if (tier === 'medium' && gpu.length > 0) {
      expect(p95(gpu), 'medium gpuMs p95 along the route (AC-R3)').toBeLessThanOrEqual(GPU_MS_BUDGET.medium);
    }
  });
}
