/**
 * Would-have-placed line for a row against a challenge (#415 Phase 4 /
 * FR5 / AC5.1–AC5.4).
 *
 * The row is NEVER submitted (indoor rows have no GPS trace to validate),
 * so the summary states the comparison — "Your 4:37 would have been 3rd
 * of 12 on this leaderboard" — rather than a placing (AC5.2).
 *
 * A row short of the course distance is not comparable: half the course
 * in half the time is not a rank (AC5.3). The function returns `null`
 * where the comparison would be dishonest, and the summary then renders
 * nothing (AC5.4 covers that path too — no challenge in flight, no line).
 */
import { isRaceable, type ChallengeResult } from '../services/challengesService';

export interface ChallengeStanding {
  /** 1-based rank the row would have taken in the raceable field. */
  rank: number;
  /** Total number of raceable rows the comparison was taken against. */
  total: number;
  /** The row's time, formatted "m:ss". */
  rowTimeLabel: string;
  /** The challenge's name, for the summary copy. */
  challengeName: string;
}

/** Format "m:ss" (floor to whole seconds, same unit the leaderboard shows). */
function formatMinutesSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Compare one row to a challenge leaderboard. Pass only raceable results —
 * the function filters again defensively, but callers that already pulled
 * `isRaceable` out keep the test seam clean.
 */
export function computeChallengeStanding(args: {
  challengeName: string;
  courseDistanceMeters: number;
  rowDistanceMeters: number;
  rowDurationSeconds: number;
  results: ChallengeResult[];
  /** AC5.3 tolerance: how much short of the course distance counts as "the course". */
  shortRowToleranceMeters?: number;
}): ChallengeStanding | null {
  const {
    challengeName,
    courseDistanceMeters,
    rowDistanceMeters,
    rowDurationSeconds,
    results,
    shortRowToleranceMeters = 25,
  } = args;

  if (courseDistanceMeters <= 0) return null;
  if (rowDurationSeconds <= 0) return null;
  // AC5.3 — a row short of the course distance is not comparable. The 25m
  // slack covers a row where the finish gate was crossed by a stroke but
  // the FIT distance landed a metre or two short.
  if (rowDistanceMeters + shortRowToleranceMeters < courseDistanceMeters) return null;

  const raceable = results
    .filter(isRaceable)
    .map((r) => r.rawTimeSeconds)
    .sort((a, b) => a - b);
  if (raceable.length === 0) return null;

  // 1-based count of raceable times at or below this row's time, then +1
  // for the row itself: a row that beats everyone is rank 1 of N+1.
  let faster = 0;
  for (const t of raceable) {
    if (t < rowDurationSeconds) faster += 1;
    else break;
  }
  return {
    rank: faster + 1,
    total: raceable.length,
    rowTimeLabel: formatMinutesSeconds(rowDurationSeconds),
    challengeName,
  };
}

/**
 * Render the standing line (AC5.2 — a comparison, not a placing).
 */
export function challengeStandingLine(standing: ChallengeStanding): string {
  const of = standing.total;
  const total = of + 1; // The row itself joins the field for the comparison.
  const ordinal = formatOrdinal(standing.rank);
  return `Your ${standing.rowTimeLabel} would have been ${ordinal} of ${total} on ${standing.challengeName}`;
}

function formatOrdinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}
