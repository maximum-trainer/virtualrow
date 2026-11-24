// #725 FR7 — with stations every few tens of metres, small kit detail is
// drawn only near the camera, and fades out before its draw distance.
import { describe, expect, it } from 'vitest';
import {
  DETAIL_DRAW_METRES,
  DETAIL_SHADOW_METRES,
  sceneryCastsShadowFor,
  sceneryShadowDistanceFor,
  TREE_SHADOW_METRES,
  sceneryDrawDistanceFor,
  TREE_DRAW_METRES,
} from '../sceneryDrawDistance';
import { buildCellLayout, visibleRuns } from '../instanceCells';
import { packRevealUniform } from '../../passes/sceneryReveal';
import sceneryMeshWgsl from '../../passes/sceneryMesh.wgsl?raw';

describe('scenery draw distance (#725 FR7)', () => {
  it('small kit detail draws to 250 m, kit trees to 400 m, everything else unlimited', () => {
    expect(DETAIL_DRAW_METRES).toBe(250);
    expect(TREE_DRAW_METRES).toBe(400);
    expect(sceneryDrawDistanceFor('f19-flower-meadow-patch')).toBe(DETAIL_DRAW_METRES);
    expect(sceneryDrawDistanceFor('f21-boulder-cluster')).toBe(DETAIL_DRAW_METRES);
    expect(sceneryDrawDistanceFor('e04-english-oak')).toBe(TREE_DRAW_METRES);
    expect(sceneryDrawDistanceFor('e09-alder-scrub')).toBe(DETAIL_DRAW_METRES);
    expect(sceneryDrawDistanceFor('f45-treeline-strip')).toBe(0);
    expect(sceneryDrawDistanceFor('f46-hill-ridge-far')).toBe(0);
    // Course furniture and structures are never dropped for distance.
    expect(sceneryDrawDistanceFor('a01-buoy-lane-sphere')).toBe(0);
    expect(sceneryDrawDistanceFor('c01-bridge-arch-stone')).toBe(0);
  });

  it('detail casts shadows only near the camera, and the tiniest none at all', () => {
    expect(sceneryShadowDistanceFor('f24-deadfall-branch-pile')).toBe(DETAIL_SHADOW_METRES);
    expect(sceneryShadowDistanceFor('e04-english-oak')).toBe(TREE_SHADOW_METRES);
    expect(sceneryShadowDistanceFor('f45-treeline-strip')).toBe(0);
    expect(sceneryCastsShadowFor('f19-flower-meadow-patch')).toBe(false);
    expect(sceneryCastsShadowFor('f21-boulder-cluster')).toBe(false);
    expect(sceneryCastsShadowFor('f24-deadfall-branch-pile')).toBe(true);
    expect(sceneryCastsShadowFor('e04-english-oak')).toBe(true);
    expect(sceneryCastsShadowFor('a12-regatta-flagpole')).toBe(true);
  });

  it('slender course furniture casts its shadow only near the camera; trees to 120 m (#725 FR7)', () => {
    expect(TREE_SHADOW_METRES).toBe(120);
    expect(sceneryShadowDistanceFor('a12-regatta-flagpole')).toBe(DETAIL_SHADOW_METRES);
    expect(sceneryShadowDistanceFor('a01-buoy-lane-sphere')).toBe(DETAIL_SHADOW_METRES);
    expect(sceneryShadowDistanceFor('c01-bridge-arch-stone')).toBe(0);
  });

  it('cells beyond the draw distance from the eye are skipped, near ones kept', () => {
    // Two instances: one 100 m away, one 900 m away, both in an all-pass frustum.
    const layout = buildCellLayout([0, 0, -100, 0, 0, -900], [1, 1], 120);
    const everything = new Float32Array(24);
    for (let p = 0; p < 24; p += 4) everything[p + 3] = 1;
    const out = new Uint32Array(layout.cells.length * 2);
    const drawn = (runs: number) => {
      const ids: number[] = [];
      for (let r = 0; r < runs; r++) for (let k = 0; k < out[r * 2 + 1]; k++) ids.push(layout.order[out[r * 2] + k]);
      return ids.sort();
    };
    expect(drawn(visibleRuns(layout, everything, out))).toEqual([0, 1]);
    expect(drawn(visibleRuns(layout, everything, out, { x: 0, z: 0, maxDistance: 300 }))).toEqual([0]);
    // No limit when maxDistance is 0.
    expect(drawn(visibleRuns(layout, everything, out, { x: 0, z: 0, maxDistance: 0 }))).toEqual([0, 1]);
  });

  it('the reveal uniform carries the draw distance, and the shader fades out before it', () => {
    expect(Array.from(packRevealUniform(0, undefined, 250))[3]).toBe(250);
    expect(Array.from(packRevealUniform(0))[3]).toBe(0);
    expect(sceneryMeshWgsl).toMatch(/reveal\.w/);
  });
});
