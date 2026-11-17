/**
 * #691 — synthetic scenery placement generator.
 *
 * Reads the route's already-computed OSM enrichment (bridge crossings,
 * marina polygons, …) and emits `ComposedPlacement` entries so routes
 * with no hand-authored kit (#690's `ROUTE_EXTRAS`) and no llm-cad
 * output (#692's tier-r registry) still pick up the obvious landmarks.
 *
 * Today this slice handles bridges. Boathouses / pontoons at
 * `leisure=marina` or `building=boathouse` polygons are a follow-up:
 * they need a widened OSM query and a bank-snap step, both out of
 * scope here.
 *
 * Data-only module: no three, no fetch, no engine imports beyond the
 * composite's own types. The caller (engine scene builder) wires the
 * output into `composePlacementsForRoute`.
 */

import type { Crossing } from '../utils/bridgeCrossings';
import type { ComposedPlacement } from './placementsForRoute';

/**
 * Model id for each OSM bridge kind. Mirrors
 * `src/components/rower3d/sceneryCrossings.ts` so the synthetic path
 * draws the same tier-c kit the hand-authored route does — writing
 * them here as string literals rather than importing avoids pulling
 * the React-side `SceneryModelId` union, which is distinct from the
 * engine's `courseFurniture.SceneryModelId`.
 */
export const BRIDGE_MODEL_FOR_KIND = {
  arch: 'c01-bridge-arch-masonry',
  road: 'c02-bridge-road-concrete',
  truss: 'c03-bridge-truss-steel',
  rail: 'c04-bridge-rail-girder',
  bascule: 'c05-bridge-bascule',
  foot: 'c06-bridge-foot-suspension',
  lift: 'c07-bridge-dutch-lift',
  cantilever: 'c08-bridge-cantilever',
} as const;

export interface SyntheticPlacementsInput {
  readonly routeId: string | null | undefined;
  /**
   * Bridge crossings surfaced by `findCrossings` during route
   * enrichment. Empty, undefined, or missing produces no bridge
   * placements.
   */
  readonly crossings?: readonly Crossing[];
}

/**
 * Emit synthetic placements for a route. Today: one bridge per
 * crossing, matched to the OSM tag kind, sitting at the river
 * centreline (`bankSide: 'centre'`).
 *
 * Order is preserved from the input so a later dedupe step
 * (`#691 follow-up`) can pair with hand-authored entries at the same
 * progress band.
 */
export const synthesisePlacementsForRoute = (
  input: SyntheticPlacementsInput,
): readonly ComposedPlacement[] => {
  const crossings = input.crossings ?? [];
  const out: ComposedPlacement[] = [];
  for (const c of crossings) {
    if (!(c.progress >= 0 && c.progress <= 1)) continue;
    out.push({
      modelId: BRIDGE_MODEL_FOR_KIND[c.kind],
      progress: c.progress,
      bankSide: 'centre',
      scale: 1,
      source: 'synthetic',
    });
  }
  return out;
};
