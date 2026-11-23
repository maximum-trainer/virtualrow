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
  /**
   * #727 FR3 — every instance's route distance, ascending. With it a model
   * is wanted only while one of its instances is near the boat along the
   * route, so it can be unloaded behind the boat and not reloaded at once.
   */
  instanceDistances?: Float64Array;
  /** #727 FR3 — every instance's x, z, for the "still close by" check. */
  instanceXZ?: Float32Array;
}

/** #727 FR3 — how far behind the boat (route metres) a model stays wanted. */
export const SCENERY_KEEP_BEHIND_METRES = 150;
/** #727 FR3 — and how much further ahead than the load horizon it stays loaded. */
export const SCENERY_KEEP_AHEAD_EXTRA_METRES = 300;
/**
 * #727 FR3 — never unload a model with an instance this close to the boat
 * (straight-line metres): a lap's other leg, or what the bow camera sees.
 */
export const SCENERY_KEEP_NEAR_METRES = 1000;

/** Whether an entry has an instance at a route distance in `[from, to]`. */
const hasInstanceWithin = (entry: SceneryStreamEntry, from: number, to: number): boolean => {
  const d = entry.instanceDistances;
  if (!d) return entry.triggerDistanceMeters <= to;
  // First instance at or after `from`.
  let lo = 0;
  let hi = d.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < d.length && d[lo] <= to;
};

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
    const distances = new Float64Array(g.instancePositions.length);
    const xz = new Float32Array(g.instancePositions.length * 2);
    g.instancePositions.forEach((p, i) => {
      const d = nearestDistanceMeters(p, samples);
      distances[i] = d;
      xz[i * 2] = p[0];
      xz[i * 2 + 1] = p[2];
      if (d < trigger) trigger = d;
    });
    distances.sort();
    return { id: g.id, triggerDistanceMeters: trigger, instanceDistances: distances, instanceXZ: xz };
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
    // #727 FR3 — skip a model whose instances are all behind the boat.
    if (!hasInstanceWithin(entry, boatDistanceMeters - SCENERY_KEEP_BEHIND_METRES, horizon)) continue;
    out.push(entry.id);
  }
  return out;
};

/**
 * #727 FR3 — the loaded models to unload: no instance from
 * `SCENERY_KEEP_BEHIND_METRES` behind the boat to
 * `SCENERY_KEEP_AHEAD_EXTRA_METRES` past the load horizon along the route,
 * and none within `SCENERY_KEEP_NEAR_METRES` of the boat in a straight
 * line. The first rule is wider than the load window, so an unloaded model
 * is not asked for again on the next tick. Not used on a looping row.
 */
export const sceneryModelsToUnload = (
  plan: readonly SceneryStreamEntry[],
  loaded: Iterable<string>,
  boatDistanceMeters: number,
  lookaheadMeters: number,
  boatX: number,
  boatZ: number,
): string[] => {
  const byId = new Map(plan.map((e) => [e.id, e]));
  const near2 = SCENERY_KEEP_NEAR_METRES * SCENERY_KEEP_NEAR_METRES;
  const out: string[] = [];
  for (const id of loaded) {
    const entry = byId.get(id);
    if (!entry?.instanceDistances || !entry.instanceXZ) continue;
    const from = boatDistanceMeters - SCENERY_KEEP_BEHIND_METRES;
    const to = boatDistanceMeters + lookaheadMeters + SCENERY_KEEP_AHEAD_EXTRA_METRES;
    if (hasInstanceWithin(entry, from, to)) continue;
    let close = false;
    const xz = entry.instanceXZ;
    for (let i = 0; i < xz.length; i += 2) {
      const dx = xz[i] - boatX;
      const dz = xz[i + 1] - boatZ;
      if (dx * dx + dz * dz <= near2) {
        close = true;
        break;
      }
    }
    if (!close) out.push(id);
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
