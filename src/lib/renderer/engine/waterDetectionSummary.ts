/**
 * Water-detection summary surfaced on the engine telemetry bag
 * (#493 Phase 3d / FR22 / AC23).
 *
 * Enrichment computes per-sample classifications (water / land /
 * unknown) when the detection worker runs. This file names the shape
 * the engine publishes as `__ROWER3D_WATER_DETECTION` and provides a
 * pure helper to roll it up from the enrichment's segment outputs. The
 * DebugPanel reads the global and shows the four numbers (on-water,
 * on-land, unknown, island count) plus the width source. The debug
 * overlay (`passes/waterDebug.ts`) reads the same input to draw its
 * line markers.
 */

export type WaterWidthSource = 'measured' | 'tag' | 'default' | 'none';

export interface WaterDetectionSummary {
  onWater: number;
  onLand: number;
  unknown: number;
  islandCount: number;
  widthSource: WaterWidthSource;
}

const EMPTY: WaterDetectionSummary = {
  onWater: 0,
  onLand: 0,
  unknown: 0,
  islandCount: 0,
  widthSource: 'none',
};

/** Whether the overlay should be drawn and the summary published. */
export const isWaterDebugEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  const g = (window as unknown as { __VIRTUALROW_WATER_DEBUG?: boolean })
    .__VIRTUALROW_WATER_DEBUG;
  return g === true;
};

/** Publish the summary to the window global that the DebugPanel reads. */
export const publishWaterDetectionSummary = (summary: WaterDetectionSummary): void => {
  if (typeof window === 'undefined') return;
  (window as unknown as { __ROWER3D_WATER_DETECTION?: WaterDetectionSummary })
    .__ROWER3D_WATER_DETECTION = summary;
};

export const clearWaterDetectionSummary = (): void => {
  if (typeof window === 'undefined') return;
  (window as unknown as { __ROWER3D_WATER_DETECTION?: WaterDetectionSummary })
    .__ROWER3D_WATER_DETECTION = undefined;
};

export { EMPTY as EMPTY_WATER_DETECTION_SUMMARY };
