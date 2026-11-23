import type { ActivitySample, WorkoutSession } from '../../lib/types/index';

/**
 * The boat you are chasing (#338).
 *
 * There is one boat on the water and nothing to row against. A ghost is a
 * second boat whose distance is a pure function of elapsed time - either a
 * constant pace, or the distances a previous row actually recorded - so the
 * scene only has to place it, and the HUD only has to subtract.
 */

export interface PaceGhost {
  kind: 'pace';
  /** Seconds per 500 m. */
  paceSPer500: number;
}

export interface RecordedGhost {
  kind: 'recorded';
  /**
   * Distance at each recorded second, cumulative and never decreasing.
   * Cleaned on construction: a recorded row can stall, and the monitor keeps
   * sampling while the rower rests.
   */
  samples: ActivitySample[];
}

export type GhostSource = PaceGhost | RecordedGhost;

export const paceGhost = (paceSPer500: number): PaceGhost => ({ kind: 'pace', paceSPer500 });

/**
 * A ghost from a row that was actually rowed.
 *
 * The samples are made monotonic here rather than at every read: a ghost that
 * went backwards would be a boat rowing backwards, and a recording can dip
 * where the monitor re-reported a distance.
 */
export const recordedGhost = (samples: ActivitySample[]): RecordedGhost => {
  let furthest = -Infinity;
  return {
    kind: 'recorded',
    samples: samples.map((sample) => {
      furthest = Math.max(furthest, sample.distance);
      return { ...sample, distance: furthest };
    }),
  };
};

/** Metres per second a pace boat travels. Zero for a pace of nothing. */
const speedOf = (ghost: PaceGhost): number =>
  ghost.paceSPer500 > 0 ? 500 / ghost.paceSPer500 : 0;

/**
 * The index of the last sample at or before `seconds`.
 *
 * Binary search on `t`, not on the sample number: a pause leaves a gap in the
 * stream (see `ActivitySample`), so the tenth sample is not necessarily ten
 * seconds in, and a ghost indexed by second would jump wherever the row it
 * came from was paused.
 */
const lastSampleAt = (samples: ActivitySample[], seconds: number): number => {
  let low = 0;
  let high = samples.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (samples[mid].t <= seconds) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
};

/** Metres the ghost has covered at `elapsedSeconds`. */
export const ghostDistanceAt = (ghost: GhostSource, elapsedSeconds: number): number => {
  if (elapsedSeconds <= 0) return 0;
  if (ghost.kind === 'pace') return speedOf(ghost) * elapsedSeconds;

  const { samples } = ghost;
  if (samples.length === 0) return 0;

  const index = lastSampleAt(samples, elapsedSeconds);
  // Before the recording starts, the ghost is on the start line.
  if (index < 0) return 0;

  const a = samples[index];
  const b = samples[index + 1];
  // Past the last sample the ghost has finished; it does not keep rowing up
  // the bank while the rower still on the water catches up.
  if (!b) return a.distance;

  const span = b.t - a.t;
  if (span <= 0) return b.distance;
  return a.distance + ((b.distance - a.distance) * (elapsedSeconds - a.t)) / span;
};

/** #728 FR1: the rate, in spm, a boat holding 2:00/500 m rows at. */
const CADENCE_AT_2MIN = 24;
/** spm gained per second of pace faster than 2:00/500 m. */
const CADENCE_PER_PACE_SECOND = 4 / 15;
const MIN_GHOST_CADENCE = 18;
const MAX_GHOST_CADENCE = 36;

/**
 * #728 VP-10 FR1 — a stroke rate for a pace, for a ghost with no logged
 * cadence: 24 spm at 2:00/500 m, 4 spm more per 15 s faster, held to the
 * 18–36 spm a sculler actually rows. Zero for no pace.
 */
export const cadenceForPace = (paceSPer500: number): number => {
  if (!(paceSPer500 > 0) || !Number.isFinite(paceSPer500)) return 0;
  const spm = CADENCE_AT_2MIN + (120 - paceSPer500) * CADENCE_PER_PACE_SECOND;
  return Math.max(MIN_GHOST_CADENCE, Math.min(MAX_GHOST_CADENCE, spm));
};

/**
 * #728 VP-10 FR1 — whether the ghost is rowing at `elapsedSeconds`, and at
 * what rate. A pace boat rows once the clock runs. A recorded boat rows
 * at the cadence its row logged (or, without one, at the rate its pace
 * implies), and sits still where that row was paused or after it ended.
 */
export const ghostStroke = (
  ghost: GhostSource,
  elapsedSeconds: number,
): { rowing: boolean; cadence: number } => {
  if (elapsedSeconds <= 0) return { rowing: false, cadence: 0 };
  if (ghost.kind === 'pace') {
    const cadence = cadenceForPace(ghost.paceSPer500);
    return { rowing: cadence > 0, cadence };
  }
  const { samples } = ghost;
  const index = lastSampleAt(samples, elapsedSeconds);
  const a = samples[index];
  const b = samples[index + 1];
  if (!a || !b || b.t <= a.t || b.distance <= a.distance) return { rowing: false, cadence: 0 };
  const logged = a.cadence;
  if (logged !== undefined && Number.isFinite(logged) && logged > 0) return { rowing: true, cadence: logged };
  const cadence = cadenceForPace((500 * (b.t - a.t)) / (b.distance - a.distance));
  return { rowing: cadence > 0, cadence };
};

/** Metres the rower is ahead of the ghost. Negative means the ghost leads. */
export const gapMeters = (rowerMeters: number, ghostMeters: number): number =>
  rowerMeters - ghostMeters;

