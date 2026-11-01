/**
 * #496 AC5 (FR3) — the grass density plan maps each segment's biome to a
 * density scalar, with left/right profile precedence and progress-based
 * interpolation. Pure plan, no GPU context.
 */
import { describe, expect, it } from 'vitest';
import {
  createGrassDensityForProgress,
  dominantGrassProfile,
  grassDensityForProfile,
  grassDensityPerSegment,
} from '../grassDensityPlan';
import type { RouteEnrichmentData, RouteSegmentEnrichment } from '../../../services/routeEnrichmentService';

const segment = (
  index: number,
  startMeters: number,
  endMeters: number,
  profile: RouteSegmentEnrichment['sceneryProfile'],
  leftProfile?: RouteSegmentEnrichment['leftSceneryProfile'],
  rightProfile?: RouteSegmentEnrichment['rightSceneryProfile'],
): RouteSegmentEnrichment =>
  ({
    index,
    startMeters,
    endMeters,
    sceneryProfile: profile,
    treeDensity: 0.5,
    vegetationDensity: 0.5,
    buildingDensity: 0.1,
    objectScale: 1,
    waterWidthMeters: 20,
    dragMultiplier: 1,
    bearing: 0,
    bearingDelta: 0,
    ...(leftProfile && { leftSceneryProfile: leftProfile }),
    ...(rightProfile && { rightSceneryProfile: rightProfile }),
  }) as RouteSegmentEnrichment;

describe('grassDensityForProfile', () => {
  it('returns a monotonic ordering by biome lushness', () => {
    const forest = grassDensityForProfile('forest');
    const residential = grassDensityForProfile('residential');
    const commercial = grassDensityForProfile('commercial');
    expect(forest).toBeGreaterThan(residential);
    expect(residential).toBeGreaterThan(commercial);
  });

  it('every biome lies in [0, 1]', () => {
    for (const p of ['forest', 'residential', 'commercial', 'farmland', 'beach', 'wetland', 'fallback'] as const) {
      const d = grassDensityForProfile(p);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });
});

describe('grassDensityPerSegment — AC5 per-segment table', () => {
  it('reads each segment through the greener of its two banks', () => {
    const segments = [
      segment(0, 0, 50, 'commercial', 'forest', 'commercial'),
      segment(1, 50, 100, 'residential', 'residential', 'wetland'),
    ];
    const densities = grassDensityPerSegment(segments);
    expect(densities).toHaveLength(2);
    expect(densities[0]).toBe(grassDensityForProfile('forest'));
    expect(densities[1]).toBe(grassDensityForProfile('wetland'));
  });

  it('falls back to the segment dominant profile when a bank has none', () => {
    const segments = [segment(0, 0, 50, 'beach')];
    expect(grassDensityPerSegment(segments)[0]).toBe(grassDensityForProfile('beach'));
  });
});

describe('createGrassDensityForProgress — AC5 interpolation', () => {
  it('yields the fallback density on empty enrichment', () => {
    const d = createGrassDensityForProgress(null);
    expect(d(0)).toBe(grassDensityForProfile('fallback'));
    expect(d(1)).toBe(grassDensityForProfile('fallback'));
  });

  it('interpolates linearly across segments', () => {
    const enrichment = {
      segmentProfiles: [
        segment(0, 0, 50, 'commercial'),
        segment(1, 50, 100, 'forest'),
      ],
    } as unknown as RouteEnrichmentData;
    const d = createGrassDensityForProgress(enrichment);
    expect(d(0)).toBeCloseTo(grassDensityForProfile('commercial'), 5);
    expect(d(1)).toBeCloseTo(grassDensityForProfile('forest'), 5);
    const mid = (grassDensityForProfile('commercial') + grassDensityForProfile('forest')) / 2;
    expect(d(0.5)).toBeCloseTo(mid, 5);
  });

  it('clamps progress outside [0, 1]', () => {
    const enrichment = {
      segmentProfiles: [segment(0, 0, 50, 'beach')],
    } as unknown as RouteEnrichmentData;
    const d = createGrassDensityForProgress(enrichment);
    expect(d(-1)).toBe(grassDensityForProfile('beach'));
    expect(d(2)).toBe(grassDensityForProfile('beach'));
  });
});

describe('dominantGrassProfile', () => {
  it('picks the biome with the highest density across either bank', () => {
    const enrichment = {
      segmentProfiles: [
        segment(0, 0, 50, 'commercial', 'commercial', 'commercial'),
        segment(1, 50, 100, 'residential', 'forest', 'residential'),
      ],
    } as unknown as RouteEnrichmentData;
    expect(dominantGrassProfile(enrichment)).toBe('forest');
  });

  it('returns fallback on no segments', () => {
    expect(dominantGrassProfile(null)).toBe('fallback');
    expect(dominantGrassProfile({ segmentProfiles: [] } as unknown as RouteEnrichmentData)).toBe('fallback');
  });
});
