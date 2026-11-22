/**
 * The single source of truth for how wide the water is at a given
 * progress along the route (#723 FR4). Before this landed, three
 * copies of the same linear-interpolation lived in
 * `sceneryPlacement.ts`, `sceneryStructures.ts` and the strip-geometry
 * code, each with its own fallback. The strip, bank, kit placement and
 * course furniture must agree, or the drawn water and the placement
 * maths disagree and a prop sits in the lane.
 *
 * Returns the half-width (centreline → bank, in scene metres) on the
 * named side. Falls back to half of `enrichment.waterWidthMeters` or
 * `DEFAULT_WATER_WIDTH_METERS / 2` when the segment profiles are
 * absent or carry zero for the side.
 */

import type { RouteEnrichmentData } from '../services/routeEnrichmentService';

export const DEFAULT_WATER_WIDTH_METERS = 20;

export const waterHalfWidthAt = (
  enrichment: RouteEnrichmentData | null | undefined,
  progress: number,
  side: 'left' | 'right',
): number => {
  const profiles = enrichment?.segmentProfiles;
  if (!profiles || profiles.length === 0) {
    return (enrichment?.waterWidthMeters ?? DEFAULT_WATER_WIDTH_METERS) / 2;
  }
  const clamped = Math.max(0, Math.min(1, progress));
  const lastIndex = profiles.length - 1;
  const scaled = clamped * lastIndex;
  const lower = profiles[Math.floor(scaled)];
  const upper = profiles[Math.min(lastIndex, Math.floor(scaled) + 1)];
  const blend = scaled - Math.floor(scaled);
  const lo = (side === 'left' ? lower.leftShoreMeters : lower.rightShoreMeters) ?? 0;
  const hi = (side === 'left' ? upper.leftShoreMeters : upper.rightShoreMeters) ?? 0;
  const meters = lo + (hi - lo) * blend;
  return Number.isFinite(meters) && meters > 0 ? meters : DEFAULT_WATER_WIDTH_METERS / 2;
};
