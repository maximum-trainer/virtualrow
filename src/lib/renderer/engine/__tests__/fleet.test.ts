// #577 fleet state module — deterministic creation, lane assignment
// avoids the player (lane 0) and the race ghost (lane −GH), and the
// per-frame advance respawns members into the streaming window when
// they fall out of it.

import { describe, expect, it } from 'vitest';
import {
  advanceFleet,
  createFleet,
  FLEET_HULL_PALETTE,
  fleetHullTintFor,
  fleetPaletteIndexForColor,
  fleetProgressForMembers,
  FLEET_MAX,
  FLEET_WINDOW_AHEAD_M,
  FLEET_WINDOW_BEHIND_M,
  FLEET_SPEED_SPREAD,
  LANE_BANK_CLEARANCE_M,
  NOMINAL_CRUISE_MPS,
  fleetFadeFor,
  fleetWaterHalfWidth,
  type FleetState,
} from '../fleet';
import { GHOST_LANE_OFFSET_M } from '../../../../components/rower3d/ghost';

describe('#577 createFleet — deterministic layout', () => {
  it('returns an empty fleet on count 0', () => {
    const state = createFleet({ count: 0, routeMeters: 2_000 });
    expect(state.members).toEqual([]);
  });

  it('clamps the count to FLEET_MAX', () => {
    const state = createFleet({ count: 100, routeMeters: 2_000 });
    expect(state.members).toHaveLength(FLEET_MAX);
  });

  it('places members on lanes that avoid the player (0) and the race ghost (−GHOST_LANE_OFFSET_M)', () => {
    const state = createFleet({ count: 8, routeMeters: 2_000 });
    for (const m of state.members) {
      expect(m.laneOffsetMeters).not.toBe(0);
      expect(m.laneOffsetMeters).not.toBe(-GHOST_LANE_OFFSET_M);
    }
  });

  it('spreads initial distances across the streaming window', () => {
    const state = createFleet({ count: 4, routeMeters: 10_000, playerStartMeters: 0 });
    const relative = state.members.map((m) => m.distanceMeters);
    // 4-boat pack lands at -112.5 / -37.5 / +37.5 / +112.5 relative
    // to the player; wrapped to [0, routeMeters), the first lands
    // deep in the route and the other three sit close to 0.
    expect(relative.filter((d) => d >= 0 && d < 10_000)).toHaveLength(4);
    // Spread check: no two members share the same distance.
    const unique = new Set(relative);
    expect(unique.size).toBe(4);
  });

  it('is deterministic for a given (routeId, count)', () => {
    const a = createFleet({ count: 4, routeMeters: 6_000, routeId: 'willowbrook' });
    const b = createFleet({ count: 4, routeMeters: 6_000, routeId: 'willowbrook' });
    expect(a.members).toEqual(b.members);
  });

  it("diverges for different routeIds (so each route has its own pack)", () => {
    const a = createFleet({ count: 4, routeMeters: 6_000, routeId: 'willowbrook' });
    const b = createFleet({ count: 4, routeMeters: 6_000, routeId: 'hocr' });
    // Crew assignments and lane order come from the seed; at least
    // one member should diverge between the two routes.
    const differ = a.members.some((m, i) => m.crew !== b.members[i].crew);
    expect(differ).toBe(true);
  });

  it('splits crew roughly 50/50 from the seed (D7b)', () => {
    const state = createFleet({ count: 8, routeMeters: 6_000, routeId: 'test' });
    const males = state.members.filter((m) => m.crew === 'male').length;
    const females = state.members.filter((m) => m.crew === 'female').length;
    expect(males + females).toBe(8);
    // Not strictly 4 / 4 on a specific seed, but should be inside 2..6.
    expect(males).toBeGreaterThanOrEqual(2);
    expect(males).toBeLessThanOrEqual(6);
  });
});

