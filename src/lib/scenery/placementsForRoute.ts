/**
 * #692 — composite placement loader.
 *
 * The engine resolves scenery placements for a route from three
 * independent sources, in strict precedence:
 *
 *   1. `route-placements.json` (tier-r, #449's llm-cad output). Wins.
 *   2. `ROUTE_EXTRAS` hand-authored per engine route id in
 *      `courseFurniture.ts` (#690). Used when the llm-cad source has
 *      nothing for the route.
 *   3. A synthetic generator that walks the OSM data (#691). Used when
 *      the hand-authored source has nothing either.
 *
 * An entry in any source carries an optional `castsShadow` that, when
 * set, overrides the engine's per-model default (#688). Unset falls
 * through to the model default.
 *
 * This module is data-only: it composes the three streams and emits a
 * normalised list. The engine's streaming controller and the shadow-
 * caster hook consume the list without having to care which source any
 * one entry came from.
 */

import type { Furniture } from './courseFurniture';
import type { RoutePlacement, RoutePlacementsRegistry } from './routePlacements';
import { placementsForRoute as tierRPlacementsForRoute } from './routePlacements';

/**
 * One placement in the engine's canonical form, normalised across the
 * three sources. `source` is diagnostic — the engine doesn't branch on
 * it, but telemetry and the composite's own tests do.
 */
export interface ComposedPlacement {
  /** Scenery model id (tier-a..e for kit items, tier-r for llm-cad props). */
  readonly modelId: string;
  /** Fraction along the route, [0, 1]. */
  readonly progress: number;
  /** Which bank, or 'centre' for span furniture (bridges). */
  readonly bankSide: 'left' | 'right' | 'centre';
  /**
   * Lateral offset from the centreline, metres. `undefined` lets the
   * engine fall back to its lane-width / shore-margin defaults; a tier-r
   * entry always supplies a concrete number.
   */
  readonly lateralOffsetMeters?: number;
  /**
   * Rotation around world-Y in radians. `undefined` lets the engine
   * auto-orient off the tangent (buoys with current, furniture facing
   * water); tier-r entries supply a baked orientation in degrees, which
   * the composite converts to radians.
   */
  readonly rotationY?: number;
  /** Instance scale multiplier applied to the authored GLB. Default 1. */
  readonly scale: number;
  /** When set, overrides the engine's per-model shadow default (#688). */
  readonly castsShadow?: boolean;
  /** Which source emitted this placement. */
  readonly source: 'tier-r' | 'hand-authored' | 'synthetic';
}

/** Inputs to the composite. Any source can be absent. */
export interface ComposePlacementsInput {
  readonly routeId: string | null | undefined;
  readonly routeMeters: number;
  /** Parsed tier-r registry, from `route-placements.json`. */
  readonly tierR?: RoutePlacementsRegistry | null;
  /**
   * Hand-authored extras from `ROUTE_EXTRAS` (#690). Already in
   * `Furniture` shape — the composite normalises them.
   */
  readonly handAuthored?: readonly Furniture[];
  /** Synthetic generator output (#691). Normalised ComposedPlacement list. */
  readonly synthetic?: readonly ComposedPlacement[];
}

const tierRToComposed = (p: RoutePlacement, routeMeters: number): ComposedPlacement => ({
  modelId: p.modelId,
  progress: routeMeters > 0 ? Math.min(1, Math.max(0, p.distanceAlongRouteMeters / routeMeters)) : 0,
  bankSide: p.bankSide,
  lateralOffsetMeters: p.lateralOffsetMeters,
  rotationY: (p.orientationDegrees * Math.PI) / 180,
  scale: p.scale,
  ...(typeof p.castsShadow === 'boolean' ? { castsShadow: p.castsShadow } : {}),
  source: 'tier-r',
});

const furnitureToComposed = (f: Furniture): ComposedPlacement => ({
  modelId: f.id,
  progress: f.progress,
  bankSide: f.side,
  scale: 1,
  source: 'hand-authored',
});

/**
 * Compose the three placement sources into one list under the #692
 * precedence rule. An empty tier-r registry doesn't block the
 * hand-authored or synthetic sources; a hand-authored list for the
 * route doesn't block the synthetic source. Only sources beneath a
 * populated higher-precedence one are skipped.
 *
 * "Populated" means the resolved list for *this route* is non-empty;
 * a tier-r registry with entries for other routes but not this one
 * still lets the hand-authored source run.
 */
export const composePlacementsForRoute = (
  input: ComposePlacementsInput,
): readonly ComposedPlacement[] => {
  const { routeId, routeMeters, tierR, handAuthored, synthetic } = input;

  const tierRList = tierR
    ? tierRPlacementsForRoute(tierR, routeId).map((p) => tierRToComposed(p, routeMeters))
    : [];
  if (tierRList.length > 0) return tierRList;

  const handList = (handAuthored ?? []).map(furnitureToComposed);
  if (handList.length > 0) return handList;

  return synthetic ?? [];
};

/**
 * Fetch and parse `route-placements.json` at the given asset base URL.
 * A 404 or parse failure resolves to an empty registry so an engine
 * that boots without the file still runs — the composite just picks up
 * zero tier-r entries and falls through.
 *
 * Lives here rather than in `routePlacements.ts` so the pure-data
 * schema module stays `fetch`-free (useful in SSR and node-env tests).
 */
export const fetchRoutePlacementsRegistry = async (
  assetBase: string,
  options?: { fetch?: typeof fetch },
): Promise<RoutePlacementsRegistry> => {
  const doFetch = options?.fetch ?? fetch;
  const url = `${assetBase.replace(/\/$/, '')}/assets/scenery/route-placements.json`;
  try {
    const res = await doFetch(url);
    if (!res.ok) return emptyRegistry;
    const value = (await res.json()) as unknown;
    const { parseRoutePlacements } = await import('./routePlacements');
    return parseRoutePlacements(value);
  } catch {
    return emptyRegistry;
  }
};

const emptyRegistry: RoutePlacementsRegistry = {
  $schemaVersion: 2,
  placements: {},
};
