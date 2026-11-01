/**
 * #496 FR3 / AC5 — per-segment grass density, derived from each segment's
 * biome profile. Lives beside the other pure plan modules under
 * `src/lib/renderer/plan/` so the renderer can consume it without pulling
 * `src/components/*` or `three` into its import graph.
 *
 * The density of a route segment is read from `SCENERY_PROFILES[profile].
 * groundCover.density`, the biome mapping the per-biome density atlas
 * already paints from (`src/lib/scenery/biomeDensity.ts`). Keeping the
 * mapping in one function means a future per-segment grass pass (or the
 * current `dominantProfile` fallback) draws from the same table.
 */

import { SCENERY_PROFILES } from '../../../components/rower3d/sceneryConfig';
import type {
  RouteEnrichmentData,
  RouteSegmentEnrichment,
  SceneryProfile,
} from '../../services/routeEnrichmentService';

export const DEFAULT_GRASS_PROFILE: SceneryProfile = 'fallback';

/**
 * The 0..1 grass density for a single biome, from `SCENERY_PROFILES`. A
 * profile that falls outside the table (shouldn't happen, kept for
 * robustness) reads as the fallback's density.
 */
export const grassDensityForProfile = (profile: SceneryProfile): number => {
  const entry = SCENERY_PROFILES[profile] ?? SCENERY_PROFILES[DEFAULT_GRASS_PROFILE];
  return entry.groundCover.density;
};

/** Per-segment density for every segment in the enrichment, in order. */
export const grassDensityPerSegment = (
  segments: ReadonlyArray<RouteSegmentEnrichment>,
): number[] =>
  segments.map((segment) =>
    // D19: a bank's own profile wins when the detection carried one; the
    // segment's dominant profile is the fallback. Grass is a bank-scoped
    // signal — pick whichever side's density is higher so the drawn colour
    // reads as the greener of the two banks.
    Math.max(
      grassDensityForProfile(segment.leftSceneryProfile ?? segment.sceneryProfile),
      grassDensityForProfile(segment.rightSceneryProfile ?? segment.sceneryProfile),
    ),
  );

/**
 * `densityForProgress(progress)` — linearly interpolated density across
 * segments, matching the shape of `getWaterEdgesSceneUnitsForProgress` so
 * the renderer can swap one in for the other without rewiring. Falls back
 * to the fallback-biome density when no enrichment is supplied.
 */
export const createGrassDensityForProgress = (
  enrichment: RouteEnrichmentData | null | undefined,
): ((progress: number) => number) => {
  const segments = enrichment?.segmentProfiles ?? [];
  const densities = grassDensityPerSegment(segments);
  if (densities.length === 0) {
    const fallback = grassDensityForProfile(DEFAULT_GRASS_PROFILE);
    return () => fallback;
  }
  return (progress) => {
    const clamped = Math.max(0, Math.min(1, progress));
    const lastIndex = densities.length - 1;
    const scaled = clamped * lastIndex;
    const lower = densities[Math.floor(scaled)];
    const upper = densities[Math.min(lastIndex, Math.floor(scaled) + 1)];
    const blend = scaled - Math.floor(scaled);
    return lower + (upper - lower) * blend;
  };
};

/**
 * The route's dominant grass biome: the segment whose density is highest
 * wins (so a river that passes through forest reads as forest-green near
 * the lushest stretch). Used as the one-tile `grassProfile` the bank pass
 * paints today, until a per-segment pass lands.
 */
export const dominantGrassProfile = (
  enrichment: RouteEnrichmentData | null | undefined,
): SceneryProfile => {
  const segments = enrichment?.segmentProfiles ?? [];
  if (segments.length === 0) return DEFAULT_GRASS_PROFILE;
  let bestProfile: SceneryProfile = DEFAULT_GRASS_PROFILE;
  let bestDensity = -Infinity;
  for (const segment of segments) {
    const left = segment.leftSceneryProfile ?? segment.sceneryProfile;
    const right = segment.rightSceneryProfile ?? segment.sceneryProfile;
    const dLeft = grassDensityForProfile(left);
    const dRight = grassDensityForProfile(right);
    if (dLeft > bestDensity) {
      bestDensity = dLeft;
      bestProfile = left;
    }
    if (dRight > bestDensity) {
      bestDensity = dRight;
      bestProfile = right;
    }
  }
  return bestProfile;
};
