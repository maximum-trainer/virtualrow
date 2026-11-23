// #742 VP-22 acceptance on the recorded rownative courses: lake laps and
// stake races whose return leg runs beside the outbound leg.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import lap115 from '../../../../__tests__/fixtures/rownative/115.json';
import seekonk104 from '../../../../__tests__/fixtures/rownative/104.json';
import hots109 from '../../../../__tests__/fixtures/rownative/109.json';
import wormtown99 from '../../../../__tests__/fixtures/rownative/99.json';
import { resolveCourseGeometry, type RownativeCourseGeometryInput } from '../../../services/rownativeGeometry';
import { toEngineRoute } from '../../../ui/sceneryRoute';
import { routeTotalDistanceMeters } from '../../../utils/geoUtils';
import { willowbrookRiverCoordinates } from '../../../../data/seedRouteCoordinates';
import type { Coordinate, WaterRoute } from '../../../types';
import { attach } from '../attach';
import { resetWebGPUHealth } from '../health';
import { installGPUStub, makeMockAdapter, makeMockCanvas, makeMockGPU } from '../../__tests__/_mockWebGPU';
import { releaseTelemetry } from '../telemetry';

type Harness = {
  _frameOnce: () => void;
  _telemetry: {
    clearance: { surface?: string };
    route: { selfParallel?: [number, number][] };
    renderStats: { shadowTriangles: number };
  };
  dispose(): void;
};

const waterRoute = (id: string, name: string, coordinates: Coordinate[]): WaterRoute => ({
  id,
  name,
  description: '',
  distance: routeTotalDistanceMeters(coordinates) / 1000,
  difficulty: 'easy',
  location: '',
  coordinates,
  elevationGain: 0,
  estimatedTime: 0,
  tags: [],
  createdAt: new Date('2026-01-01'),
});

const courseRoute = async (file: unknown): Promise<WaterRoute> => {
  const input = file as RownativeCourseGeometryInput;
  const resolved = await resolveCourseGeometry(input);
  return waterRoute(`rownative-${input.id}`, input.name ?? input.id, resolved.coordinates);
};

/** A 2 km out-and-back whose legs run 30 m apart (centre to centre). */
const syntheticOutAndBack = (): WaterRoute => {
  const lat0 = 42.27;
  const lng0 = -71.76;
  const mPerDegLat = 111_320;
  const mPerDegLng = mPerDegLat * Math.cos((lat0 * Math.PI) / 180);
  const pts: Coordinate[] = [];
  for (let n = 0; n <= 1000; n += 50) pts.push({ lat: lat0 + n / mPerDegLat, lng: lng0 });
  for (let k = 1; k < 8; k += 1) {
    const a = (k / 8) * Math.PI;
    pts.push({ lat: lat0 + (1000 + 15 * Math.sin(a)) / mPerDegLat, lng: lng0 + (15 - 15 * Math.cos(a)) / mPerDegLng });
  }
  for (let n = 1000; n >= 0; n -= 50) pts.push({ lat: lat0 + n / mPerDegLat, lng: lng0 + 30 / mPerDegLng });
  return waterRoute('synthetic-out-and-back', 'Synthetic out-and-back', pts);
};

let distance = 0;
const at = () => ({
  paceSPer500: 120,
  distanceMeters: distance,
  cadence: 24,
  isPlaying: true,
  holdBoat: false,
  finished: false,
  intensityFactor: 1,
  elapsedSeconds: distance / 4,
  ghost: null,
});

const ride = async (route: WaterRoute, tier = 'medium'): Promise<Harness> => {
  distance = 0;
  const engineRoute = toEngineRoute(route, null, tier as 'medium');
  expect(engineRoute).not.toBeNull();
  const renderer = (await attach(makeMockCanvas(), {
    testMode: true,
    tier,
    route: engineRoute,
    getFrame: at,
  })) as unknown as Harness;
  expect(renderer).not.toBeNull();
  return renderer;
};

beforeEach(() => {
  installGPUStub(makeMockGPU(makeMockAdapter()));
  resetWebGPUHealth();
});
afterEach(() => {
  installGPUStub(undefined);
  releaseTelemetry();
});

describe('the boat is always on water (#742)', () => {
  const cases: [string, () => Promise<WaterRoute>][] = [
    ['Lap of the Lake (Quinsigamond)', () => courseRoute(lap115)],
    ['Seekonk North Stake Race', () => courseRoute(seekonk104)],
    ['HOTS Stake Race Rev B', () => courseRoute(hots109)],
    ['Wormtown Chase', () => courseRoute(wormtown99)],
    ['a synthetic 2 km out-and-back with 30 m leg spacing', async () => syntheticOutAndBack()],
  ];
  it.each(cases)('%s: water under the hull every 10 m', async (_name, build) => {
    const route = await build();
    const total = routeTotalDistanceMeters(route.coordinates);
    const renderer = await ride(route);
    const land: number[] = [];
    for (distance = 0; distance <= total; distance += 10) {
      renderer._frameOnce();
      if (renderer._telemetry.clearance.surface !== 'water') land.push(Math.round(distance));
    }
    expect(land, `land under the boat at these metres of ${Math.round(total)}`).toEqual([]);
    renderer.dispose();
  }, 60_000);
});

describe('overlap does not double the cost (#742 FR4)', () => {
  it('Quinsigamond lap at high: shadow triangles at the start <= 1.3x Willowbrook scaled by length', async () => {
    const lap = await courseRoute(lap115);
    const willowbrook = waterRoute('willowbrook', 'Willowbrook River', willowbrookRiverCoordinates);
    const shadowsAtStart = async (route: WaterRoute) => {
      const renderer = await ride(route, 'high');
      for (let i = 0; i < 3; i += 1) renderer._frameOnce();
      const t = renderer._telemetry.renderStats.shadowTriangles;
      renderer.dispose();
      return t;
    };
    const lapTriangles = await shadowsAtStart(lap);
    const riverTriangles = await shadowsAtStart(willowbrook);
    const scale = routeTotalDistanceMeters(lap.coordinates) / routeTotalDistanceMeters(willowbrookRiverCoordinates);
    expect(riverTriangles).toBeGreaterThan(0);
    expect(lapTriangles).toBeLessThanOrEqual(1.3 * riverTriangles * scale);
  }, 60_000);
});
