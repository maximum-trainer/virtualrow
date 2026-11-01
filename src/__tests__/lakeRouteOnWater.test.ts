/**
 * #493 AC6 (FR8, D21-ii) — a lake route whose samples leave the lake polygon
 * records those samples in `lakes.offWater` and surfaces the count in
 * `waterDetectionTelemetry`, so the course or the map can be fixed.
 *
 * D21-ii widens water locally rather than dropping the polygon, so the lake
 * still renders; the diagnostic is the `offWater` channel on telemetry.
 */
import { describe, expect, it } from 'vitest';
import {
  lakeSurfaceFor,
  waterDetectionTelemetry,
  type RouteEnrichmentData,
  type RouteSegmentEnrichment,
} from '../lib/services/routeEnrichmentService';
import type { Coordinate } from '../lib/types/index';
import type { LakePolygon } from '../lib/utils/lakePolygons';

const ring: Coordinate[] = [
  { lat: 51.5, lng: -0.11 },
  { lat: 51.5, lng: -0.10 },
  { lat: 51.502, lng: -0.10 },
  { lat: 51.502, lng: -0.11 },
  { lat: 51.5, lng: -0.11 },
];

const polygons: LakePolygon[] = [{ featureId: 'way/1', outer: ring, inner: [] }];

const coordinates: Coordinate[] = [
  { lat: 51.5005, lng: -0.105 },
  { lat: 51.5015, lng: -0.105 },
];

const segment = (startMeters: number, endMeters: number, onLake: boolean): RouteSegmentEnrichment =>
  ({
    index: 0,
    startMeters,
    endMeters,
    sceneryProfile: 'fallback',
    treeDensity: 0.5,
    vegetationDensity: 0.5,
    buildingDensity: 0.1,
    objectScale: 1,
    waterWidthMeters: 20,
    dragMultiplier: 1,
    bearing: 0,
    bearingDelta: 0,
    ...(onLake && { onLake: true }),
  }) as RouteSegmentEnrichment;

describe('#493 AC6 — route leaving water, offWater fallback', () => {
  it('attaches offWater samples when some route points lie off the lake', () => {
    const offWaterSamples: Coordinate[] = [{ lat: 51.5006, lng: -0.113 }];
    const result = lakeSurfaceFor(
      'lake',
      polygons,
      coordinates,
      [10, 20],
      [segment(0, 100, true)],
      offWaterSamples,
    );
    expect(result.lakes?.offWater).toEqual(offWaterSamples);
  });

  it('omits offWater when every sample is on the lake', () => {
    const result = lakeSurfaceFor('lake', polygons, coordinates, [10, 20], [segment(0, 100, true)], []);
    expect(result.lakes?.offWater).toBeUndefined();
  });

  it('surfaces the offWater count on waterDetectionTelemetry', () => {
    const offSample: Coordinate = { lat: 51.5006, lng: -0.113 };
    const enrichment = {
      waterBodyType: 'lake',
      source: 'live',
      lakes: {
        polygons,
        elevationMeters: 15,
        offWater: [offSample],
      },
    } as unknown as RouteEnrichmentData;

    const telemetry = waterDetectionTelemetry(enrichment);
    expect(telemetry).not.toBeNull();
    expect(telemetry).toMatchObject({
      lakes: 1,
      islands: 0,
      offWater: 1,
      offWaterSamples: [offSample],
    });
  });

  it('reports null telemetry for fallback enrichment (no OSM detection)', () => {
    const enrichment = {
      waterBodyType: 'river',
      source: 'fallback',
    } as unknown as RouteEnrichmentData;
    expect(waterDetectionTelemetry(enrichment)).toBeNull();
  });
});
