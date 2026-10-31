/**
 * ChallengesService — read-only client for rownative's Speed Orders API (#415 Phase 1).
 *
 * The API is public, served from `rownative.icu/api/challenges`, and names
 * every challenge, its course and its leaderboard. VirtualRow lists them,
 * imports a challenge's course (through `RownativeService.importCourseById`,
 * the same join `courseId` already uses) and, in later phases, races a
 * leaderboard time as a ghost (#338 `paceGhost`).
 *
 * ## Why this is read-only (AC1.3)
 *
 * The Worker that validates a submission fetches the activity's GPS stream
 * and runs the course gates over it. An erg row has no GPS track, so an
 * indoor time submitted as a Speed Order would either be rejected or — worse
 * — be an indoor result landing on someone else's on-water leaderboard. The
 * `ChallengesPort` is a `Pick` of exactly the two reads this feature needs,
 * and `challengesService.test.ts` asserts the exported key set so adding a
 * `submit` is a deliberate change with a failing test attached.
 *
 * ## Why failures resolve to `[]` (AC1.5)
 *
 * Challenges are a feature of the app, not a precondition for rowing: if
 * `rownative.icu` is unreachable or returns garbage, the route panel still
 * works. Errors are swallowed into empty results rather than propagated, and
 * the caller renders "No challenges here yet" / "No results yet" the same
 * way it would for a genuinely empty list.
 *
 * The upstream call is lazy — nothing fetches until the Challenges view
 * mounts (AC6.2). Per-status in-memory caching (AC1.4) means switching tabs
 * three times makes one request.
 */

/** The three leaderboard windows rownative serves (`status` query param). */
export type ChallengeStatus = 'active' | 'upcoming' | 'past';

/**
 * One challenge in VirtualRow's shape — the raw API uses `distance_m` /
 * `rowStart` / `rawTimeS`, which we normalise once here so the UI never has
 * to care about rownative's wire names. Dates come back as ISO strings and
 * are converted on parse.
 */
export interface Challenge {
  id: string;
  name: string;
  courseId: string;
  courseName: string;
  distanceMeters: number;
  rowStart: Date;
  rowEnd: Date;
  submitEnd: Date;
  hasHandicap: boolean;
  organizerName: string | null;
  resultsCount: number;
  notes: string | null;
}

/** One leaderboard row. `null` fields reflect what the API itself may omit. */
export interface ChallengeResult {
  rank: number;
  displayName: string;
  rawTimeSeconds: number;
  correctedTimeSeconds: number | null;
  points: number | null;
  boatType: string | null;
  workoutDate: string | null;
  /** API values seen in the wild: `valid`, `manual_ok`, `pending`, `invalid`, `dq`. */
  validationStatus: string;
}

/**
 * Only a time somebody actually rowed, and that survived validation, is a
 * time to chase. `pending`, `invalid` and `dq` are hidden from the ghost
 * picker (AC4.2) — they still show on the leaderboard, but not as a target.
 */
export const isRaceable = (result: ChallengeResult): boolean =>
  result.validationStatus === 'valid' || result.validationStatus === 'manual_ok';

/**
 * A leaderboard time over a known distance is a pace. `#338` ghosts take
 * seconds-per-500 m, which is what `paceGhost(paceSPer500)` consumes.
 * Returns `null` when the challenge distance is zero (never seen in the
 * wild, but a `0` on the wire shouldn't `Infinity` the HUD).
 */
export const paceOf = (
  result: ChallengeResult,
  distanceMeters: number,
): number | null =>
  distanceMeters > 0 ? result.rawTimeSeconds / (distanceMeters / 500) : null;

/**
 * The rownative challenge host. A hard-coded constant: user input never
 * reaches `fetch` from this service. (The pasted-link allow-list in
 * `rownativeService` gates user URLs, which this doesn't take.)
 */
const CHALLENGES_API_BASE = 'https://rownative.icu/api';

/** The wire shape, kept narrow to only what the service reads. */
interface RawChallenge {
  id?: unknown;
  name?: unknown;
  courseId?: unknown;
  courseName?: unknown;
  distance_m?: unknown;
  rowStart?: unknown;
  rowEnd?: unknown;
  submitEnd?: unknown;
  hasHandicap?: unknown;
  organizerName?: unknown;
  resultsCount?: unknown;
  notes?: unknown;
}

