import { describe, it, expect } from 'vitest';
import { buildCellLayout, frustumPlanes, visibleRuns } from '../instanceCells';
import { mat4 } from '../../math/mat4';

// #727 FR4 — visibleRuns can take only the cells beyond a distance, the far
// side of an LOD split, and the near side is the complement.

/** A camera at the origin looking down -z, 60° fov, 0.1..2000 m. */
const lookingNorth = () => {
  const vp = mat4();
  const f = 1 / Math.tan(Math.PI / 6);
  vp[0] = f; vp[5] = f; vp[10] = 2000 / (0.1 - 2000); vp[11] = -1; vp[14] = (2000 * 0.1) / (0.1 - 2000);
  return vp;
};

describe('visibleRuns near and far of a distance (#727 FR4)', () => {
  const layout = buildCellLayout(
    new Float32Array([0, 0, -50, 0, 0, -400, 0, 0, -900]),
    new Float32Array([1, 1, 1]),
    120,
  );
  const planes = frustumPlanes(lookingNorth(), new Float32Array(24));
  const zOf = (runs: Uint32Array, n: number) => {
    const out: number[] = [];
    for (let r = 0; r < n; r += 1) {
      for (let k = 0; k < runs[r * 2 + 1]; k += 1) out.push([-50, -400, -900][layout.order[runs[r * 2] + k]]);
    }
    return out.sort((a, b) => a - b);
  };

  it('splits the cells in view into those within 120 m and those beyond', () => {
    const near = new Uint32Array(6);
    const far = new Uint32Array(6);
    const n = visibleRuns(layout, planes, near, { x: 0, z: 0, maxDistance: 120 });
    const f = visibleRuns(layout, planes, far, { x: 0, z: 0, maxDistance: 0, minDistance: 120 });
    expect(zOf(near, n)).toEqual([-50]);
    expect(zOf(far, f)).toEqual([-900, -400]);
  });

  it('still honours a draw distance on the far side', () => {
    const far = new Uint32Array(6);
    const f = visibleRuns(layout, planes, far, { x: 0, z: 0, maxDistance: 500, minDistance: 120 });
    expect(zOf(far, f)).toEqual([-400]);
  });
});
