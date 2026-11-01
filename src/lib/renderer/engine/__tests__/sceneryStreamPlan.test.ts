import { describe, expect, it } from 'vitest';
import {
  planSceneryStream,
  sceneryModelsToLoad,
  type CurveDistanceSample,
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
