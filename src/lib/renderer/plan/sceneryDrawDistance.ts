/**
 * #725 VP-07 FR7 — how far from the camera a kit model is drawn.
 *
 * Placement stations every few tens of metres (#725 FR1) put several
 * hundred kit instances on a route. Small ground detail (a flower patch,
 * a boulder cluster, a deadfall pile) is a few pixels past 250 m but costs
 * thousands of triangles each, so it is drawn only near the camera; kit
 * trees go to 400 m (shadows to 120 m). Landforms, backdrops, course furniture and structures
 * are never dropped for distance. The mesh pass fades a model out over the
 * last fifth of its distance (`sceneryMesh.wgsl`), so nothing pops.
 */

import { BUILT_IN_FOOTPRINT_LOOKUP, footprintRadiusFor } from '../../scenery/sceneryFootprints';

/** Draw distance of small ground detail, metres. */
export const DETAIL_DRAW_METRES = 250;
/** Draw distance of kit trees, metres. */
export const TREE_DRAW_METRES = 400;
/** Ground detail is a landscape (f*) or flora (e*) model no wider than this, metres. */
export const DETAIL_MAX_RADIUS_METRES = 2.5;

/**
 * #725 FR4 — the backdrop strips are drawn to where the ground has all but
 * dissolved into the sky (`GROUND_HAZE_END_M` is 1700 m).
 */
export const BACKDROP_DRAW_METRES = 1200;

/** Metres from the camera beyond which `id` is not drawn; 0 draws it at any distance. */
export const sceneryDrawDistanceFor = (id: string): number => {
  if (BACKDROP_STRIP_IDS.has(id)) return BACKDROP_DRAW_METRES;
  const tier = id[0];
  if (tier !== 'e' && tier !== 'f') return 0;
  // Scrub is understory, not a tree: low and dense, so it counts as detail.
  if (/^e\d\d-/.test(id) && !/reed|grass|litter|scrub/.test(id)) return TREE_DRAW_METRES;
  if (/scrub/.test(id)) return DETAIL_DRAW_METRES;
  return footprintRadiusFor(id, BUILT_IN_FOOTPRINT_LOOKUP) <= DETAIL_MAX_RADIUS_METRES ? DETAIL_DRAW_METRES : 0;
};

/** Detail narrower than this casts no shadow at all, metres: its shadow is a smudge under it. */
export const NO_SHADOW_RADIUS_METRES = 1;

/** Shadow-casting distance of small ground detail, metres. */
export const DETAIL_SHADOW_METRES = 40;
/** Shadow-casting distance of kit trees, metres. */
export const TREE_SHADOW_METRES = 120;

/**
 * Metres from the camera beyond which `id` casts no shadow; 0 for no limit.
 * Each cascade redraws its casters, so detail that is a few pixels across
 * casts only near the boat, where its shadow can be seen.
 */
export const sceneryShadowDistanceFor = (id: string): number => {
  const draw = sceneryDrawDistanceFor(id);
  if (draw === DETAIL_DRAW_METRES) return DETAIL_SHADOW_METRES;
  if (draw === TREE_DRAW_METRES) return TREE_SHADOW_METRES;
  // Slender course furniture (buoys, flagpoles, posts) is drawn at any
  // distance, but its shadow is a line a few pixels long past 40 m, and
  // every cascade redraws it (#725 FR7).
  if (footprintRadiusFor(id, BUILT_IN_FOOTPRINT_LOOKUP) < NO_SHADOW_RADIUS_METRES) return DETAIL_SHADOW_METRES;
  return 0;
};


/**
 * #725 FR4 — the far backdrop strips (treeline, ridge, skyline) stand a few
 * hundred metres out, past every shadow cascade worth drawing; each cascade
 * would otherwise redraw them all.
 */
export const BACKDROP_STRIP_IDS: ReadonlySet<string> = new Set([
  'f45-treeline-strip',
  'f46-hill-ridge-far',
  'f47-skyline-strip',
]);

/** Whether `id` casts a shadow; tiny ground detail (flower patches, boulder clusters) and backdrop strips do not. */
export const sceneryCastsShadowFor = (id: string): boolean =>
  !BACKDROP_STRIP_IDS.has(id) &&
  !(sceneryDrawDistanceFor(id) === DETAIL_DRAW_METRES &&
    footprintRadiusFor(id, BUILT_IN_FOOTPRINT_LOOKUP) < NO_SHADOW_RADIUS_METRES);
