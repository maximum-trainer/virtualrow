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
 *
 * #728 VP-10 reworked the lanes and the motion:
 * - FR3: the lane pitch is `GHOST_LANE_OFFSET_M` (7 m), so blade tips
 *   (~2.9 m off each centreline) clear by 1 m. A lane closer than
 *   `LANE_BANK_CLEARANCE_M` to its bank is not used, so narrow water
 *   fields a smaller fleet.
 * - FR4: respawns land in a hidden band at either end of the window,
 *   where `fleetFadeFor` is 0, and the ahead edge is beyond 250 m of the
 *   camera. A boat fades in over the next 60 m instead of popping.
 * - FR5: each member rows at its own share (±8%) of the player's rolling
 *   average pace, so some are overtaken and some pull away.
 */

import { GHOST_LANE_OFFSET_M } from '../../../components/rower3d/ghost';

/** The streaming window around the player, per D5b. */
export const FLEET_WINDOW_BEHIND_M = 150;
export const FLEET_WINDOW_AHEAD_M = 300;
/** Pace a fleet member cruises at in metres per second (~1:45 / 500 m). */
export const NOMINAL_CRUISE_MPS = 4.0;
/** Upper bound on the fleet size any tier asks for (extra-high = 8). */
export const FLEET_MAX = 8;
/** #728 FR3: a lane's centreline stays this far inside its bank. */
export const LANE_BANK_CLEARANCE_M = 2;
/** #728 FR5: members row within ±this share of the player's pace. */
export const FLEET_SPEED_SPREAD = 0.08;
/**
 * #728 FR4: the outer band at each end of the window where a member is
 * fully faded out. Respawns land inside it.
 */
const FLEET_HIDDEN_BAND_M = 30;
/** #728 FR4: the fade from hidden to fully drawn, inside the hidden band. */
const FLEET_FADE_M = 60;
/** Time constant of the player's rolling-average pace, in seconds. */
const PACE_TAU_S = 20;
/**
 * A per-frame player speed outside this range is a stop or a seek, not a
 * pace, and leaves the rolling average where it is.
 */
const MIN_PACE_MPS = 0.5;
const MAX_PACE_MPS = 12;

export type FleetCrew = 'male' | 'female';

/**
 * #577 D6b — per-member hull tint palette. The placeholder fleet's
 * most visible cue is the hull colour, so a curated palette turns the
 * pack from "a line of grey boats" into "a line of club colours" at
 * chase-camera distance.
 *
 * Eight entries: club red / navy / green / yellow / orange / teal /
 * burgundy / grey. `fleetHullTintFor(seed)` picks one deterministically
 * from the member's seed so screenshots stay reproducible.
 *
 * `Float32Array` values are kept per-entry rather than a single big
 * buffer so the engine can hand each one straight to
 * `boatPass.fleet[i].write({ tintRGBA })` without slicing.
 */
export const FLEET_HULL_PALETTE: readonly Float32Array[] = [
  new Float32Array([0.78, 0.22, 0.22, 1.0]), // club red
  new Float32Array([0.14, 0.26, 0.58, 1.0]), // navy
  new Float32Array([0.22, 0.60, 0.33, 1.0]), // forest green
  new Float32Array([0.95, 0.80, 0.25, 1.0]), // regatta yellow
  new Float32Array([0.90, 0.46, 0.18, 1.0]), // orange
  new Float32Array([0.22, 0.64, 0.68, 1.0]), // teal
  new Float32Array([0.56, 0.18, 0.28, 1.0]), // burgundy
  new Float32Array([0.70, 0.70, 0.68, 1.0]), // neutral light grey
];

/**
 * Index of the palette entry closest (RGB Euclidean) to an RGBA input.
 * Used by the engine to derive the `excludeIndex` for
 * `fleetHullTintFor` from the player's current unisuit top colour, so
 * the fleet's hull colour never matches the player's kit (D6b "exclude
 * player's current top").
 *
 * The distance threshold is implicit: whichever palette entry is
 * numerically closest wins, even if the colours aren't particularly
 * close — the engine treats every nearby pick as a potential clash
 * and the picker nudges off it. For an exact non-match, the player
 * can pick a palette entry that sits far from every fleet colour.
 */
