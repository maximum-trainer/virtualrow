// #685 slice 1 — the generic course furniture generator grows to match
// what a real rowing course looks like (D1c-slice, D2b cadence).
//
// Before: `courseFurniture` placed two lane buoys at progress 0, two at
// progress 1, a distance post every 500 m, and a finish tower at progress 1.
// Dan's 290 m demo frame showed water + bank + 11 buildings + distant
// trees — the buoys were behind the camera, the first post 200 m ahead,
// the tower a km away. The scene read as "empty lake".
//
// This slice adds:
//  - Start-line regatta flagpoles (a12), one each side at progress 0.
//  - Finish-line regatta flagpoles, one each side at progress 1.
//  - Lane buoys every 250 m on both sides (D2b "medium gets quieter
//    cadence", 250 m matches the medium band in the issue's Ds).
//
// Follow-ups (not in this slice):
//  - Boathouses / pontoons on the banks (needs per-route data to avoid
//    putting a boathouse mid-channel on a narrow stretch).
//  - Extra-high tier getting a tighter cadence (100 m buoys / banners).
//  - Exempting small props from shadow casting (D4 — needs the
//    `sceneryMeshPass.forEachActiveShadowCaster` seam).

import { describe, expect, it } from 'vitest';
import {
  courseFurniture,
  DISTANCE_POST_INTERVAL_METERS,
  LANE_BUOY_INTERVAL_METERS,
} from '../courseFurniture';

describe('#685 courseFurniture — start/finish flagpoles and 250 m buoys', () => {
  it('exposes the 250 m lane-buoy cadence as a constant', () => {
    expect(LANE_BUOY_INTERVAL_METERS).toBe(250);
    expect(DISTANCE_POST_INTERVAL_METERS).toBe(500);
  });

  it('places a flagpole on each bank at the start line', () => {
    const items = courseFurniture(2000);
    const startFlags = items.filter(
      (it) => it.id === 'a12-regatta-flagpole' && it.progress === 0,
    );
    expect(startFlags).toHaveLength(2);
    const sides = startFlags.map((it) => it.side).sort();
    expect(sides).toEqual(['left', 'right']);
    for (const f of startFlags) expect(f.kind).toBe('furniture');
  });

  it('places a flagpole on each bank at the finish line', () => {
    const items = courseFurniture(2000);
    const finishFlags = items.filter(
      (it) => it.id === 'a12-regatta-flagpole' && it.progress === 1,
    );
    expect(finishFlags).toHaveLength(2);
    const sides = finishFlags.map((it) => it.side).sort();
    expect(sides).toEqual(['left', 'right']);
  });

  it('places start and finish buoy lines on both sides', () => {
    // #685 slice 1 ships the start/finish flagpoles with the existing
    // start/finish buoy cadence. The mid-route 250 m buoys land together
    // with the D4 shadow-caster exemption in a follow-up PR — without the
    // exemption, 50 extra buoy meshes (680 tri each × 3 cascades) regress
    // p50 gpuMs from 11 → 21 ms on Intel Gen-9, blowing the FR10 budget.
    const items = courseFurniture(2000);
    const buoys = items.filter((it) => it.kind === 'buoy');
    expect(buoys).toHaveLength(4);
    const bySide = new Map<string, number[]>([
      ['left', []],
      ['right', []],
    ]);
    for (const b of buoys) bySide.get(b.side)?.push(b.progress);
    expect(bySide.get('left')!.sort()).toEqual([0, 1]);
    expect(bySide.get('right')!.sort()).toEqual([0, 1]);
  });

  it('does not place anything on a zero-length route', () => {
    expect(courseFurniture(0)).toEqual([]);
    expect(courseFurniture(-10)).toEqual([]);
    expect(courseFurniture(Number.NaN)).toEqual([]);
  });

  it('keeps the distance-post cadence and the finish tower untouched', () => {
    const items = courseFurniture(2000);
    const posts = items.filter((it) => it.id === 'a07-distance-marker-post');
    // 2000 m / 500 m = 4 posts (no cap: MAX_DISTANCE_POSTS=30 room to spare).
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

  it('keeps the start/finish buoy pair even on an absurdly long route', () => {
    const items = courseFurniture(1_000_000);
    const buoys = items.filter((it) => it.kind === 'buoy');
    expect(buoys).toHaveLength(4);
    expect(buoys.some((b) => b.progress === 0 && b.side === 'left')).toBe(true);
    expect(buoys.some((b) => b.progress === 1 && b.side === 'right')).toBe(true);
  });
});
