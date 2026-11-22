import { describe, expect, it } from 'vitest';
import {
  waterHalfWidthAt,
  DEFAULT_WATER_WIDTH_METERS,
} from '../waterHalfWidth';
import type { RouteEnrichmentData } from '../../services/routeEnrichmentService';

describe('waterHalfWidthAt (#723 FR4)', () => {
  it('falls back to DEFAULT_WATER_WIDTH_METERS / 2 with no enrichment', () => {
    expect(waterHalfWidthAt(null, 0.5, 'left')).toBe(DEFAULT_WATER_WIDTH_METERS / 2);
    expect(waterHalfWidthAt(undefined, 0.5, 'right')).toBe(DEFAULT_WATER_WIDTH_METERS / 2);
  });

  it('honours enrichment.waterWidthMeters when segment profiles are empty', () => {
    const e = { waterWidthMeters: 45, segmentProfiles: [] } as unknown as RouteEnrichmentData;
    expect(waterHalfWidthAt(e, 0.5, 'left')).toBe(22.5);
  });

  it('interpolates between adjacent segment profiles on each side', () => {
    const e = {
      segmentProfiles: [
        { leftShoreMeters: 10, rightShoreMeters: 10, sceneryProfile: 'fallback' },
        { leftShoreMeters: 30, rightShoreMeters: 20, sceneryProfile: 'fallback' },
      ],
    } as unknown as RouteEnrichmentData;
    expect(waterHalfWidthAt(e, 0, 'left')).toBe(10);
    expect(waterHalfWidthAt(e, 1, 'left')).toBe(30);
    expect(waterHalfWidthAt(e, 0.5, 'left')).toBe(20);
    expect(waterHalfWidthAt(e, 0.5, 'right')).toBe(15);
  });

  it('clamps progress and falls back when a side reports zero', () => {
    const e = {
      segmentProfiles: [
        { leftShoreMeters: 0, rightShoreMeters: 25, sceneryProfile: 'fallback' },
        { leftShoreMeters: 0, rightShoreMeters: 25, sceneryProfile: 'fallback' },
      ],
    } as unknown as RouteEnrichmentData;
    expect(waterHalfWidthAt(e, 2, 'left')).toBe(DEFAULT_WATER_WIDTH_METERS / 2);
    expect(waterHalfWidthAt(e, -1, 'right')).toBe(25);
  });
});
