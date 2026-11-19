/**
 * #577 — placeholder fleet state.
 *
 * The scene draws N extra "placeholder" boats around the player: a
 * bow-and-stern pack at fixed lane offsets that drift at a nominal
 * cruise pace and respawn into a streaming window when the player
 * passes them. This module owns the state (positions, lanes, crew)
 * and the per-frame advance; the engine drives the `boatPass` to
 * render each member at its computed model matrix.
 *
 * Dan's agreed design decisions (2026-10-24):
 * - D2b: count is `tierCaps.fleetCount` (0 / 2 / 4 / 6 / 8 across tiers).
 * - D3a: fixed lanes reusing `GHOST_LANE_OFFSET_M` from the race-ghost
 *   infrastructure; fleet members stand on lanes `±GHOST_LANE_OFFSET_M`
 *   and (for counts > 2) outer lanes `±2 × GHOST_LANE_OFFSET_M`.
 * - D4c: hybrid cruise + player-relative respawn. Each member cruises
 *   at a nominal pace (`NOMINAL_CRUISE_MPS`); when its distance along
 *   the route leaves the window `[player − 150, player + 300]`, the
 *   member respawns to the far edge so the pack always frames the
 *   player.
 * - D5b: streaming window `[player − 150 m, player + 300 m]` — out of
 *   that window is where the respawn fires.
 * - D7b: crew is a deterministic 50/50 split from the per-member seed.
 * - D11a: no fleet member overlaps the race ghost's lane (which uses
 *   `−GHOST_LANE_OFFSET_M`).
 *
 * Deterministic from `(routeId, count)` so the same route always shows
 * the same pack layout — a user looking at their own route sees the
 * same friends every time, and screenshots stay reproducible.
 */

import { GHOST_LANE_OFFSET_M } from '../../../components/rower3d/ghost';

/** The streaming window around the player, per D5b. */
export const FLEET_WINDOW_BEHIND_M = 150;
export const FLEET_WINDOW_AHEAD_M = 300;
/** Pace a fleet member cruises at in metres per second (~1:45 / 500 m). */
export const NOMINAL_CRUISE_MPS = 4.0;
/** Upper bound on the fleet size any tier asks for (extra-high = 8). */
export const FLEET_MAX = 8;

export type FleetCrew = 'male' | 'female';

export interface FleetMember {
  /** Distance along the route in metres, wrapped to `[0, routeMeters)`. */
  distanceMeters: number;
  /** Lane offset in metres, positive = starboard. Fixed at creation. */
  laneOffsetMeters: number;
  /** Which crew GLB skeleton this member belongs to (D7b). */
  crew: FleetCrew;
  /** Stable seed for the member, used by the engine to derive per-member tint. */
  seed: number;
}

export interface FleetState {
  readonly members: readonly FleetMember[];
  readonly routeMeters: number;
}

/**
 * Deterministic PRNG for a single uint32. Mirrors the `seededRandom`
 * used elsewhere (Wang hash + multiply), staying out of the scenery
 * module's import graph so the engine seam doesn't pull in the full
 * `seededRandom` chain just for fleet planning.
 */
const hash = (seed: number): number => {
  let x = (seed | 0) >>> 0;
  x = (x ^ 0x7f4a7c15) >>> 0;
  x = Math.imul(x, 0x7f4a7c15) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 0x100000000;
};

/** Map a routeId to a non-zero uint32 seed. */
const seedFromRouteId = (routeId: string | null | undefined): number => {
  if (!routeId) return 1;
  let s = 2166136261 >>> 0;
  for (let i = 0; i < routeId.length; i += 1) {
    s = Math.imul(s, 16777619) ^ routeId.charCodeAt(i);
  }
  return (s >>> 0) || 1;
};

/**
 * D3a lane assignment. The race ghost already sits at
 * `−GHOST_LANE_OFFSET_M`; the fleet avoids it (D11a) by taking
 * `+GHOST_LANE_OFFSET_M` first, then alternating outer lanes.
 *
 * Returns the lane offsets in draw order:
 *
 *   count=2 → [+GH, +2·GH]
 *   count=4 → [+GH, +2·GH, −2·GH, +3·GH]
 *   count=6 → [+GH, +2·GH, −2·GH, +3·GH, −3·GH, +4·GH]
 *   count=8 → [+GH, +2·GH, −2·GH, +3·GH, −3·GH, +4·GH, −4·GH, +5·GH]
 */
const laneOffsetsFor = (count: number): number[] => {
  const out: number[] = [];
  const lanes: number[] = [];
  // Build the candidate lane set: skip 0 (player) and −1·GH (ghost).
  // Lanes are `+GH, +2·GH, −2·GH, +3·GH, −3·GH, …`.
  lanes.push(1);
  for (let k = 2; lanes.length < count; k += 1) {
    lanes.push(k, -k);
  }
  for (let i = 0; i < count; i += 1) {
    out.push(lanes[i] * GHOST_LANE_OFFSET_M);
  }
  return out;
};

