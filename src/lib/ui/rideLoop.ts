/**
 * Ride-loop state (#647) — a rower is no longer bounded by route length. When
 * looping is on, the boat continues from the start when it reaches the finish,
 * and the row ends on the rower's chosen target (distance / time / free) rather
 * than on route length.
 *
 * The policy is held on the ride-session store and read by the finish detector
 * (`rideSession.svelte.ts#maybeFinish`) and by the engine (`RideFrame.loop`,
 * `characterPlacement.ts`). Challenge rows force this off: a leaderboard is
 * defined on the route's own distance.
 */

export type RideLoopTargetKind = 'route' | 'distance' | 'time' | 'free';

export interface RideLoopTarget {
  kind: RideLoopTargetKind;
  /** Metres for `distance`, seconds for `time`. Ignored for `route` / `free`. */
  value?: number;
}

export interface RideLoop {
  enabled: boolean;
  target: RideLoopTarget;
}

/** The row ends at the route's own finish line — today's behaviour. */
export const defaultRideLoop = (): RideLoop => ({
  enabled: false,
  target: { kind: 'route' },
});

/** Clamp a user-entered distance to a sane range (0.5 km … 100 km). */
export const clampTargetDistanceMeters = (meters: number): number =>
  Math.max(500, Math.min(100_000, Math.round(meters)));

/** Clamp a user-entered time to a sane range (1 min … 6 h). */
export const clampTargetTimeSeconds = (seconds: number): number =>
  Math.max(60, Math.min(21_600, Math.round(seconds)));

/**
 * The metres at which the row should finish, given the current loop state and
 * the route length. `null` means "no distance-based finish" (free row).
 */
export const finishDistanceMeters = (
  loop: RideLoop,
  routeDistanceMeters: number,
): number | null => {
  if (!loop.enabled) return routeDistanceMeters > 0 ? routeDistanceMeters : null;
  switch (loop.target.kind) {
    case 'route':
      return routeDistanceMeters > 0 ? routeDistanceMeters : null;
    case 'distance':
      return typeof loop.target.value === 'number' && loop.target.value > 0
        ? loop.target.value
        : null;
    case 'time':
    case 'free':
      return null;
  }
};

/**
 * The seconds at which the row should finish, given the current loop state.
 * `null` means "no time-based finish".
 */
export const finishTimeSeconds = (loop: RideLoop): number | null => {
  if (!loop.enabled) return null;
  if (loop.target.kind !== 'time') return null;
  return typeof loop.target.value === 'number' && loop.target.value > 0
    ? loop.target.value
    : null;
};

/**
 * Lap count derived from cumulative metres and route length. 0 before the first
 * seam is crossed. A row that stops mid-lap keeps the lap partial.
 */
export const lapsCompleted = (
  distanceMeters: number,
  routeDistanceMeters: number,
): number => {
  if (!(routeDistanceMeters > 0) || !(distanceMeters > 0)) return 0;
  return Math.floor(distanceMeters / routeDistanceMeters);
};

/** The current lap, 1-indexed, suitable for a HUD "Lap N" readout. */
export const currentLap = (
  distanceMeters: number,
  routeDistanceMeters: number,
): number => lapsCompleted(distanceMeters, routeDistanceMeters) + 1;

/**
 * Progress along a single traversal of the route, in [0, 1), wrapping across
 * the seam. Returns 0 when there is no route length to divide by.
 */
export const progressAlongRoute = (
  distanceMeters: number,
  routeDistanceMeters: number,
): number => {
  if (!(routeDistanceMeters > 0)) return 0;
  const t = distanceMeters / routeDistanceMeters;
  const wrapped = t - Math.floor(t);
  return wrapped < 0 ? wrapped + 1 : wrapped;
};
