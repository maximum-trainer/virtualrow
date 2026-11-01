/**
 * Polygon-water feature flag (#493 Phase 4 / AC13 / NFR7).
 *
 * Rendering lakes and open water from their OSM polygon is the default
 * from Phase 4 onwards: a route whose enrichment carries `lakePolygons`
 * is drawn with the polygon-water pass; the swept-ribbon strip stays
 * wired for rivers and offline fallbacks where no polygons exist.
 *
 * The flag is a **kill switch**, not an opt-in: an explicit `false`
 * turns polygon water off live without a revert, so a failing site or
 * tier can be rolled back by setting the global. Any other value
 * (`undefined`, `true`, truthy-but-not-false) leaves the default on.
 */

/** Whether polygon water should render for this scene. */
export const isPolygonWaterEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  const g = (window as unknown as { __VIRTUALROW_POLYGON_WATER?: boolean }).__VIRTUALROW_POLYGON_WATER;
  // Default on from Phase 4 (#493). Only an explicit `false` disables it;
  // undefined/true/anything else leaves the polygon pass live.
  return g !== false;
};
