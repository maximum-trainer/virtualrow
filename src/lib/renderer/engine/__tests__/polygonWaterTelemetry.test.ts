/**
 * #493 AC6 follow-up — polygon-water render telemetry.
 *
 * The engine publishes `__ROWER3D_POLYGON_WATER` so a Playwright smoke
 * can tell the Phase 3+ polygon path from the ribbon fallback without
 * reaching into the engine. These vitests pin the roll-up and the
 * publish/clear contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPolygonWaterTelemetry,
  publishPolygonWaterTelemetry,
  summarisePolygonWater,
  type PolygonWaterRings,
} from '../polygonWaterTelemetry';

type WinWithTelemetry = Window & { __ROWER3D_POLYGON_WATER?: unknown };

const win = () => window as unknown as WinWithTelemetry;

afterEach(() => {
  clearPolygonWaterTelemetry();
});

describe('summarisePolygonWater', () => {
  it('counts polygons and sums their outer + hole vertices', () => {
    const polygons: PolygonWaterRings[] = [
      { outer: new Array(10).fill({}), holes: [new Array(4).fill({})] },
      { outer: new Array(6).fill({}), holes: [] },
    ];
    const summary = summarisePolygonWater(polygons, 2048, false);
    expect(summary).toEqual({
      lakeCount: 2,
      maxRingVertices: 10,
      totalVertices: 20,
      tierCap: 2048,
      fallback: false,
    });
  });

  it('zeroes everything on an empty list, keeps the tier cap, and marks fallback', () => {
    const summary = summarisePolygonWater([], 512, true);
    expect(summary).toEqual({
      lakeCount: 0,
      maxRingVertices: 0,
      totalVertices: 0,
      tierCap: 512,
      fallback: true,
    });
  });
});

describe('publishPolygonWaterTelemetry', () => {
  it('writes the summary to __ROWER3D_POLYGON_WATER', () => {
    publishPolygonWaterTelemetry({
      lakeCount: 1,
      maxRingVertices: 128,
      totalVertices: 128,
      tierCap: 512,
      fallback: false,
    });
    expect(win().__ROWER3D_POLYGON_WATER).toEqual({
      lakeCount: 1,
      maxRingVertices: 128,
      totalVertices: 128,
      tierCap: 512,
      fallback: false,
    });
  });

  it('clearPolygonWaterTelemetry removes the global', () => {
    publishPolygonWaterTelemetry({
      lakeCount: 1,
      maxRingVertices: 1,
      totalVertices: 1,
      tierCap: 1,
      fallback: false,
    });
    clearPolygonWaterTelemetry();
    expect(win().__ROWER3D_POLYGON_WATER).toBeUndefined();
  });
});
