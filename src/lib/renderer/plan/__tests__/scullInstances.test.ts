// #728 VP-10 FR1 — the ghost is the player's scull GLB at another place:
// each primitive's ghost instance is the player's transform with only the
// boat placement and the stroke swapped, through the same crewStrokePose.

import { describe, expect, it } from 'vitest';
import { mat4, mat4FromRotationY, mat4Identity, mat4Multiply, type Mat4 } from '../../math/mat4';
import { crewStrokePose, oarSweep } from '../crewStroke';
import { scullBoatTrs, scullPrimitiveTransform, type ScullPrimitive } from '../scullInstances';

const translate = (x: number, y: number, z: number): Mat4 => {
  const m = mat4Identity(mat4());
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};

const hull: ScullPrimitive = { nodeWorld: translate(0, 0.1, 0), nodeName: 'Hull' };
const oar: ScullPrimitive = { nodeWorld: translate(1.5, 0.3, 0), group: 'LeftOar', pivotWorld: translate(0.8, 0.3, 0) };

const close = (a: Mat4, b: Mat4) => Array.from(a).forEach((v, i) => expect(v).toBeCloseTo(b[i], 5));

describe('scullPrimitiveTransform', () => {
  it('places the ghost as the player moved rigidly to the ghost\'s spot, when both share a pose', () => {
    const sweep = oarSweep('male', 0.3, 1);
    const stroke = crewStrokePose('male', sweep);
    const player = mat4Identity(mat4());
    const ghost = scullBoatTrs(mat4(), [-7, 0, 12], 0.2);
    for (const prim of [hull, oar]) {
      const p = scullPrimitiveTransform(mat4(), prim, { boatTrs: player, sweep, stroke });
      const g = scullPrimitiveTransform(mat4(), prim, { boatTrs: ghost, sweep, stroke });
      // With the player at the origin, the ghost is the player's matrix moved by its placement.
      close(g, mat4Multiply(mat4(), ghost, p));
    }
  });

  it('swings an oar about its pivot by the sweep, mirrored for the right oar', () => {
    const boat = mat4Identity(mat4());
    const stroke = crewStrokePose('male', 0);
    const at0 = scullPrimitiveTransform(mat4(), oar, { boatTrs: boat, sweep: 0, stroke });
    const at = scullPrimitiveTransform(mat4(), oar, { boatTrs: boat, sweep: 0.4, stroke });
    // The pivot stays put: the node-local point under the pivot (0.7 m
    // inboard of the oar's node) lands on the pivot whatever the sweep.
    const apply = (m: Mat4, [x, y, z]: number[]) => [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
    for (const m of [at0, at]) {
      const [x, y, z] = apply(m, [-0.7, 0, 0]);
      expect(x).toBeCloseTo(0.8, 5);
      expect(y).toBeCloseTo(0.3, 5);
      expect(z).toBeCloseTo(0, 5);
    }
    // The blade end moves.
    expect(apply(at, [0, 0, 0])[2]).not.toBeCloseTo(apply(at0, [0, 0, 0])[2], 3);
    const right = { ...oar, group: 'RightOar' };
    const r = scullPrimitiveTransform(mat4(), right, { boatTrs: boat, sweep: 0.4, stroke });
    const expected = mat4FromRotationY(mat4(), -0.4);
    expect(r[0]).toBeCloseTo(expected[0], 5);
    expect(r[2]).toBeCloseTo(expected[2], 5);
  });
});
