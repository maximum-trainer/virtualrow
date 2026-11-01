/**
 * Polygon-water render telemetry (#493 AC6 follow-up).
 *
 * The route-leaves-water AC is already proven at the Vitest level by
 * `src/__tests__/lakeRouteOnWater.test.ts` (D21-ii: samples off the lake
 * are recorded in `lakes.offWater` rather than dropping the polygon).
 * What was missing was end-to-end proof that the engine's polygon-water
 * path actually fires on a route whose enrichment carries lakes — so a
 * Playwright spec can distinguish the Phase 3/4/5 code paths from the
 * ribbon fallback without reaching into the engine.
 *
 * This module publishes `__ROWER3D_POLYGON_WATER` after the per-tier
 * simplifier has run, with:
 *   - `lakeCount`         — simplified polygons uploaded this attach.
 *   - `maxRingVertices`   — largest single outer-ring vertex count.
 *   - `totalVertices`     — summed outer+hole vertex count.
 *   - `tierCap`           — the tier's `polygonWaterMaxVertices`.
 *   - `fallback`          — true when the polygon pass declined (kill
 *                           switch off, empty polygons, tessellation
 *                           empty), so the ribbon rendered instead.
 *
 * CPU-side only. No GPU work; the frame loop doesn't touch this.
 */

export interface PolygonWaterTelemetry {
  lakeCount: number;
  maxRingVertices: number;
  totalVertices: number;
  tierCap: number;
  fallback: boolean;
}

export interface PolygonWaterRings {
  outer: ReadonlyArray<unknown>;
  holes: ReadonlyArray<ReadonlyArray<unknown>>;
}

const win = () => (typeof window === 'undefined' ? null : (window as unknown as Record<string, unknown>));

/** Roll a list of ring-shaped polygons into the telemetry shape. */
export const summarisePolygonWater = (
  polygons: ReadonlyArray<PolygonWaterRings>,
  tierCap: number,
  fallback: boolean,
): PolygonWaterTelemetry => {
  let maxRingVertices = 0;
  let totalVertices = 0;
  for (const polygon of polygons) {
    const outer = polygon.outer.length;
    if (outer > maxRingVertices) maxRingVertices = outer;
    totalVertices += outer;
    for (const hole of polygon.holes) {
      totalVertices += hole.length;
    }
  }
  return {
    lakeCount: polygons.length,
    maxRingVertices,
    totalVertices,
    tierCap,
    fallback,
  };
};

/** Publish the summary to the window global the Playwright spec reads. */
export const publishPolygonWaterTelemetry = (summary: PolygonWaterTelemetry): void => {
  const w = win();
  if (!w) return;
  w['__ROWER3D_POLYGON_WATER'] = summary;
};

export const clearPolygonWaterTelemetry = (): void => {
  const w = win();
  if (!w) return;
  delete w['__ROWER3D_POLYGON_WATER'];
};
