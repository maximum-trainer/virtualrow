// #727 VP-09 acceptance: what the scenery costs stays flat along the route.
// Culling by cell (FR1/FR2) keeps the drawn and shadow-cast triangles to
// what is near the boat; unloading what is behind (FR3) keeps the resident
// mesh memory from growing with the distance rowed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toEngineRoute } from '../../../ui/sceneryRoute';
import { willowbrookRiverCoordinates } from '../../../../data/seedRouteCoordinates';
import { WILLOWBROOK_ROUTE_ID } from '../../../../components/rower3d/sceneryTrack';
import { routeTotalDistanceMeters } from '../../../utils/geoUtils';
import type { WaterRoute } from '../../../types';
import { attach } from '../attach';
import { resetWebGPUHealth } from '../health';
import { installGPUStub, makeMockAdapter, makeMockCanvas, makeMockGPU } from '../../__tests__/_mockWebGPU';
import { releaseTelemetry } from '../telemetry';
import { RENDER_BUDGET } from '../../renderBudget';

type Harness = {
  _frameOnce: () => void;
  _telemetry: {
    scenery: { unloaded: number };
    renderStats: { shadowTriangles: number; triangles: number; residentMeshes: number; residentMeshBytes: number };
  };
  dispose(): void;
};

const originalFetch = globalThis.fetch;
beforeEach(() => {
  installGPUStub(makeMockGPU(makeMockAdapter()));
  resetWebGPUHealth();
  // Serve the kit GLBs from public/, so the scenery really registers.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const path = resolve(process.cwd(), 'public', url.replace(/^.*?\/assets\//, 'assets/').split('?')[0]);
    return existsSync(path) && /\/assets\//.test(url) ? new Response(readFileSync(path)) : new Response(null, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  installGPUStub(undefined);
  releaseTelemetry();
});

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

describe('flat scenery cost along Willowbrook (#727)', () => {
  it('shadow triangles stay near the median and resident meshes do not grow with distance', async () => {
    const willowbrook: WaterRoute = {
      id: WILLOWBROOK_ROUTE_ID,
      name: 'Willowbrook River',
      description: '',
      distance: routeTotalDistanceMeters(willowbrookRiverCoordinates) / 1000,
      difficulty: 'easy',
      location: 'Willowbrook Valley',
      coordinates: willowbrookRiverCoordinates,
      elevationGain: 0,
      estimatedTime: 0,
      tags: [],
      createdAt: new Date('2026-01-01'),
    };
    const total = routeTotalDistanceMeters(willowbrookRiverCoordinates);
    let distance = 0;
    const renderer = (await attach(makeMockCanvas(), {
      testMode: true,
      tier: 'high',
      route: toEngineRoute(willowbrook, null, 'high'),
      routeId: WILLOWBROOK_ROUTE_ID,
      getFrame: () => ({
        paceSPer500: 120,
        distanceMeters: distance,
        cadence: 24,
        isPlaying: true,
        holdBoat: false,
        finished: false,
        intensityFactor: 1,
        elapsedSeconds: distance / 4,
        ghost: null,
      }),
    })) as unknown as Harness;
    expect(renderer).not.toBeNull();

    // Let each stop's model loads settle before reading the stats.
    const settle = async () => {
      for (let i = 0; i < 6; i += 1) {
        renderer._frameOnce();
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    const shadows: number[] = [];
    const drawn: number[] = [];
    const resident: { at: number; bytes: number }[] = [];
    for (distance = 0; distance <= total; distance += 250) {
      await settle();
      const s = renderer._telemetry.renderStats;
      shadows.push(s.shadowTriangles);
      drawn.push(s.triangles);
      resident.push({ at: distance, bytes: s.residentMeshBytes });
    }
    expect(median(shadows)).toBeGreaterThan(0);
    expect(Math.max(...shadows), `shadow triangles every 250 m: ${shadows.join(', ')}`).toBeLessThanOrEqual(
      1.5 * median(shadows),
    );
    // #725 FR7 — denser stations still fit the tier's triangle budget.
    expect(Math.max(...drawn), `triangles every 250 m: ${drawn.join(', ')}`).toBeLessThanOrEqual(
      RENDER_BUDGET.high.triangles,
    );
    // Measured from once the first look-ahead window (at least 600 m, #726
    // FR2) has loaded: with stations every 35 m (#725 FR1) the route's
    // models are still arriving at 500 m.
    const early = resident.find((r) => r.at >= 1000)!;
    const late = resident[resident.length - 1];
    expect(early.bytes).toBeGreaterThan(0);
    expect(late.bytes, `resident bytes: ${resident.map((r) => `${r.at} m ${r.bytes}`).join(', ')}`).toBeLessThanOrEqual(
      1.25 * early.bytes,
    );
    expect(renderer._telemetry.scenery.unloaded).toBeGreaterThan(0);
    renderer.dispose();
  }, 120_000);
});
