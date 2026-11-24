/**
 * #725 VP-07 FR7 — how far from the camera a kit model is drawn.
 *
 * Placement stations every few tens of metres (#725 FR1) put several
 * hundred kit instances on a route. Small ground detail (a flower patch,
 * a boulder cluster, a deadfall pile) is a few pixels past 250 m but costs
 * thousands of triangles each, so it is drawn only near the camera; kit
 * trees go to 400 m. Landforms, backdrops, course furniture and structures
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

/** Metres from the camera beyond which `id` is not drawn; 0 draws it at any distance. */
export const sceneryDrawDistanceFor = (id: string): number => {
  const tier = id[0];
  if (tier !== 'e' && tier !== 'f') return 0;
  // Scrub is understory, not a tree: low and dense, so it counts as detail.
  if (/^e\d\d-/.test(id) && !/reed|grass|litter|scrub/.test(id)) return TREE_DRAW_METRES;
  if (/scrub/.test(id)) return DETAIL_DRAW_METRES;
  return footprintRadiusFor(id, BUILT_IN_FOOTPRINT_LOOKUP) <= DETAIL_MAX_RADIUS_METRES ? DETAIL_DRAW_METRES : 0;
};

/** Shadow-casting distance of small ground detail, metres. */
export const DETAIL_SHADOW_METRES = 40;
/** Shadow-casting distance of kit trees, metres. */
export const TREE_SHADOW_METRES = 200;

/**
 * Metres from the camera beyond which `id` casts no shadow; 0 for no limit.
 * Each cascade redraws its casters, so detail that is a few pixels across
 * casts only near the boat, where its shadow can be seen.
 */
export const sceneryShadowDistanceFor = (id: string): number => {
  const draw = sceneryDrawDistanceFor(id);
  if (draw === DETAIL_DRAW_METRES) return DETAIL_SHADOW_METRES;
  if (draw === TREE_DRAW_METRES) return TREE_SHADOW_METRES;
  return 0;
};

/** Detail narrower than this casts no shadow at all, metres: its shadow is a smudge under it. */
export const NO_SHADOW_RADIUS_METRES = 1;

/** Whether `id` casts a shadow; tiny ground detail (flower patches, boulder clusters) does not. */
export const sceneryCastsShadowFor = (id: string): boolean =>
  !(sceneryDrawDistanceFor(id) === DETAIL_DRAW_METRES &&
    footprintRadiusFor(id, BUILT_IN_FOOTPRINT_LOOKUP) < NO_SHADOW_RADIUS_METRES);
