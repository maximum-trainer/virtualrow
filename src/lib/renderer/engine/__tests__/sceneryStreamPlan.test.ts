import { describe, expect, it } from 'vitest';
import {
  createRegistrationQueue,
  planSceneryStream,
  streamLookaheadMeters,
  sceneryModelsToLoad,
  sceneryModelsToUnload,
  SCENERY_KEEP_NEAR_METRES,
  type CurveDistanceSample,
  STREAM_RECHECK_METERS,
  streamNeedsRecheck,
} from '../sceneryStreamPlan';

// A straight 1000 m route sampled every 100 m along +Z... actually -Z, but the
// planner only cares about horizontal distance to each sample, so lay them on Z.
const samples: CurveDistanceSample[] = Array.from({ length: 11 }, (_, i) => ({
  position: [0, 0, -i * 100] as [number, number, number],
  distanceMeters: i * 100,
}));

describe('planSceneryStream', () => {
  it('sets each model trigger distance to its nearest instance along the route, sorted ascending', () => {
    const plan = planSceneryStream(
      [
        { id: 'finish-tower', instancePositions: [[5, 0, -980]] }, // near the end
        { id: 'bank-edge', instancePositions: [[3, 0, -20], [3, 0, -700]] }, // nearest is ~0
        { id: 'mid-dock', instancePositions: [[2, 0, -500]] },
      ],
      samples,
    );
    expect(plan.map((e) => e.id)).toEqual(['bank-edge', 'mid-dock', 'finish-tower']);
    expect(plan[0].triggerDistanceMeters).toBe(0);
    expect(plan[1].triggerDistanceMeters).toBe(500);
    expect(plan[2].triggerDistanceMeters).toBe(1000);
  });

  it('measures horizontal distance only (ignores Y height)', () => {
    const plan = planSceneryStream(
      [{ id: 'hilltop', instancePositions: [[0, 999, -300]] }],
      samples,
    );
    expect(plan[0].triggerDistanceMeters).toBe(300);
  });

  it('with no curve samples, everything triggers at 0 so nothing is deferred', () => {
    const plan = planSceneryStream([{ id: 'x', instancePositions: [[1, 2, 3]] }], []);
    expect(plan[0].triggerDistanceMeters).toBe(0);
  });
});

describe('sceneryModelsToLoad', () => {
  const plan = [
    { id: 'a', triggerDistanceMeters: 0 },
    { id: 'b', triggerDistanceMeters: 200 },
    { id: 'c', triggerDistanceMeters: 500 },
    { id: 'd', triggerDistanceMeters: 900 },
  ];

  it('loads models within boatDistance + lookahead, nearest first, capped', () => {
    // boat at 0, lookahead 400 → a(0) and b(200) are in range; c(500) is not.
    expect(sceneryModelsToLoad(plan, new Set(), 0, 400, 10)).toEqual(['a', 'b']);
  });

  it('excludes already-loaded models', () => {
    expect(sceneryModelsToLoad(plan, new Set(['a']), 0, 400, 10)).toEqual(['b']);
  });

  it('caps to maxCount, taking the nearest', () => {
    // at 600 with lookahead 400 → window reaches 1000: a,b,c,d all eligible; cap 2.
    expect(sceneryModelsToLoad(plan, new Set(), 600, 400, 2)).toEqual(['a', 'b']);
  });

  it('loads more as the boat advances', () => {
    expect(sceneryModelsToLoad(plan, new Set(['a', 'b']), 600, 400, 10)).toEqual(['c', 'd']);
  });

  // #647 FR6 — looping wraps the stream window around the end of the route so
  // the next lap's leading tiles are already there when the boat crosses the
  // seam.
  describe('with loopRouteMeters set (loop mode)', () => {
    it('loads entries at the start of the route as the boat approaches the seam', () => {
      // At boat 950 on a 1000 m route with 400 m lookahead, the horizon
      // reaches the start of the next lap (route-pos 350). a(0) and b(200)
      // are both within one lap of the current position; d(900) is behind.
      // Forward offsets: a→50, b→250, c→550, d→950 → d filtered.
      expect(
        sceneryModelsToLoad(plan, new Set(), 950, 400, 10, { loopRouteMeters: 1000 }),
      ).toEqual(['a', 'b']);
    });

    it('orders by forward route-distance, nearest first', () => {
      // boat at 850, lookahead 400 → forward offsets: a→150, b→350, c→650,
      // d→50. Order should be d, a, b.
      expect(
        sceneryModelsToLoad(plan, new Set(), 850, 400, 10, { loopRouteMeters: 1000 }),
      ).toEqual(['d', 'a', 'b']);
    });

    it('normalises cumulative distances past multiple laps', () => {
      // boat at 3850 = three laps + 850, same lookahead → identical to 850.
      expect(
        sceneryModelsToLoad(plan, new Set(), 3850, 400, 10, { loopRouteMeters: 1000 }),
      ).toEqual(['d', 'a', 'b']);
    });

    it('caps the lookahead at one lap on a tiny route', () => {
      // On a 1000 m route a 50_000 m lookahead would otherwise load every tile
      // every tick. Clamping to route length keeps the window at most one lap.
      const out = sceneryModelsToLoad(plan, new Set(), 0, 50_000, 10, {
        loopRouteMeters: 1000,
      });
      // All four tiles are within one lap, so they all qualify.
      expect(out).toEqual(['a', 'b', 'c', 'd']);
    });

    it('excludes already-loaded models', () => {
      expect(
        sceneryModelsToLoad(plan, new Set(['a']), 850, 400, 10, { loopRouteMeters: 1000 }),
      ).toEqual(['d', 'b']);
    });

    it('caps to maxCount, taking the nearest-forward', () => {
      expect(
        sceneryModelsToLoad(plan, new Set(), 850, 400, 1, { loopRouteMeters: 1000 }),
      ).toEqual(['d']);
    });

    it('loopRouteMeters = 0 falls back to the linear planner', () => {
      expect(
        sceneryModelsToLoad(plan, new Set(), 0, 400, 10, { loopRouteMeters: 0 }),
      ).toEqual(['a', 'b']);
    });
  });
});

