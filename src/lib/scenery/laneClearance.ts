/**
 * Keep-clear corridor around the racing line (#723 FR1).
 *
 * The lane buoys sit at ±`BUOY_LANE_HALF_WIDTH_METRES` from the
 * centreline (6.5 m today). Fleet lanes (VP-10) widen that to ±8 m.
 * No kit instance footprint may intersect the corridor — not a moored
 * boat, not a bank-foot rack, not a lily-pad raft — otherwise the
 * boat rows through a prop. Spans (bridges) and the lane buoys
 * themselves are the only exceptions and are opted in by `kind`.
 *
 * The corridor's inner half-width is kept slightly wider than the
 * fleet lane so a bob of 0.5 m on an in-water prop doesn't drift
 * across. 10.5 m = 8 m fleet + 2.5 m safety (empirical, picked to
 * cover the 2 m `SCENERY_WATER_MARGIN_METRES` the bank bands used
 * before this rule existed).
 */

import { BUOY_LANE_HALF_WIDTH_METRES } from './courseFurniture';

export const FLEET_LANE_HALF_WIDTH_METRES = BUOY_LANE_HALF_WIDTH_METRES + 1.5;
export const CORRIDOR_SAFETY_MARGIN_METRES = 4;
export const CORRIDOR_MIN_HALF_WIDTH_METRES = 10.5;

/** Keep-clear half-width (centreline → inner edge of placeable area), in metres. */
export const keepClearHalfWidth = (): number =>
  Math.max(
    CORRIDOR_MIN_HALF_WIDTH_METRES,
    FLEET_LANE_HALF_WIDTH_METRES + CORRIDOR_SAFETY_MARGIN_METRES,
  );