/**
 * Build the initial fleet for a route. Positions are spread evenly
 * across the streaming window so the player sees a dressed pack right
 * from the first frame; members then drift at `NOMINAL_CRUISE_MPS` and
 * respawn via `advanceFleet`.
 *
 * `playerStartMeters` defaults to 0 so the pack is centred on the start
 * line for a cold load; callers streaming mid-route can pass their
 * boat's current distance.
 */
export const createFleet = (opts: {
  count: number;
  routeMeters: number;
  routeId?: string | null;
  playerStartMeters?: number;
}): FleetState => {
  const count = Math.max(0, Math.min(FLEET_MAX, Math.floor(opts.count)));
  const routeMeters = Math.max(1, opts.routeMeters);
  const base = seedFromRouteId(opts.routeId) >>> 0;
  const lanes = laneOffsetsFor(count);
  const members: FleetMember[] = [];
  const windowSpan = FLEET_WINDOW_AHEAD_M + FLEET_WINDOW_BEHIND_M;
  const playerStart = opts.playerStartMeters ?? 0;
  for (let i = 0; i < count; i += 1) {
    const seed = (base ^ (i * 2654435761)) >>> 0;
    // Spread members across the window: member i sits at
    // `-150 + (i + 0.5) / count * span` metres from the player, so a
    // 4-boat pack lands at -112.5 / -37.5 / +37.5 / +112.5.
    const windowOffset = -FLEET_WINDOW_BEHIND_M + ((i + 0.5) / count) * windowSpan;
    const distanceMeters = wrapRouteDistance(playerStart + windowOffset, routeMeters);
    const crew: FleetCrew = hash(seed) < 0.5 ? 'male' : 'female';
    members.push({
      distanceMeters,
      laneOffsetMeters: lanes[i],
      crew,
      seed,
    });
  }
  return { members, routeMeters };
};

/**
 * Advance the fleet by `dt` seconds. Each member drifts at the nominal
 * cruise speed; when its offset from the player leaves the streaming
 * window (D5b), the member respawns to the far edge of the window so
 * the pack always frames the player.
 *
 * Returns a NEW state so callers can diff for tests; the hot path
 * replaces the state reference each frame.
 */
export const advanceFleet = (
  state: FleetState,
  playerDistanceMeters: number,
  dt: number,
): FleetState => {
  if (state.members.length === 0) return state;
  const routeMeters = state.routeMeters;
  const step = NOMINAL_CRUISE_MPS * Math.max(0, dt);
  const windowSpan = FLEET_WINDOW_AHEAD_M + FLEET_WINDOW_BEHIND_M;
  const members = state.members.map((m) => {
    let d = wrapRouteDistance(m.distanceMeters + step, routeMeters);
    const relative = signedDelta(d, playerDistanceMeters, routeMeters);
    if (relative > FLEET_WINDOW_AHEAD_M) {
      // Fell off the front → respawn at the back, with a jitter so the
      // whole pack doesn't bunch into a single slot.
      const jitter = hash(m.seed) * windowSpan * 0.1;
      d = wrapRouteDistance(playerDistanceMeters - FLEET_WINDOW_BEHIND_M + jitter, routeMeters);
    } else if (relative < -FLEET_WINDOW_BEHIND_M) {
      const jitter = hash(m.seed ^ 0x9e3779b9) * windowSpan * 0.1;
      d = wrapRouteDistance(playerDistanceMeters + FLEET_WINDOW_AHEAD_M - jitter, routeMeters);
    }
    return { ...m, distanceMeters: d };
  });
  return { members, routeMeters };
};

/** Signed shortest-path distance from `b` to `a` on the route loop. */
const signedDelta = (a: number, b: number, routeMeters: number): number => {
  let d = a - b;
  const half = routeMeters / 2;
  while (d > half) d -= routeMeters;
  while (d < -half) d += routeMeters;
  return d;
};

const wrapRouteDistance = (d: number, routeMeters: number): number => {
  if (routeMeters <= 0) return 0;
  let out = d % routeMeters;
  if (out < 0) out += routeMeters;
  return out;
};

/**
 * Compute the per-member progress (`[0, 1)`) in the order
 * `state.members` is stored. Returned as a fresh array so the engine
 * can pass it to `placeBoat`-style helpers without aliasing.
 */
export const fleetProgressForMembers = (
  state: FleetState,
): readonly number[] => {
  const out: number[] = [];
  const routeMeters = Math.max(1, state.routeMeters);
  for (const m of state.members) out.push(m.distanceMeters / routeMeters);
  return out;
};