// #726 VP-08 FR2 — the look-ahead is a minute of travel, never under 600 m.
describe('streamLookaheadMeters', () => {
  it('is 600 m at rest and at a paddle', () => {
    expect(streamLookaheadMeters(0)).toBe(600);
    expect(streamLookaheadMeters(5)).toBe(600);
  });

  it('is a minute of travel when that is further', () => {
    expect(streamLookaheadMeters(12)).toBe(720);
  });

  it('treats a missing or negative speed as rest', () => {
    expect(streamLookaheadMeters(Number.NaN)).toBe(600);
    expect(streamLookaheadMeters(-3)).toBe(600);
  });
});

// #726 VP-08 FR5 — at most one registration per frame.
describe('createRegistrationQueue', () => {
  it('hands over one item per drain, oldest first', () => {
    const q = createRegistrationQueue<string>();
    q.push('a');
    q.push('b');
    q.push('c');
    const done: string[] = [];
    expect(q.drainOne((id) => done.push(id))).toBe(true);
    expect(done).toEqual(['a']);
    expect(q.pending).toBe(2);
    q.drainOne((id) => done.push(id));
    q.drainOne((id) => done.push(id));
    expect(done).toEqual(['a', 'b', 'c']);
    expect(q.drainOne(() => { throw new Error('nothing waits'); })).toBe(false);
    expect(q.pending).toBe(0);
  });
});

// #736 VP-18 FR2 — the stream looks again only when its answer can change.
describe('streamNeedsRecheck', () => {
  const last = { meters: 100, horizon: 700, loop: false };
  it('looks the first time, and whenever something is in flight', () => {
    expect(streamNeedsRecheck(null, 0, 600, false, false)).toBe(true);
    expect(streamNeedsRecheck(last, 100, 600, false, true)).toBe(true);
  });
  it('skips while the boat is within 5 m and the window has not grown 5 m', () => {
    expect(streamNeedsRecheck(last, 104.9, 600, false, false)).toBe(false);
    expect(streamNeedsRecheck(last, 100, 400, false, false)).toBe(false);
  });
  it('looks again after 5 m, after a seek back, a grown window, or a loop switch', () => {
    expect(streamNeedsRecheck(last, 100 + STREAM_RECHECK_METERS, 600, false, false)).toBe(true);
    expect(streamNeedsRecheck(last, 50, 600, false, false)).toBe(true);
    expect(streamNeedsRecheck(last, 101, 605, false, false)).toBe(true);
    expect(streamNeedsRecheck(last, 100, 600, true, false)).toBe(true);
  });
});

describe('unloading scenery the boat has left behind (#727 FR3)', () => {
  // A straight 6 km route along -z, sampled every 50 m.
  const long: CurveDistanceSample[] = Array.from({ length: 121 }, (_, i) => ({
    position: [0, 0, -i * 50] as [number, number, number],
    distanceMeters: i * 50,
  }));
  const plan = planSceneryStream(
    [
      { id: 'start-dock', instancePositions: [[20, 0, -10], [25, 0, -60]] },
      { id: 'willow', instancePositions: [[20, 0, -100], [20, 0, -5900]] },
      { id: 'finish-tower', instancePositions: [[30, 0, -5950]] },
    ],
    long,
  );

  it('keeps every instance distance, ascending', () => {
    const willow = plan.find((e) => e.id === 'willow')!;
    expect([...willow.instanceDistances!]).toEqual([100, 5900]);
  });

  it('unloads only what is behind along the route and far away in a straight line', () => {
    const loaded = ['start-dock', 'willow', 'finish-tower'];
    // At 3 km nothing is within the keep window (2.85-3.9 km) or 1 km of the
    // boat: the dock and the near willow are behind, the far willow and the
    // tower not needed yet.
    expect(sceneryModelsToUnload(plan, loaded, 3000, 600, 0, -3000).sort()).toEqual(['finish-tower', 'start-dock', 'willow']);
    // At 5.5 km the willow's far instance is inside the keep-ahead window.
    expect(sceneryModelsToUnload(plan, loaded, 5500, 600, 0, -5500)).toEqual(['start-dock']);
    // At 400 m the dock stays (behind, but close by) and so does the willow.
    expect(sceneryModelsToUnload(plan, loaded, 400, 600, 0, -400)).toEqual(['finish-tower']);
  });

  it('never unloads a model with an instance close by in a straight line (a lap\'s other leg)', () => {
    // Boat 3 km along the route, but standing beside the dock (the route doubled back).
    expect(sceneryModelsToUnload(plan, ['start-dock'], 3000, 600, 0, -(SCENERY_KEEP_NEAR_METRES - 100))).toEqual([]);
  });

  it('does not ask again for a model it has just unloaded', () => {
    const unloaded = sceneryModelsToUnload(plan, ['start-dock', 'willow', 'finish-tower'], 3000, 600, 0, -3000);
    const reload = sceneryModelsToLoad(plan, new Set(['finish-tower']), 3000, 600, 10);
    for (const id of unloaded) expect(reload).not.toContain(id);
  });

  it('still loads a model whose next instance is ahead, though its first is behind', () => {
    expect(sceneryModelsToLoad(plan, new Set(), 5500, 600, 10)).toEqual(['willow', 'finish-tower']);
  });
});