/**
 * When the ghost reaches `meters`, or null if its row never got there.
 *
 * Null is the honest answer for a best over 2 km held up against a 5 km route:
 * there is no time at which that row crossed this line, and inventing one by
 * extrapolating its final pace would be a comparison with a row nobody rowed.
 */
export const ghostFinishSeconds = (ghost: GhostSource, meters: number): number | null => {
  if (ghost.kind === 'pace') {
    const speed = speedOf(ghost);
    return speed > 0 ? meters / speed : null;
  }

  const { samples } = ghost;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i].distance < meters) continue;
    const a = samples[i - 1];
    if (!a) return samples[i].t;
    const span = samples[i].distance - a.distance;
    if (span <= 0) return samples[i].t;
    return a.t + ((meters - a.distance) * (samples[i].t - a.t)) / span;
  }
  return null;
};

/**
 * How far to port the ghost rows, in metres.
 *
 * Two boats on one line is one boat with z-fighting. Far enough apart to read
 * as two crews, close enough that the gap between them is the thing you watch.
 *
 * #728 VP-10 FR3: a sculling blade tip is ~2.9 m off the centreline, so at
 * the old 2.5 m the ghost's hull ran through the player's port oar. 7 m
 * leaves 1.2 m between the two boats' blade tips. The fleet uses the same
 * pitch for its lanes.
 */
export const GHOST_LANE_OFFSET_M = 7;

/**
 * The world offset that puts a boat `metres` to port of the centreline.
 *
 * `getRoutePositionAtProgress` aligns the boat's local +Z with the route
 * tangent, so local +X - starboard - is the tangent turned a quarter turn:
 * (tz, -tx). Port is its negative. The tangent is normalised here rather than
 * assumed, because an unnormalised one would stretch the offset and walk the
 * ghost into the bank through a bend.
 */
export const lateralOffset = (
  tangentX: number,
  tangentZ: number,
  metres: number,
): { x: number; z: number } => {
  const length = Math.hypot(tangentX, tangentZ);
  if (length === 0) return { x: 0, z: 0 };
  return { x: (-tangentZ / length) * metres, z: (tangentX / length) * metres };
};

/**
 * The gap as the HUD says it: `+12 m`, `−4 m`, or `level`.
 *
 * A real minus rather than a hyphen, because at HUD size beside a number a
 * hyphen reads as punctuation and this is the one reading whose sign is the
 * whole message. Inside a metre it is `level`: a gap computed to the
 * centimetre flickers between `+0 m` and `−0 m` on every stroke, which reads
 * as the lead changing hands when nothing has changed at all.
 */
export const formatGap = (meters: number | null): string => {
  if (meters === null) return '';
  // Measured before rounding: -0.9 m rounds to a metre, and a boat that is
  // nine tenths of a length down has not lost a length.
  if (Math.abs(meters) < 1) return 'level';
  return `${meters > 0 ? '+' : '−'}${Math.round(Math.abs(meters))} m`;
};

/**
 * The row to race on this route: the quickest one this browser kept.
 *
 * A ghost needs a route rowed, not just a time. Sessions have been stored
 * since long before the 1 Hz sample stream, so a row with the best average
 * pace and no samples would put a boat on the start line and leave it there;
 * those are passed over for the quickest row that can actually be rowed again.
 */
export const bestRowOnRoute = (
  history: WorkoutSession[],
  routeId: string,
  excludeId?: string,
): WorkoutSession | null => {
  const candidates = history.filter(
    (session) =>
      session.routeId === routeId &&
      session.id !== excludeId &&
      !session.isActive &&
      !session.isGuest &&
      Number.isFinite(session.averagePace) &&
      session.averagePace > 0 &&
      (session.samples?.length ?? 0) > 1,
  );

  return candidates.reduce<WorkoutSession | null>(
    (best, session) => (best === null || session.averagePace < best.averagePace ? session : best),
    null,
  );
};

/** A disagreement bigger than this is a pause or a reset, not a missing packet. */
const CLOCK_SNAP_SECONDS = 1;

/** The most frame time one frame may contribute, however long it actually was. */
const MAX_FRAME_SECONDS = 0.25;

/**
 * The ghost's clock, one frame on.
 *
 * The erg reports elapsed time when a BLE packet arrives, roughly once a
 * second, and a ghost placed straight from that steps down the course a length
 * at a time. Between packets it runs on the frame clock; the erg's reading is
 * what corrects it, and a disagreement larger than a packet - a pause, a reset,
 * a row starting over - is taken at once rather than eased into.
 *
 * The frame contribution is capped because this project has measured frames
 * over half a second more than once (#295), and a ghost should not cross the
 * finish because the tab was in the background.
 */
export const followClock = (
  local: number,
  reported: number,
  deltaSeconds: number,
  playing: boolean,
): number => {
  if (!playing) return reported;
  // The erg is ahead of us: its clock is the truth, so take it.
  if (reported > local) return reported;
  // Further behind than a packet is a pause, a reset or a row starting over.
  if (local - reported > CLOCK_SNAP_SECONDS) return reported;
  // Otherwise fill the gap - but never run more than one packet ahead. Left
  // uncapped, the local clock climbs past the window and is snapped back, and
  // the ghost rocks back and forth by a second's distance every second.
  return Math.min(
    local + Math.min(deltaSeconds, MAX_FRAME_SECONDS),
    reported + CLOCK_SNAP_SECONDS,
  );
};