export const fleetPaletteIndexForColor = (
  rgb: readonly [number, number, number, number],
): number => {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < FLEET_HULL_PALETTE.length; i += 1) {
    const c = FLEET_HULL_PALETTE[i];
    const dr = rgb[0] - c[0];
    const dg = rgb[1] - c[1];
    const db = rgb[2] - c[2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
};

/**
 * #713 D4a — the share of a stroke (0..1) a member rows ahead of the
 * player's shared phase, from its seed, so the pack keeps the player's
 * rate without rowing in lockstep.
 */
export const fleetStrokeOffset = (seed: number): number => hash((seed ^ 0x2c1b3c6d) >>> 0);

/** Pick a hull tint for a fleet member deterministically from its seed. */
export const fleetHullTintFor = (seed: number, excludeIndex?: number): Float32Array => {
  // Round the seed through the same hash the state module uses so a
  // slight seed change still yields distinct picks.
  const roll = seed % FLEET_HULL_PALETTE.length;
  const idx = (roll + FLEET_HULL_PALETTE.length) % FLEET_HULL_PALETTE.length;
  if (excludeIndex !== undefined && idx === excludeIndex) {
    // Nudge to the next entry so the fleet member doesn't wear the
    // player's current top colour. One hop is enough to pick a
    // different hue; a modulo keeps the bounds.
    return FLEET_HULL_PALETTE[(idx + 1) % FLEET_HULL_PALETTE.length];
  }
  return FLEET_HULL_PALETTE[idx];
};

export interface FleetMember {
  /** Distance along the route in metres, wrapped to `[0, routeMeters)`. */
  distanceMeters: number;
  /** Lane offset in metres, positive = starboard. Fixed at creation. */
  laneOffsetMeters: number;
  /** Which crew GLB skeleton this member belongs to (D7b). */
  crew: FleetCrew;
  /** Stable seed for the member, used by the engine to derive per-member tint. */
  seed: number;
  /** #728 FR5: share of the player's pace this member rows at. */
  speedFactor: number;
}

export interface FleetState {
  readonly members: readonly FleetMember[];
  readonly routeMeters: number;
  /** #728 FR5: the player's rolling-average speed, m/s. */
  readonly paceMps: number;
  /** The player's distance at the last advance, to measure the pace from. */
  readonly playerMeters: number;
}

/**
 * #728 FR4: how much of a member to draw, from its distance relative to
 * the player. 0 in the hidden band at each end of the window, 1 in the
 * middle, linear in between.
 */
export const fleetFadeFor = (relativeMeters: number): number => {
  const ahead = (FLEET_WINDOW_AHEAD_M - FLEET_HIDDEN_BAND_M - relativeMeters) / FLEET_FADE_M;
  const behind = (relativeMeters + FLEET_WINDOW_BEHIND_M - FLEET_HIDDEN_BAND_M) / FLEET_FADE_M;
  return Math.max(0, Math.min(1, ahead, behind));
};

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
 * D3a lane assignment, at the #728 FR3 pitch. The race ghost sits at
 * `−GHOST_LANE_OFFSET_M`; the fleet avoids it (D11a) by taking
 * `+GHOST_LANE_OFFSET_M` first, then alternating outer lanes:
 * `+1, +2, −2, +3, −3, …` × pitch. A lane whose centreline would be
 * within `LANE_BANK_CLEARANCE_M` of its bank (positive lanes against
 * the right bank, negative against the left) is skipped, so the fleet
 * can come back shorter than `count`.
 */
const laneOffsetsFor = (
  count: number,
  water: { left: number; right: number } | undefined,
): number[] => {
  const pitch = GHOST_LANE_OFFSET_M;
  const maxRight = water ? water.right - LANE_BANK_CLEARANCE_M : Infinity;
  const maxLeft = water ? water.left - LANE_BANK_CLEARANCE_M : Infinity;
  const fits = (k: number): boolean => (k > 0 ? k * pitch <= maxRight : -k * pitch <= maxLeft);
  const candidates: number[] = [1];
  // Enough candidates for `count` lanes on one side of wide water.
  for (let k = 2; candidates.length < 2 * count + 2; k += 1) candidates.push(k, -k);
  const out: number[] = [];
  for (const k of candidates) {
    if (out.length >= count) break;
    if (fits(k)) out.push(k * pitch);
  }
  return out;
};

/**
 * #728 FR3: the half-width the fleet's lanes are fitted to, per side,
 * from the route's water edges. Each side takes its 10th percentile over
 * the course, so a bridge pinch doesn't empty the river but a long narrow
 * reach does trim the outer lanes. `fallback` stands in for a route with
 * no edges (or a side with no finite samples): the water strip's default.
 */
export const fleetWaterHalfWidth = (
  edgesForProgress: ((progress: number) => { left: number; right: number }) | undefined,
  fallback: number,
  samples = 64,
): { left: number; right: number } => {
  if (!edgesForProgress) return { left: fallback, right: fallback };
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const e = edgesForProgress((i + 0.5) / samples);
    if (Number.isFinite(e.left)) left.push(e.left);
    if (Number.isFinite(e.right)) right.push(e.right);
  }
  const p10 = (xs: number[]): number => {
    if (xs.length === 0) return fallback;
    xs.sort((a, b) => a - b);
    return xs[Math.floor(xs.length * 0.1)];
  };
  return { left: p10(left), right: p10(right) };
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
  /** #728 FR3: the water's half-width on each side of the course. */
  waterHalfWidth?: { left: number; right: number };
}): FleetState => {
  const lanes = laneOffsetsFor(
    Math.max(0, Math.min(FLEET_MAX, Math.floor(opts.count))),
    opts.waterHalfWidth,
  );
  const count = lanes.length;
  const routeMeters = Math.max(1, opts.routeMeters);
  const base = seedFromRouteId(opts.routeId) >>> 0;
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
      speedFactor: 1 + (hash(seed ^ 0x51ed270b) * 2 - 1) * FLEET_SPEED_SPREAD,
    });
  }
  return { members, routeMeters, paceMps: NOMINAL_CRUISE_MPS, playerMeters: playerStart };
};

