/**
 * Polygon-water feature flag (#493 Phase 3 / AC13 / NFR7).
 *
 * Rendering lakes and open water from their OSM polygon is new behaviour
 * and must ship behind a kill-switch so a regression can be turned off
 * without a revert. With the flag off the engine draws the swept ribbon
 * exactly as today's water pass does; with it on, the polygon-water pass
 * takes over for routes whose enrichment carries `lakePolygons`.
 *
 * The flag defaults to **off** until Phase 3's GPU-runner baselines are
 * recorded; the kill switch stays even after the default flips so a
 * failing site/tier can disable it live.
 */

/** Whether polygon water should render for this scene. */
export const isPolygonWaterEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  const g = (window as unknown as { __VIRTUALROW_POLYGON_WATER?: boolean }).__VIRTUALROW_POLYGON_WATER;
  // Default off; an explicit true turns it on, anything else (undefined or
  // false) leaves it off while the GPU-runner baselines settle.
  return g === true;
};