describe('#577 advanceFleet — cruise + window respawn (D4c, D5b)', () => {
  it('leaves an empty fleet untouched', () => {
    const state = createFleet({ count: 0, routeMeters: 2_000 });
    const next = advanceFleet(state, 100, 1);
    expect(next.members).toEqual([]);
  });

  it('advances every member at the nominal cruise speed when nobody is out of window', () => {
    const state = createFleet({ count: 4, routeMeters: 10_000, playerStartMeters: 5_000 });
    const beforeDistances = state.members.map((m) => m.distanceMeters);
    const dt = 1.0;
    const next = advanceFleet(state, 5_000 + NOMINAL_CRUISE_MPS * dt, dt);
    for (let i = 0; i < next.members.length; i += 1) {
      const delta = next.members[i].distanceMeters - beforeDistances[i];
      // #728 FR5: each member rows at its own share of the pace.
      expect(delta).toBeCloseTo(NOMINAL_CRUISE_MPS * next.members[i].speedFactor * dt, 3);
    }
  });

  it('respawns a member that falls off the front of the streaming window', () => {
    // Start the pack at 0, then jump the player forward so every
    // member is now behind the window's back edge.
    const state = createFleet({ count: 4, routeMeters: 10_000, playerStartMeters: 0 });
    const next = advanceFleet(state, 10 + FLEET_WINDOW_AHEAD_M + 200, 0);
    for (const m of next.members) {
      const relative = m.distanceMeters - (10 + FLEET_WINDOW_AHEAD_M + 200);
      expect(relative).toBeGreaterThanOrEqual(-FLEET_WINDOW_BEHIND_M - 1);
      expect(relative).toBeLessThanOrEqual(FLEET_WINDOW_AHEAD_M + 1);
    }
  });

  it('respawns a member that falls off the back of the streaming window', () => {
    // Start pack at 5000, then "rewind" the player so every member
    // is beyond the window's front edge.
    const state = createFleet({ count: 4, routeMeters: 10_000, playerStartMeters: 5_000 });
    const next = advanceFleet(state, 5_000 - FLEET_WINDOW_BEHIND_M - 200, 0);
    for (const m of next.members) {
      const relative = m.distanceMeters - (5_000 - FLEET_WINDOW_BEHIND_M - 200);
      expect(relative).toBeGreaterThanOrEqual(-FLEET_WINDOW_BEHIND_M - 1);
      expect(relative).toBeLessThanOrEqual(FLEET_WINDOW_AHEAD_M + 1);
    }
  });

  it('wraps around a loop so a near-end member stays visible', () => {
    // On a 1 km loop with the player near the start, a member at
    // distance 950 should resolve as "50 m behind the player" via
    // the loop wrap, not "950 m ahead".
    const state = createFleet({ count: 2, routeMeters: 1_000, playerStartMeters: 0 });
    // Move player forward past the start/end seam.
    const next = advanceFleet(state, 20, 1);
    for (const m of next.members) {
      expect(m.distanceMeters).toBeGreaterThanOrEqual(0);
      expect(m.distanceMeters).toBeLessThan(1_000);
    }
  });
});

describe('#577 fleetProgressForMembers', () => {
  it('maps distance → progress in [0, 1)', () => {
    const state = createFleet({ count: 4, routeMeters: 2_000, playerStartMeters: 500 });
    const progress = fleetProgressForMembers(state);
    expect(progress).toHaveLength(4);
    for (const p of progress) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });
});

