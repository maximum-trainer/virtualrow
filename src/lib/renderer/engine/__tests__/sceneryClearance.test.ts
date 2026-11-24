// #761 — how close drawn scenery comes to the racing line.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptySceneryClearance,
  measureSceneryClearance,
  nearestOnPolyline,
  onWaterByDesign,
  sceneryClearanceThreshold,
} from '../sceneryClearance';
import { keepClearHalfWidth } from '../../../scenery/laneClearance';
import { footprintRadiusFor, BUILT_IN_FOOTPRINT_LOOKUP } from '../../../scenery/sceneryFootprints';
import { attach } from '../attach';
import { resetWebGPUHealth } from '../health';
import { installGPUStub, makeMockAdapter, makeMockCanvas, makeMockGPU } from '../../__tests__/_mockWebGPU';
import { releaseTelemetry } from '../telemetry';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toEngineRoute } from '../../../ui/sceneryRoute';
import { willowbrookRiverCoordinates } from '../../../../data/seedRouteCoordinates';
import { WILLOWBROOK_ROUTE_ID } from '../../../../components/rower3d/sceneryTrack';
import { routeTotalDistanceMeters } from '../../../utils/geoUtils';
import type { WaterRoute } from '../../../types';

const at = (x: number, z: number): Float32Array => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = x;
  m[14] = z;
  return m;
};

const straight: [number, number, number][] = [[0, 0, 0], [0, 0, -100], [0, 0, -200]];

describe('nearestOnPolyline', () => {
  it('projects onto the nearest segment and measures the distance along the route', () => {
    expect(nearestOnPolyline(straight, 30, -150)).toEqual({ distance: 30, progress: 150 });
    expect(nearestOnPolyline(straight, -5, 20)).toEqual({ distance: Math.hypot(5, 20), progress: 0 });
  });
});

describe('measureSceneryClearance', () => {
  it('reports the nearest footprint edge, its model and where along the route', () => {
    const tree = 'e01-tree-oak-mature';
    const house = 'b01-boathouse-new-england';
    const instances = new Map([
      [tree, [at(40, -50), at(-25, -120)]],
      [house, [at(60, -10)]],
    ]);
    const out = measureSceneryClearance(emptySceneryClearance(), straight, [tree, house], instances);
    expect(out.samples).toBe(3);
    expect(out.minId).toBe(tree);
    expect(out.min).toBeCloseTo(25 - footprintRadiusFor(tree, BUILT_IN_FOOTPRINT_LOOKUP), 6);
    expect(out.minProgress).toBeCloseTo(120, 6);
  });

  it('leaves out models that sit on the water by design, and skipped ones', () => {
    const instances = new Map([
      ['a01-buoy-lane-sphere', [at(1, -10)]],
      ['c02-bridge-road-concrete', [at(0, -60)]],
      ['a03-pontoon-floating-dock', [at(8, -5)]],
      ['e01-tree-oak-mature', [at(3, -5)]],
    ]);
    const out = measureSceneryClearance(
      emptySceneryClearance(),
      straight,
      instances.keys(),
      instances,
      (id) => id.startsWith('e01'),
    );
    expect(out).toMatchObject({ samples: 0, min: null, minId: null });
    expect(onWaterByDesign('b01-boathouse-new-england')).toBe(false);
  });

  // #753 FR2 — a stake's turn buoy sits inside the lane by design.
  it('lets a turn buoy stand inside the keep-clear corridor', () => {
    expect(onWaterByDesign('a02-buoy-turn-cylinder')).toBe(true);
  });

  it('holds the placement corridor less the bend tolerance', () => {
    expect(sceneryClearanceThreshold()).toBe(keepClearHalfWidth() - 1);
  });
});

describe('__ROWER3D_SCENERY_CLEARANCE on the demo route', () => {
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

  it('publishes in test mode, keeps every drawn model clear and is removed on dispose', async () => {
    const willowbrook: WaterRoute = {
      id: WILLOWBROOK_ROUTE_ID,
      name: 'Willowbrook River',
      description: '',
      distance: Math.round(routeTotalDistanceMeters(willowbrookRiverCoordinates)) / 1000,
      difficulty: 'easy',
      location: 'Willowbrook Valley',
      coordinates: willowbrookRiverCoordinates,
      elevationGain: 0,
      estimatedTime: 0,
      tags: [],
      createdAt: new Date('2026-01-01'),
    };
    const route = toEngineRoute(willowbrook, null, 'medium');
    const renderer = (await attach(makeMockCanvas(), {
      testMode: true,
      tier: 'medium',
      route,
      routeId: WILLOWBROOK_ROUTE_ID,
    })) as unknown as { _frameOnce: () => void; dispose(): void };
    expect(renderer).not.toBeNull();
    for (let i = 0; i < 30; i += 1) renderer._frameOnce();
    const g = globalThis as unknown as { __ROWER3D_SCENERY_CLEARANCE?: ReturnType<typeof emptySceneryClearance> };
    const c = g.__ROWER3D_SCENERY_CLEARANCE;
    expect(c?.samples).toBeGreaterThan(0);
    expect(c!.min!, `${c!.minId} at ${c!.minProgress} m`).toBeGreaterThanOrEqual(c!.thresholdM);
    renderer.dispose();
    expect(g.__ROWER3D_SCENERY_CLEARANCE).toBeUndefined();
  });
});
