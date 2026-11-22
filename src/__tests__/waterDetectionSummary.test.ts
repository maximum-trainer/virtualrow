import { afterEach, describe, expect, it } from 'vitest';
import {
  clearWaterDetectionSummary,
  EMPTY_WATER_DETECTION_SUMMARY,
  isWaterDebugEnabled,
  publishWaterDetectionSummary,
  type WaterDetectionSummary,
  waterDetectionSummaryOf,
} from '../lib/renderer/engine/waterDetectionSummary';
import {
  createFallbackRouteEnrichment,
  type RouteEnrichmentData,
} from '../lib/services/routeEnrichmentService';
import type { WaterRoute } from '../lib/types/index';

type WithFlag = Window & {
  __VIRTUALROW_WATER_DEBUG?: boolean;
  __ROWER3D_WATER_DETECTION?: WaterDetectionSummary;
};

const getWindow = () => window as unknown as WithFlag;

afterEach(() => {
  const w = getWindow();
  delete w.__VIRTUALROW_WATER_DEBUG;
  delete w.__ROWER3D_WATER_DETECTION;
});

describe('waterDetectionSummary', () => {
  it('EMPTY_WATER_DETECTION_SUMMARY is zeroed with widthSource "none"', () => {
    expect(EMPTY_WATER_DETECTION_SUMMARY).toEqual({
      onWater: 0,
      onLand: 0,
      unknown: 0,
      islandCount: 0,
      widthSource: 'none',
    });
  });

  it('isWaterDebugEnabled is false by default', () => {
    expect(isWaterDebugEnabled()).toBe(false);
  });

  it('isWaterDebugEnabled is true only when the flag is strictly true', () => {
    const w = getWindow();
    w.__VIRTUALROW_WATER_DEBUG = true;
    expect(isWaterDebugEnabled()).toBe(true);
    (w as unknown as { __VIRTUALROW_WATER_DEBUG: unknown }).__VIRTUALROW_WATER_DEBUG = 1;
    expect(isWaterDebugEnabled()).toBe(false);
  });

  it('publishWaterDetectionSummary writes the global the DebugPanel reads', () => {
    const summary: WaterDetectionSummary = {
      onWater: 42,
      onLand: 3,
      unknown: 1,
      islandCount: 2,
      widthSource: 'measured',
    };
    publishWaterDetectionSummary(summary);
    expect(getWindow().__ROWER3D_WATER_DETECTION).toEqual(summary);
  });

  it('clearWaterDetectionSummary wipes the published summary', () => {
    publishWaterDetectionSummary({ ...EMPTY_WATER_DETECTION_SUMMARY, onWater: 7 });
    clearWaterDetectionSummary();
    expect(getWindow().__ROWER3D_WATER_DETECTION).toBeUndefined();
  });
});

// #741 — the summary the engine publishes is rolled up from the route's
// enrichment; before, nothing fed it and every route read widthSource "none".
describe('waterDetectionSummaryOf (#741)', () => {
  const route = {
    id: 'r1',
    name: 'Test Canal',
    coordinates: [{ lat: 51.5, lng: -0.1 }, { lat: 51.501, lng: -0.1 }],
    tags: [],
  } as unknown as WaterRoute;
  const fallback = createFallbackRouteEnrichment(route);
  const osm: RouteEnrichmentData = {
    ...fallback,
    source: 'network',
    enrichmentSource: 'osm-no-elevation',
    segmentProfiles: fallback.segmentProfiles.map((segment, i) =>
      i === 0 ? { ...segment, leftShoreMeters: 21, rightShoreMeters: 19 } : segment),
    waterDetection: { shares: {} as never, water: 12, land: 2, unknown: 1 },
    lakes: {
      polygons: [{ outer: [], inner: [[], []] }],
      elevationMeters: 0,
    } as unknown as RouteEnrichmentData['lakes'],
  };

  it('is the empty summary with no enrichment', () => {
    expect(waterDetectionSummaryOf(null)).toEqual(EMPTY_WATER_DETECTION_SUMMARY);
  });

  it('reads default widths on the fallback', () => {
    expect(waterDetectionSummaryOf(fallback)).toMatchObject({
      widthSource: 'default',
      enrichmentSource: 'fallback',
    });
  });

  it('reads measured widths, the sample counts and the islands from OSM data', () => {
    expect(waterDetectionSummaryOf(osm)).toEqual({
      onWater: 12,
      onLand: 2,
      unknown: 1,
      islandCount: 2,
      widthSource: 'measured',
      enrichmentSource: 'osm-no-elevation',
    });
  });

  it('reads tag widths from OSM data with no measured shore', () => {
    const tagged = { ...osm, segmentProfiles: fallback.segmentProfiles };
    expect(waterDetectionSummaryOf(tagged).widthSource).toBe('tag');
  });
});
