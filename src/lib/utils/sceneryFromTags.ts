/**
 * The scenery an OSM land area stands for. Here rather than in
 * routeEnrichmentService so route detection can use it from its worker
 * (#493 FR18) without pulling in the service.
 *
 * #712 FR2 phase 1: the mapping now picks the richer biome profile family
 * (woodland / forest-high / village / town / small-city / scrub / parkland /
 * orchard) where the tags carry enough signal, and still returns the original
 * seven profiles everywhere else so cached v5 enrichments stay valid and
 * existing callers see a strict superset.
 */
import type { SceneryProfile } from '../services/routeEnrichmentService';

/** Parks and other open, grassed leisure ground read as `parkland`. #712 D1 kept. */
const PARKLAND = new Set(['park', 'garden', 'recreation_ground', 'golf_course', 'common']);
/** Treated as `parkland` land cover too. */
const PARKLAND_LANDUSE = new Set(['allotments', 'cemetery']);
/** Scrub / heath / rough grassland land covers → `scrub`. */
const SCRUB_NATURAL = new Set(['scrub', 'heath', 'grassland']);
const SCRUB_LANDUSE = new Set(['scrub', 'heath']);
/** Building values that carry a residential read, regardless of landuse. */
const RESIDENTIAL_BUILDINGS = new Set([
  'residential',
  'house',
  'apartments',
  'terrace',
  'detached',
  'semidetached_house',
  'bungalow',
  'dormitory',
]);
/**
 * Map a tag bag to a `SceneryProfile`. Priority order (highest first):
 *
 *   1. Natural / landuse forest and wood → `forest-high` if `leaf_type=needleleaved`,
 *      else `woodland`.
 *   2. Scrub / heath / rough grassland → `scrub`.
 *   3. Beach / sand → `beach`.
 *   4. Wetland → `wetland`.
 *   5. Settlement `place=` → `small-city`, `town` or `village`.
 *   6. Residential landuse / residential-flavoured building → `residential`.
 *   7. Commercial / industrial landuse → `commercial`.
 *   8. Parkland leisure or landuse (allotments / cemetery) → `parkland`.
 *   9. Farmland / grass / meadow → `farmland`.
 *  10. Orchard / vineyard → `orchard`.
 *  11. Any `building=*` tag → `commercial` (unchanged default).
 *  12. Everything else → `fallback`.
 *
 * This order is deliberate: a residential suburb often carries a nearby park,
 * but the segment should read as residential; a village in a forest should
 * still read as a village; and a landmark `building=church` still falls to
 * `commercial` rather than `village`, because a lone church along a river
 * bank isn't a village on its own.
 */
export const mapOsmTagsToSceneryProfile = (
  tags: Record<string, string> = {},
): SceneryProfile => {
  if (tags.landuse === 'forest' || tags.natural === 'wood') {
    return tags.leaf_type === 'needleleaved' ? 'forest-high' : 'woodland';
  }
  if (SCRUB_NATURAL.has(tags.natural ?? '') || SCRUB_LANDUSE.has(tags.landuse ?? '')) {
    return 'scrub';
  }
  if (tags.natural === 'beach' || tags.natural === 'sand') return 'beach';
  if (tags.natural === 'wetland') return 'wetland';

  if (tags.place === 'city') return 'small-city';
  if (tags.place === 'town' || tags.place === 'suburb') return 'town';
  if (tags.place === 'village' || tags.place === 'hamlet') return 'village';

  if (
    tags.landuse === 'residential' ||
    RESIDENTIAL_BUILDINGS.has(tags.building ?? '')
  ) {
    return 'residential';
  }

  if (tags.landuse === 'commercial' || tags.landuse === 'industrial') {
    return 'commercial';
  }

  if (PARKLAND.has(tags.leisure ?? '') || PARKLAND_LANDUSE.has(tags.landuse ?? '')) {
    return 'parkland';
  }

  if (tags.landuse === 'orchard' || tags.landuse === 'vineyard') return 'orchard';

  if (
    tags.landuse === 'farmland' ||
    tags.landuse === 'grass' ||
    tags.landuse === 'meadow'
  ) {
    return 'farmland';
  }

  if (tags.building) return 'commercial';

  return 'fallback';
};
