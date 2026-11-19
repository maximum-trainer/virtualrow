// #577 fleet state module — deterministic creation, lane assignment
// avoids the player (lane 0) and the race ghost (lane −GH), and the
// per-frame advance respawns members into the streaming window when
// they fall out of it.

import { describe, expect, it } from 'vitest';
import {
  advanceFleet,
  createFleet,
  fleetProgressForMembers,
  FLEET_MAX,
  FLEET_WINDOW_AHEAD_M,
  FLEET_WINDOW_BEHIND_M,
  NOMINAL_CRUISE_MPS,
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
      expect(delta).toBeCloseTo(NOMINAL_CRUISE_MPS * dt, 3);
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
