/**
 * #737 VP-19 FR4 — blade clearance: how far the scull's blade tips sit
 * inside the nearer shoreline of the route's water, published every frame
 * on `__ROWER3D_CLEARANCE`. Negative means a blade is over the bank.
 */

import { OAR_REACH_METERS } from '../../../components/rower3d/navigableWidth';
import type { Rower3DClearance } from './telemetry';

/** Centreline to blade tip, rigged (the same number `navigableWidth` floors the channel with). */
export const OAR_REACH_METRES = OAR_REACH_METERS;

/**
 * Fold one frame's shore distance into the published reading. `null` (the
 * boat is not on the route ribbon, e.g. out on open lake water) leaves the
 * running minimum alone and clears `current`.
 */
export const recordClearance = (clearance: Rower3DClearance, shoreDistance: number | null): void => {
  if (shoreDistance === null) {
    clearance.current = null;
    return;
  }
  const c = shoreDistance - OAR_REACH_METRES;
  clearance.current = c;
  clearance.min = clearance.samples === 0 ? c : Math.min(clearance.min, c);
  clearance.samples += 1;
};