interface RawResult {
  rank?: unknown;
  displayName?: unknown;
  rawTimeS?: unknown;
  correctedTimeS?: unknown;
  points?: unknown;
  boatType?: unknown;
  workoutDate?: unknown;
  validationStatus?: unknown;
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asDate = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Parse one wire row into a typed `Challenge`, or `null` if the row is
 * missing anything we treat as structural (id, course join, distance,
 * window). The three dates are required so FR2.3's status derivation can
 * compare against `Date.now()` without null-handling at every call site.
 */
const parseChallenge = (raw: RawChallenge): Challenge | null => {
  const id = asString(raw.id);
  const name = asString(raw.name);
  const courseId = asString(raw.courseId);
  const courseName = asString(raw.courseName);
  const distanceMeters = asNumber(raw.distance_m);
  const rowStart = asDate(raw.rowStart);
  const rowEnd = asDate(raw.rowEnd);
  const submitEnd = asDate(raw.submitEnd);
  if (!id || !name || !courseId || !courseName) return null;
  if (distanceMeters === null || distanceMeters <= 0) return null;
  if (!rowStart || !rowEnd || !submitEnd) return null;
  return {
    id,
    name,
    courseId,
    courseName,
    distanceMeters,
    rowStart,
    rowEnd,
    submitEnd,
    hasHandicap: raw.hasHandicap === true,
    organizerName: asString(raw.organizerName),
    resultsCount: asNumber(raw.resultsCount) ?? 0,
    notes: asString(raw.notes),
  };
};

const parseResult = (raw: RawResult): ChallengeResult | null => {
  const rank = asNumber(raw.rank);
  const displayName = asString(raw.displayName);
  const rawTimeSeconds = asNumber(raw.rawTimeS);
  const validationStatus = asString(raw.validationStatus);
  if (rank === null || !displayName || rawTimeSeconds === null || !validationStatus) return null;
  return {
    rank,
    displayName,
    rawTimeSeconds,
    correctedTimeSeconds: asNumber(raw.correctedTimeS),
    points: asNumber(raw.points),
    boatType: asString(raw.boatType),
    workoutDate: asString(raw.workoutDate),
    validationStatus,
  };
};

export class ChallengesService {
  private readonly fetchImpl: typeof fetch;
  private readonly listCache = new Map<ChallengeStatus, Promise<Challenge[]>>();
  private readonly resultsCache = new Map<string, Promise<ChallengeResult[]>>();

  constructor(
    // Same bound-arrow trick as RownativeService: a bare `fetch` reference
    // invoked with the service as its receiver throws "Illegal invocation"
    // in a browser.
    fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {
    this.fetchImpl = fetchImpl;
  }

  /** AC1.1 + AC1.4 — one in-flight promise per status, memoised for the session. */
  listChallenges(status: ChallengeStatus): Promise<Challenge[]> {
    const cached = this.listCache.get(status);
    if (cached) return cached;
    const promise = this.fetchChallenges(status).catch(() => [] as Challenge[]);
    this.listCache.set(status, promise);
    return promise;
  }

  /** AC1.2 + AC1.4 — one in-flight promise per challenge id. */
  challengeResults(id: string): Promise<ChallengeResult[]> {
    const cached = this.resultsCache.get(id);
    if (cached) return cached;
    const promise = this.fetchResults(id).catch(() => [] as ChallengeResult[]);
    this.resultsCache.set(id, promise);
    return promise;
  }

  private async fetchChallenges(status: ChallengeStatus): Promise<Challenge[]> {
    const response = await this.fetchImpl(`${CHALLENGES_API_BASE}/challenges?status=${status}`);
    if (!response.ok) return [];
    const payload = (await response.json()) as { challenges?: unknown };
    const raws = Array.isArray(payload?.challenges) ? (payload.challenges as RawChallenge[]) : [];
    return raws
      .map(parseChallenge)
      .filter((c): c is Challenge => c !== null);
  }

  private async fetchResults(id: string): Promise<ChallengeResult[]> {
    // The id is from a Challenge the service itself parsed off the API: it
    // never comes from the user directly, so no URL-encoding dance is
    // needed, but doing it anyway keeps a future caller from pasting a
    // course name here by accident.
    const response = await this.fetchImpl(
      `${CHALLENGES_API_BASE}/challenges/${encodeURIComponent(id)}/results`,
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as { results?: unknown };
    const raws = Array.isArray(payload?.results) ? (payload.results as RawResult[]) : [];
    return raws
      .map(parseResult)
      .filter((r): r is ChallengeResult => r !== null)
      .sort((a, b) => a.rank - b.rank);
  }
}

export const challengesService = new ChallengesService();
