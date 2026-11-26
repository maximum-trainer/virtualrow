import { describe, it, expect } from 'vitest';
import { liftTreesOverLandforms, type SceneryGlbGroup } from '../groundTrees';
import type { ReliefPlacement } from '../horizonRelief';
import type { SceneryModelId } from '../../../components/rower3d/sceneryAssets';

/**
 * #886 FR4 — bank-strip kit trees stand on the kit landforms that cover
 * their (x, z), matching Dan's D2(c) recommendation: clamp by
 * `landformSurfaceAt`.
 */

// A 25 m tall bluff standing at the origin, scale 1 (its authored dome
// peaks at `top * scale = 25 m`).
const bluff: ReliefPlacement = {
  id: 'f12-bluff-steep',
  x: 0,
  z: 0,
  yaw: 0,
  scale: 1,
  angleDeg: 5,
  along: 0,
};

const treeIds: ReadonlySet<SceneryModelId> = new Set(['e04-english-oak', 'e08-scots-pine']);

const makeGroup = (id: SceneryModelId, positions: Array<[number, number, number]>): SceneryGlbGroup => ({
  id,
  instances: positions.map((position) => ({ position, rotationY: 0, scale: 1 })),
});

describe('liftTreesOverLandforms (#886 FR4)', () => {
  it('lifts a tree whose (x, z) sits under the dome of a kit landform', () => {
    const groups = [makeGroup('e04-english-oak', [[0, 0, 0]])];
    const [lifted] = liftTreesOverLandforms(groups, [bluff], treeIds);
    expect(lifted.instances[0].position[1]).toBeCloseTo(25, 3);
  });

  it('leaves a tree with (x, z) outside every landform footprint at y=0', () => {
    // 500 m east of the bluff — well outside its ~60 m length.
    const groups = [makeGroup('e08-scots-pine', [[500, 0, 0]])];
    const [lifted] = liftTreesOverLandforms(groups, [bluff], treeIds);
    expect(lifted.instances[0].position[1]).toBe(0);
  });

  it('never lowers a tree already above the landform surface', () => {
    const groups = [makeGroup('e04-english-oak', [[0, 50, 0]])];
    const [lifted] = liftTreesOverLandforms(groups, [bluff], treeIds);
    expect(lifted.instances[0].position[1]).toBe(50);
  });

  it('leaves non-tree groups untouched', () => {
    const groups = [makeGroup('a01-buoy-lane-sphere', [[0, 0, 0]])];
    const out = liftTreesOverLandforms(groups, [bluff], treeIds);
    expect(out[0]).toBe(groups[0]);
    expect(out[0].instances[0].position[1]).toBe(0);
  });

  it('returns the same group references when there is nothing to lift', () => {
    const groups = [makeGroup('e04-english-oak', [[0, 0, 0]])];
    expect(liftTreesOverLandforms(groups, [], treeIds)[0]).toBe(groups[0]);
    expect(liftTreesOverLandforms(groups, [bluff], new Set())[0]).toBe(groups[0]);
  });
});
