/**
 * Progressive scenery streaming plan.
 *
 * The engine used to fetch every scenery GLB up-front at attach — a burst that
 * can earn a 503 from a static host and blocks the first frame. Instead, each
 * model is loaded only as the boat nears the first of its instances along the
 * route, and more stream in as the row progresses (mirroring the React scene's
 * chunked `readyCount` loading). This module is the pure, GPU-free planning:
 * work out how far along the route each model first appears, then, given the
 * boat's distance and a look-ahead window, decide which models to load next.
 */

export interface CurveDistanceSample {
  /** A point on the route curve in world space. */
  position: readonly [number, number, number];
  /** Distance along the route to this sample, in metres. */
  distanceMeters: number;
}

export interface SceneryStreamGroup {
  id: string;
  instancePositions: readonly (readonly [number, number, number])[];
}

export interface SceneryStreamEntry {
  id: string;
  /** Route distance (m) at which this model's nearest instance sits. */
  triggerDistanceMeters: number;
}

/** Horizontal (x,z) distance-along-route of the sample nearest `pos`. */
const nearestDistanceMeters = (
  pos: readonly [number, number, number],
  samples: readonly CurveDistanceSample[],
): number => {
  if (samples.length === 0) return 0;
  let best = Infinity;
  let bestDist = 0;
  for (const s of samples) {
    const dx = s.position[0] - pos[0];
    const dz = s.position[2] - pos[2];
    const d = dx * dx + dz * dz;
    if (d < best) {
      best = d;
      bestDist = s.distanceMeters;
    }
  }
  return bestDist;
};

/**
 * Build the per-model trigger distances, ascending. A model with no instances
 * never triggers (Infinity) since there is nothing to draw.
 */
export const planSceneryStream = (
  groups: readonly SceneryStreamGroup[],
  samples: readonly CurveDistanceSample[],
): SceneryStreamEntry[] => {
  const entries = groups.map((g) => {
    let trigger = Infinity;
    for (const p of g.instancePositions) {
      const d = nearestDistanceMeters(p, samples);
      if (d < trigger) trigger = d;
    }
    return { id: g.id, triggerDistanceMeters: trigger };
  });
  entries.sort((a, b) => a.triggerDistanceMeters - b.triggerDistanceMeters);
  return entries;
};

export interface SceneryModelsToLoadOptions {
  /**
   * The route length when the row is looping (#647 FR6). When set, the planner
   * walks the plan torus-style: an entry at the start of the route becomes
   * eligible as soon as the boat's forward route-distance to it (modulo the
   * route length) falls within `lookaheadMeters`. Omit, or set to 0, for a
   * non-looped row — then the planner uses its original linear horizon.
   */
  loopRouteMeters?: number;
}

/**
 * The not-yet-loaded models whose trigger distance is within
 * `boatDistanceMeters + lookaheadMeters`, nearest first, capped at `maxCount`.
 * `plan` is assumed ascending (as {@link planSceneryStream} returns it).
 *
 * When `loopRouteMeters` is set (#647 FR6), the horizon wraps around the end
 * of the route — entries whose trigger sits a short way past the seam are
 * eligible as the boat approaches the end of the current lap, so a model that
 * lives in the first 50 m of the route is loaded while the boat is in the
 * last 400 m. The result is still ordered by forward route-distance, nearest
 * first; `lookaheadMeters` is clamped to the route length so a tiny route
 * doesn't force every model into one tick.
 */
export const sceneryModelsToLoad = (
  plan: readonly SceneryStreamEntry[],
  loaded: Pick<ReadonlySet<string>, 'has'>,
  boatDistanceMeters: number,
  lookaheadMeters: number,
  maxCount: number,
  options: SceneryModelsToLoadOptions = {},
): string[] => {
  const { loopRouteMeters } = options;
  if (loopRouteMeters !== undefined && loopRouteMeters > 0) {
    const L = loopRouteMeters;
    const position = ((boatDistanceMeters % L) + L) % L;
    const horizon = Math.min(lookaheadMeters, L);
    const forward = (triggerDistanceMeters: number): number => {
      const offset = (((triggerDistanceMeters - position) % L) + L) % L;
      return offset;
    };
    const out: string[] = [];
    const candidates = plan
      .filter((entry) => !loaded.has(entry.id))
      .map((entry) => ({ entry, offset: forward(entry.triggerDistanceMeters) }))
      .filter(({ offset }) => offset <= horizon)
      .sort((a, b) => a.offset - b.offset);
    for (const { entry } of candidates) {
      if (out.length >= maxCount) break;
      out.push(entry.id);
    }
    return out;
  }

  const horizon = boatDistanceMeters + lookaheadMeters;
  const out: string[] = [];
  for (const entry of plan) {
    if (out.length >= maxCount) break;
    if (loaded.has(entry.id)) continue;
    if (entry.triggerDistanceMeters > horizon) break; // ascending → nothing further qualifies
    out.push(entry.id);
  }
  return out;
};

/** #726 FR2 — the shortest look-ahead, however slow the boat. */
export const SCENERY_LOOKAHEAD_FLOOR_METRES = 600;
/** #726 FR2 — seconds of travel the look-ahead covers at the current speed. */
export const SCENERY_LOOKAHEAD_SECONDS = 60;

/**
 * #726 FR2 — the look-ahead window in metres: a minute of travel at the
 * boat's current speed, never less than 600 m, so a model is requested
 * well before its nearest instance can come into view.
 */
export const streamLookaheadMeters = (speedMps: number): number => (
  Math.max(SCENERY_LOOKAHEAD_FLOOR_METRES, (Number.isFinite(speedMps) ? Math.max(0, speedMps) : 0) * SCENERY_LOOKAHEAD_SECONDS)
);

/**
 * #726 FR5 — decoded models wait here and are registered (GPU buffers and
 * a bind group each) one per frame, so several finishing together never
 * stall one frame.
 */
export interface RegistrationQueue<T> {
  push(item: T): void;
  /** Hands the oldest waiting item to `register`; false when none waited. */
  drainOne(register: (item: T) => void): boolean;
  readonly pending: number;
}

export const createRegistrationQueue = <T>(): RegistrationQueue<T> => {
  const items: T[] = [];
  return {
    push: (item) => { items.push(item); },
    drainOne: (register) => {
      const item = items.shift();
      if (item === undefined) return false;
      register(item);
      return true;
    },
    get pending() { return items.length; },
  };
};

/** #736 FR2 — how far the boat, or the far edge of its look-ahead, moves before the stream looks again. */
export const STREAM_RECHECK_METERS = 5;

/** Where the stream last looked: the boat's distance and the far edge of its window. */
export interface StreamLook {
  meters: number;
  horizon: number;
  loop: boolean;
}

/**
 * #736 FR2 — whether the stream plan can have a new answer since `last`.
 * Not while nothing is in flight, the boat is within `STREAM_RECHECK_METERS`
 * of where it last looked, and the window's far edge has not grown by as
 * much (a shrinking window cannot bring a model into range).
 */
export const streamNeedsRecheck = (
  last: StreamLook | null,
  boatDistanceMeters: number,
  lookaheadMeters: number,
  loop: boolean,
  inFlight: boolean,
): boolean =>
  last === null
  || inFlight
  || last.loop !== loop
  || Math.abs(boatDistanceMeters - last.meters) >= STREAM_RECHECK_METERS
  || boatDistanceMeters + lookaheadMeters - last.horizon >= STREAM_RECHECK_METERS;