/**
 * Advance the fleet by `dt` seconds. Each member rows at its own share of
 * the player's rolling-average pace (#728 FR5); when its offset from the
 * player leaves the streaming window (D5b), it respawns into the hidden
 * band at the far end (#728 FR4), out of sight, and fades in from there.
 *
 * Returns a NEW state so callers can diff for tests; the hot path
 * replaces the state reference each frame.
 */
export const advanceFleet = (
  state: FleetState,
  playerDistanceMeters: number,
  dt: number,
): FleetState => {
  const routeMeters = state.routeMeters;
  const step = Math.max(0, dt);
  let paceMps = state.paceMps;
  if (step > 0) {
    const v = signedDelta(playerDistanceMeters, state.playerMeters, routeMeters) / step;
    if (v >= MIN_PACE_MPS && v <= MAX_PACE_MPS) {
      paceMps += (v - paceMps) * (1 - Math.exp(-step / PACE_TAU_S));
    }
  }
  if (state.members.length === 0) {
    return { members: state.members, routeMeters, paceMps, playerMeters: playerDistanceMeters };
  }
  const members = state.members.map((m) => {
    let d = wrapRouteDistance(m.distanceMeters + paceMps * m.speedFactor * step, routeMeters);
    const relative = signedDelta(d, playerDistanceMeters, routeMeters);
    if (relative > FLEET_WINDOW_AHEAD_M) {
      // Pulled away off the front → respawn astern, in the hidden band,
      // with a jitter so the pack doesn't bunch into one slot.
      const jitter = hash(m.seed) * FLEET_HIDDEN_BAND_M;
      d = wrapRouteDistance(playerDistanceMeters - FLEET_WINDOW_BEHIND_M + jitter, routeMeters);
    } else if (relative < -FLEET_WINDOW_BEHIND_M) {
      const jitter = hash(m.seed ^ 0x9e3779b9) * FLEET_HIDDEN_BAND_M;
      d = wrapRouteDistance(playerDistanceMeters + FLEET_WINDOW_AHEAD_M - jitter, routeMeters);
    }
    return { ...m, distanceMeters: d };
  });
  return { members, routeMeters, paceMps, playerMeters: playerDistanceMeters };
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