describe('#577 D6b fleetHullTintFor — per-member palette variation', () => {
  it('palette carries at least 4 distinct entries so a pack of 4 reads as varied', () => {
    expect(FLEET_HULL_PALETTE.length).toBeGreaterThanOrEqual(4);
    const serialised = new Set(FLEET_HULL_PALETTE.map((c) => Array.from(c).join(',')));
    expect(serialised.size).toBe(FLEET_HULL_PALETTE.length);
  });

  it('every palette entry is a normalised RGBA tuple', () => {
    for (const c of FLEET_HULL_PALETTE) {
      expect(c).toBeInstanceOf(Float32Array);
      expect(c.length).toBe(4);
      for (let i = 0; i < 3; i += 1) {
        expect(c[i]).toBeGreaterThanOrEqual(0);
        expect(c[i]).toBeLessThanOrEqual(1);
      }
      expect(c[3]).toBe(1);
    }
  });

  it('returns the same tint for the same seed (deterministic)', () => {
    const a = fleetHullTintFor(1234);
    const b = fleetHullTintFor(1234);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('cycles through the palette across sequential seeds', () => {
    const picks = new Set<string>();
    for (let s = 0; s < FLEET_HULL_PALETTE.length; s += 1) {
      picks.add(Array.from(fleetHullTintFor(s)).join(','));
    }
    expect(picks.size).toBe(FLEET_HULL_PALETTE.length);
  });

  it('nudges past the excluded palette index so the fleet avoids the player top', () => {
    // If the raw hash lands on index 3 but index 3 is excluded, the
    // picker should nudge to index 4 (not just return the same colour).
    const excluded = 3;
    const seed = excluded; // seed % 8 = 3
    const tint = fleetHullTintFor(seed, excluded);
    const expected = FLEET_HULL_PALETTE[(excluded + 1) % FLEET_HULL_PALETTE.length];
    expect(Array.from(tint)).toEqual(Array.from(expected));
  });

  it('leaves non-matching seeds unaffected by the exclusion', () => {
    const excluded = 3;
    const seed = 5; // 5 % 8 = 5, not excluded
    const tint = fleetHullTintFor(seed, excluded);
    expect(Array.from(tint)).toEqual(Array.from(FLEET_HULL_PALETTE[5]));
  });

  it('a fleet of 8 gets 8 distinct hull tints across common routeIds', () => {
    const state = createFleet({ count: 8, routeMeters: 6_000, routeId: 'willowbrook' });
    const tints = state.members.map((m) => Array.from(fleetHullTintFor(m.seed)).join(','));
    const unique = new Set(tints);
    // 8 palette entries + deterministic seeds → at least 6 distinct colours
    // (bound keeps the test honest if a seed collision happens on a
    // particular routeId; the point is "the pack reads as varied").
    expect(unique.size).toBeGreaterThanOrEqual(6);
  });
});

describe('#577 D6b fleetPaletteIndexForColor — map the player top to a palette index', () => {
  it('returns the exact palette index for an exact palette entry', () => {
    for (let i = 0; i < FLEET_HULL_PALETTE.length; i += 1) {
      const c = FLEET_HULL_PALETTE[i];
      const rgba: [number, number, number, number] = [c[0], c[1], c[2], 1];
      expect(fleetPaletteIndexForColor(rgba)).toBe(i);
    }
  });

  it('returns the nearest palette index for an off-palette colour', () => {
    // The "club red" entry at FLEET_HULL_PALETTE[0] is [0.78, 0.22, 0.22, 1].
    // A slightly off-colour red should still land on it.
    const nearRed: [number, number, number, number] = [0.80, 0.24, 0.20, 1];
    expect(fleetPaletteIndexForColor(nearRed)).toBe(0);
  });

  it("composes with fleetHullTintFor so a fleet member never shares the player's palette index", () => {
    // Pick a palette index as the player's current top; sweep every
    // possible raw seed-mod-8 result and verify the member never
    // lands on the excluded index.
    for (let playerIndex = 0; playerIndex < FLEET_HULL_PALETTE.length; playerIndex += 1) {
      const playerTop: [number, number, number, number] = [
        FLEET_HULL_PALETTE[playerIndex][0],
        FLEET_HULL_PALETTE[playerIndex][1],
        FLEET_HULL_PALETTE[playerIndex][2],
        1,
      ];
      const excludeIndex = fleetPaletteIndexForColor(playerTop);
      expect(excludeIndex).toBe(playerIndex);
      for (let seed = 0; seed < FLEET_HULL_PALETTE.length; seed += 1) {
        const tint = fleetHullTintFor(seed, excludeIndex);
        expect(Array.from(tint)).not.toEqual(Array.from(FLEET_HULL_PALETTE[playerIndex]));
      }
    }
  });
});

// #728 VP-10 — lanes clear of the player's blades and inside the water
// (FR3), no spawning in view (FR4), and per-member speeds around the
// player's own pace (FR5).

/** The player rows at `mps` for `seconds`, at 60 fps. Returns every frame's state. */
const row = (start: FleetState, fromMeters: number, mps: (t: number) => number, seconds: number) => {
  const dt = 1 / 60;
  const frames: { state: FleetState; player: number }[] = [];
  let state = start;
  let player = fromMeters;
  for (let t = 0; t < seconds; t += dt) {
    player += mps(t) * dt;
    state = advanceFleet(state, player, dt);
    frames.push({ state, player });
  }
  return frames;
};

const relativeTo = (d: number, player: number, routeMeters: number): number => {
  let r = d - player;
  while (r > routeMeters / 2) r -= routeMeters;
  while (r < -routeMeters / 2) r += routeMeters;
  return r;
};

describe('#728 FR3 lanes', () => {
  // A scull's blade tip is ~2.9 m off the centreline, so two boats need
  // 2 × 2.9 + 1 m between centrelines for the blades to stay 1 m apart.
  const BLADE_TIP_M = 2.9;

  it('puts the ghost a full lane from the player, with 1 m between blade tips', () => {
    expect(GHOST_LANE_OFFSET_M).toBeGreaterThanOrEqual(7);
    expect(GHOST_LANE_OFFSET_M - 2 * BLADE_TIP_M).toBeGreaterThanOrEqual(1);
  });

  it('keeps every fleet lane at least 7 m from the player, the ghost and each other', () => {
    const state = createFleet({ count: 8, routeMeters: 6_000 });
    const lanes = [0, -GHOST_LANE_OFFSET_M, ...state.members.map((m) => m.laneOffsetMeters)];
    for (let i = 0; i < lanes.length; i += 1) {
      for (let j = i + 1; j < lanes.length; j += 1) {
        expect(Math.abs(lanes[i] - lanes[j])).toBeGreaterThanOrEqual(7);
      }
    }
  });

  it('drops lanes that would sit within 2 m of the bank, so narrow water gets a smaller fleet', () => {
    const half = 22.5;
    const state = createFleet({ count: 8, routeMeters: 6_000, waterHalfWidth: { left: half, right: half } });
    expect(LANE_BANK_CLEARANCE_M).toBe(2);
    expect(state.members.length).toBeGreaterThan(0);
    expect(state.members.length).toBeLessThan(8);
    for (const m of state.members) {
      expect(Math.abs(m.laneOffsetMeters)).toBeLessThanOrEqual(half - LANE_BANK_CLEARANCE_M);
    }
  });

  it('fields one boat on a 20 m river and none on a 10 m one', () => {
    expect(createFleet({ count: 8, routeMeters: 6_000, waterHalfWidth: { left: 10, right: 10 } }).members.map((m) => m.laneOffsetMeters)).toEqual([GHOST_LANE_OFFSET_M]);
    expect(createFleet({ count: 8, routeMeters: 6_000, waterHalfWidth: { left: 5, right: 5 } }).members).toEqual([]);
  });

  it('reads each bank on its own side: positive lanes against the right bank, negative against the left', () => {
    const state = createFleet({ count: 8, routeMeters: 6_000, waterHalfWidth: { left: 31, right: 9 } });
    const lanes = state.members.map((m) => m.laneOffsetMeters);
    expect(lanes).toEqual([7, -14, -21, -28]);
  });
});

describe('#728 FR3 fleetWaterHalfWidth — the width the lanes are fitted to', () => {
  it('uses the fallback when the route has no water edges', () => {
    expect(fleetWaterHalfWidth(undefined, 20)).toEqual({ left: 20, right: 20 });
  });

  it("takes each side's narrow reaches (10th percentile), not its single narrowest point", () => {
    // Right bank 30 m out except a 2% pinch at a bridge; left bank narrows to 12 m for a fifth of the course.
    const edges = (t: number) => ({ left: t > 0.8 ? 12 : 25, right: t > 0.49 && t < 0.51 ? 4 : 30 });
    const w = fleetWaterHalfWidth(edges, 20);
    expect(w.right).toBe(30);
    expect(w.left).toBe(12);
  });

  it('ignores samples that are not finite', () => {
    expect(fleetWaterHalfWidth(() => ({ left: Number.NaN, right: 15 }), 20)).toEqual({ left: 20, right: 15 });
  });
});

describe('#728 FR4 no spawning in view', () => {
  it('fades a member out completely before the window edge, and in fully at its middle', () => {
    expect(fleetFadeFor(FLEET_WINDOW_AHEAD_M)).toBe(0);
    expect(fleetFadeFor(-FLEET_WINDOW_BEHIND_M)).toBe(0);
    expect(fleetFadeFor(0)).toBe(1);
    expect(fleetFadeFor(100)).toBe(1);
    // Monotonic towards each edge.
    expect(fleetFadeFor(240)).toBeLessThan(fleetFadeFor(200));
    expect(fleetFadeFor(-110)).toBeLessThan(fleetFadeFor(-70));
  });

  const assertNoBlink = (frames: { state: FleetState; player: number }[], start: FleetState) => {
    let prev = start;
    let jumps = 0;
    for (const { state, player } of frames) {
      for (let i = 0; i < state.members.length; i += 1) {
        const a = prev.members[i].distanceMeters;
        const b = state.members[i].distanceMeters;
        if (Math.abs(relativeTo(b, a, state.routeMeters)) <= 15) continue;
        jumps += 1;
        const rel = relativeTo(b, player, state.routeMeters);
        // Lands out of sight: far ahead (beyond 250 m of the camera) or
        // astern of the player, behind a chase camera; and invisible.
        expect(rel >= 250 || rel <= -FLEET_WINDOW_BEHIND_M + 30).toBe(true);
        expect(fleetFadeFor(rel)).toBe(0);
        expect(fleetFadeFor(relativeTo(a, player, state.routeMeters))).toBe(0);
      }
      prev = state;
    }
    return jumps;
  };

  it('respawns only where the boat cannot be seen, over a 5 minute row with surges and a stop', () => {
    const start = createFleet({ count: 8, routeMeters: 20_000, routeId: 'willowbrook', playerStartMeters: 1_000 });
    // Steady, then a sprint, then stopped for a minute: the fleet keeps
    // rowing and cycles off the front.
    const pace = (t: number) => (t < 120 ? 4 : t < 180 ? 5.5 : t < 240 ? 0 : 3.6);
    const frames = row(start, 1_000, pace, 300);
    const jumps = assertNoBlink(frames, start);
    expect(jumps).toBeGreaterThan(0);
  });
});

describe('#728 FR5 per-member speeds', () => {
  it('gives each member its own speed within ±8% of the pace, some faster and some slower', () => {
    const state = createFleet({ count: 8, routeMeters: 6_000, routeId: 'willowbrook' });
    expect(FLEET_SPEED_SPREAD).toBe(0.08);
    const f = state.members.map((m) => m.speedFactor);
    for (const k of f) {
      expect(k).toBeGreaterThanOrEqual(1 - FLEET_SPEED_SPREAD);
      expect(k).toBeLessThanOrEqual(1 + FLEET_SPEED_SPREAD);
    }
    expect(f.some((k) => k > 1)).toBe(true);
    expect(f.some((k) => k < 1)).toBe(true);
  });

  it("follows the player's rolling average pace", () => {
    const start = createFleet({ count: 4, routeMeters: 20_000, playerStartMeters: 1_000 });
    expect(start.paceMps).toBe(NOMINAL_CRUISE_MPS);
    const frames = row(start, 1_000, () => 5, 120);
    expect(frames[frames.length - 1].state.paceMps).toBeCloseTo(5, 1);
    // Rolling, not instant: one second in it has barely moved.
    expect(frames[59].state.paceMps).toBeLessThan(4.2);
  });

  it('keeps the pace through a stop rather than dropping to zero', () => {
    const start = createFleet({ count: 4, routeMeters: 20_000, playerStartMeters: 1_000 });
    const frames = row(start, 1_000, () => 0, 30);
    expect(frames[frames.length - 1].state.paceMps).toBe(NOMINAL_CRUISE_MPS);
  });

  it('ignores a jump in the player distance (a seek), which is not a pace', () => {
    const start = createFleet({ count: 4, routeMeters: 20_000, playerStartMeters: 1_000 });
    const next = advanceFleet(start, 1_800, 1 / 60);
    expect(next.paceMps).toBe(NOMINAL_CRUISE_MPS);
  });

  it('lets the player overtake slower boats and watch faster ones pull away, without teleports', () => {
    const start = createFleet({ count: 8, routeMeters: 20_000, routeId: 'willowbrook', playerStartMeters: 5_000 });
    const frames = row(start, 5_000, () => 4, 60);
    const end = frames[frames.length - 1];
    let gained = 0;
    let lost = 0;
    for (let i = 0; i < start.members.length; i += 1) {
      const before = relativeTo(start.members[i].distanceMeters, 5_000, 20_000);
      const after = relativeTo(end.state.members[i].distanceMeters, end.player, 20_000);
      if (Math.abs(after - before) > 50) continue; // respawned
      if (after > before + 1) gained += 1;
      if (after < before - 1) lost += 1;
    }
    expect(gained).toBeGreaterThan(0);
    expect(lost).toBeGreaterThan(0);
  });
});
