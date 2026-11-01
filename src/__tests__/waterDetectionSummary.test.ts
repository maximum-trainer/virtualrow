import { afterEach, describe, expect, it } from 'vitest';
import {
  clearWaterDetectionSummary,
  EMPTY_WATER_DETECTION_SUMMARY,
  isWaterDebugEnabled,
  publishWaterDetectionSummary,
  type WaterDetectionSummary,
} from '../lib/renderer/engine/waterDetectionSummary';

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
