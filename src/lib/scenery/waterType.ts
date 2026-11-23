/**
 * #755 VP-31 FR1/FR2 — what kind of water a route is on, and how wide to
 * draw it, without waiting for map data.
 *
 * The scene used to read the water type only from the OSM enrichment, which
 * usually has not arrived (or never will, for a guest or the demo), so every
 * lake, reservoir, canal and sea course was drawn as the same 20 m channel.
 * The route already says what it is: the enrichment when it has a real
 * answer, else a curated or imported tag, else the course name
 * (`waterBodyFromName`, #413). No network is involved.
 */

import type { RouteEnrichmentData, WaterBodyType } from '../services/routeEnrichmentService';
import { waterBodyFromName } from '../utils/waterBodyFromName';
import { DEFAULT_WATER_WIDTH_METERS } from './waterHalfWidth';

export type WaterTypeSource = 'enrichment' | 'tag' | 'name' | 'default';

export interface ResolvedWaterType {
  waterType: WaterBodyType;
  typeSource: WaterTypeSource;
}

/**
 * Tag precedence when a route carries more than one water tag. Same order
 * the enrichment fallback has always used (#413 AC5.2), so the two agree.
 */
const TAG_ORDER: readonly WaterBodyType[] = ['canal', 'stream', 'lake', 'reservoir', 'river', 'open_water'];

/** The water type a route's tags name, or `null` when they name none. */
export const waterTypeFromTags = (tags: readonly string[] | undefined): WaterBodyType | null =>
  TAG_ORDER.find((type) => tags?.includes(type)) ?? null;

/** FR1 — enrichment (when it knows), else tag, else name, else unknown. */
export const resolveWaterType = (
  route: { name?: string; tags?: readonly string[] },
  enrichment?: Pick<RouteEnrichmentData, 'waterBodyType'> | null,
): ResolvedWaterType => {
  if (enrichment && enrichment.waterBodyType !== 'unknown') {
    return { waterType: enrichment.waterBodyType, typeSource: 'enrichment' };
  }
  const tagged = waterTypeFromTags(route.tags);
  if (tagged) return { waterType: tagged, typeSource: 'tag' };
  const named = waterBodyFromName(route.name ?? '');
  if (named !== 'unknown') return { waterType: named, typeSource: 'name' };
  return { waterType: 'unknown', typeSource: 'default' };
};

/**
 * FR3 — still and open water is drawn open: the shore stands at least this
 * far from the course line on each side, with the banks, trees, reeds,
 * buildings and bank-edge kit out at it. Course furniture stays on the line.
 */
export const LAKE_OPEN_WATER_HALF_WIDTH_METERS = 300;
export const SEA_OPEN_WATER_HALF_WIDTH_METERS = 600;

/**
 * FR2 — the full water width drawn for a type when no map data measured
 * one. Rivers, canals and streams are channels (55 / 15 / 7 m); lakes,
 * reservoirs and the sea are open water; unknown keeps today's channel.
 */
export const waterWidthForType = (waterType: WaterBodyType): number => {
  switch (waterType) {
    case 'river':
      return 55;
    case 'canal':
      return 15;
    case 'stream':
      return 7;
    case 'lake':
    case 'reservoir':
      return 2 * LAKE_OPEN_WATER_HALF_WIDTH_METERS;
    case 'open_water':
      return 2 * SEA_OPEN_WATER_HALF_WIDTH_METERS;
    default:
      return DEFAULT_WATER_WIDTH_METERS;
  }
};

/**
 * FR4 — a route tagged `coastal` (sea courses, #756) has land on one side
 * only. Nothing offline says which side the coast is on, so the land is
 * put on the rower's left (port, looking down the course) and the sea on
 * the right, where the water runs out past the ground's haze
 * (`GROUND_HAZE_END_M`, 1.7 km) so it meets the sky at the horizon.
 */
export const COASTAL_TAG = 'coastal';
export const COASTAL_LAND_SIDE: 'left' | 'right' = 'left';
export const COASTAL_SEA_HALF_WIDTH_METERS = 2000;
