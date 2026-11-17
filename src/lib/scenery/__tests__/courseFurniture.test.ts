// #689 — courseFurniture now places lane buoys every 250 m on both
// sides, inclusive of the start and finish lines. Companion to the
// #688 shadow-caster exemption that keeps the extra buoy meshes out
// of the shadow-depth pass.

import { describe, expect, it } from 'vitest';
import {
  courseFurniture,
  DISTANCE_POST_INTERVAL_METERS,
  LANE_BUOY_INTERVAL_METERS,
  MAX_LANE_BUOY_SLOTS,
} from '../courseFurniture';

describe('#689 courseFurniture — 250 m lane-buoy cadence', () => {
  it('exposes the 250 m lane-buoy cadence and the 500-slot safety cap', () => {
    expect(LANE_BUOY_INTERVAL_METERS).toBe(250);
    expect(DISTANCE_POST_INTERVAL_METERS).toBe(500);
    expect(MAX_LANE_BUOY_SLOTS).toBe(500);
  });

  it('places a flagpole on each bank at start and finish', () => {
    const items = courseFurniture(2000);
    const startFlags = items.filter(
      (it) => it.id === 'a12-regatta-flagpole' && it.progress === 0,
    );
    const finishFlags = items.filter(
      (it) => it.id === 'a12-regatta-flagpole' && it.progress === 1,
    );
    expect(startFlags.map((it) => it.side).sort()).toEqual(['left', 'right']);
    expect(finishFlags.map((it) => it.side).sort()).toEqual(['left', 'right']);
  });

  it('places lane buoys every 250 m on both sides, inclusive of start and finish', () => {
    const items = courseFurniture(2000);
    const buoys = items.filter((it) => it.kind === 'buoy');
    // 2000 / 250 = 8 slots → 9 progress points (0, 0.125, 0.25, …, 1.0)
    // × 2 sides = 18 buoys.
    expect(buoys).toHaveLength(18);
    const bySide = new Map<string, number[]>([
      ['left', []],
      ['right', []],
    ]);
    for (const b of buoys) bySide.get(b.side)?.push(b.progress);
    const left = bySide.get('left')!.sort((a, b) => a - b);
    const right = bySide.get('right')!.sort((a, b) => a - b);
    expect(left).toEqual(right);
    const expected = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
    expect(left.map((p) => Number(p.toFixed(6)))).toEqual(expected);
  });

  it('places the right number of buoys on a 6 km route', () => {
    // Willowbrook demo-adjacent: 6 000 / 250 = 24 slots → 25 progress
    // points × 2 sides = 50 buoys. The scene reads as a marked rowing
    // lane for the whole route, not just the two ends.
    const items = courseFurniture(6_000);
    const buoys = items.filter((it) => it.kind === 'buoy');
    expect(buoys).toHaveLength(50);
    // Start and finish still land at the extremes.
    expect(buoys.some((b) => b.progress === 0 && b.side === 'left')).toBe(true);
    expect(buoys.some((b) => b.progress === 1 && b.side === 'right')).toBe(true);
  });

  it('does not place anything on a zero-length route', () => {
    expect(courseFurniture(0)).toEqual([]);
    expect(courseFurniture(-10)).toEqual([]);
    expect(courseFurniture(Number.NaN)).toEqual([]);
  });

  it('keeps the distance-post cadence and the finish tower untouched', () => {
    const items = courseFurniture(2000);
    const posts = items.filter((it) => it.id === 'a07-distance-marker-post');
    expect(posts).toHaveLength(4);
    for (const p of posts) {
      expect(p.side).toBe('left');
      expect(p.kind).toBe('furniture');
    }
    const towers = items.filter((it) => it.id === 'a06-finish-tower');
    expect(towers).toHaveLength(1);
    expect(towers[0].progress).toBe(1);
    expect(towers[0].side).toBe('right');
  });

  it('caps the two-sided buoy count under the pool budget on an absurdly long route', () => {
    // A 1 000 km route at 250 m cadence would be 4 001 slots × 2 sides
    // = 8 002 instances, way past the engine's 1024 pool. The stride-
    // widening keeps the slot count ≤ MAX_LANE_BUOY_SLOTS so each
    // model's instance buffer stays well inside the cap.
    const items = courseFurniture(1_000_000);
    const buoys = items.filter((it) => it.kind === 'buoy');
    expect(buoys.length).toBeLessThanOrEqual(MAX_LANE_BUOY_SLOTS * 2);
    // Start and finish still exist at the extremes even after stride
    // widening.
    expect(buoys.some((b) => b.progress === 0 && b.side === 'left')).toBe(true);
    expect(buoys.some((b) => b.progress === 1 && b.side === 'right')).toBe(true);
  });
});
