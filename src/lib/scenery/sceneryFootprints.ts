/**
 * Footprint-radius lookups for the scenery kit (#723 FR3).
 *
 * `scripts/generate-scenery-manifest.mjs` writes an XZ `footprint` on
 * every GLB entry in `manifest.json` (`{extentX, extentZ, radius,
 * centreX, centreZ, min/max X/Z}`, all in scene metres). At runtime
 * the ride scene loads the manifest once and builds a `FootprintLookup`
 * that the placement maths pass to its keep-clear maths, so a 22 m
 * boathouse can't sit 0.8 m from the centreline any more.
 *
 * `fallbackRadiusFor` keeps the older code paths safe when a model's
 * footprint hasn't landed in the manifest yet (e.g. a hand-authored
 * route extra whose GLB is new, or a test that stubs the manifest).
 * The table is deliberately conservative — favoring over-margin over
 * a prop drifting into the lane — and matches the kit's rough tier
 * sizes.
 */

import type { SceneryModelFootprint, SceneryManifest } from '../utils/sceneryManifest';
import { SCENERY_FOOTPRINTS } from './sceneryFootprints.generated';

export type FootprintLookup = (modelId: string) => SceneryModelFootprint | null;

/** The generated footprint map, available synchronously at import time. */
export const BUILT_IN_FOOTPRINT_LOOKUP: FootprintLookup = (modelId: string) =>
  SCENERY_FOOTPRINTS[modelId] ?? null;

/** Category-level fallback radius in scene metres when the manifest has none. */
export const FALLBACK_RADIUS_BY_PREFIX: Record<string, number> = {
  a: 2, // tier-a course furniture: buoys, pontoons, posts, small gazebo-ish items
  b: 12, // tier-b structures: boathouses, boat racks, clubhouses
  c: 15, // tier-c bridges: spans are centreline, but foot radius is for land props
  d: 10, // tier-d civic buildings
  e: 3, // tier-e vegetation + small props
  f: 3, // tier-f surface/in-water: moored boats, lily pads, foam lines
  l: 15, // tier-l landmarks: liveried bridges and towers
  r: 4, // tier-r llm-cad per-route props
  default: 6,
};

/** Tier-letter prefix from a model id like `b02-boathouse-uk-victorian` → `b`. */
export const tierPrefixOf = (modelId: string): string => {
  const match = /^([a-z])\d/.exec(modelId);
  return match ? match[1] : 'default';
};

export const fallbackRadiusFor = (modelId: string): number =>
  FALLBACK_RADIUS_BY_PREFIX[tierPrefixOf(modelId)] ?? FALLBACK_RADIUS_BY_PREFIX.default;

/**
 * Model's footprint radius in scene metres, using the manifest first
 * and the per-tier fallback otherwise. Never returns 0.
 */
export const footprintRadiusFor = (modelId: string, lookup: FootprintLookup | null | undefined): number => {
  const fp = lookup?.(modelId) ?? null;
  const r = fp?.radius;
  return Number.isFinite(r) && (r as number) > 0 ? (r as number) : fallbackRadiusFor(modelId);
};

export const footprintLookupFromManifest = (
  manifest: SceneryManifest | null | undefined,
): FootprintLookup => {
  const models = manifest?.models ?? {};
  return (modelId: string): SceneryModelFootprint | null => models[modelId]?.footprint ?? null;
};

/** The no-op lookup. Callers fall back to `fallbackRadiusFor`. */
export const NO_FOOTPRINT_LOOKUP: FootprintLookup = () => null;
