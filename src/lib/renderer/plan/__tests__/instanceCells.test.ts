// #727 VP-09 FR1/FR2 — instance culling by ground cell.
import { describe, expect, it } from 'vitest';
import {
  boxOutsideFrustum,
  buildCellLayout,
  frustumPlanes,
  maxScale,
  meshRadius,
  visibleRuns,
} from '../instanceCells';
import { mat4, mat4LookAt, mat4Multiply, mat4Perspective } from '../../math/mat4';
import { vec3 } from '../../math/vec3';

/** Camera at `eye` looking at `at`, 60° fov, 16:9, 0.1..2000 m. */
const viewProj = (eye: [number, number, number], at: [number, number, number]) => {
  const view = mat4LookAt(mat4(), vec3(...eye), vec3(...at), vec3(0, 1, 0));
  const proj = mat4Perspective(mat4(), Math.PI / 3, 16 / 9, 0.1, 2000);
  return mat4Multiply(mat4(), proj, view);
};

const planesOf = (eye: [number, number, number], at: [number, number, number]) =>
  frustumPlanes(viewProj(eye, at), new Float32Array(24));

describe('frustum box test', () => {
  const planes = planesOf([0, 2, 0], [0, 2, -10]);

  it('keeps a box in front of the camera and drops one behind it', () => {
    expect(boxOutsideFrustum(planes, [-1, 0, -21], [1, 4, -19])).toBe(false);
    expect(boxOutsideFrustum(planes, [-1, 0, 19], [1, 4, 21])).toBe(true);
  });

  it('drops a box past the far plane and keeps one straddling the edge of view', () => {
    expect(boxOutsideFrustum(planes, [-1, 0, -2200], [1, 4, -2100])).toBe(true);
    // 60° vertical, 16:9: the horizontal half-angle is ~45.7°; at 50 m out
    // the edge is ~51 m to the side. A box spanning it is kept.
    expect(boxOutsideFrustum(planes, [45, 0, -52], [55, 4, -48])).toBe(false);
    expect(boxOutsideFrustum(planes, [70, 0, -52], [80, 4, -48])).toBe(true);
  });
});

describe('buildCellLayout', () => {
  it('orders instances so each cell is contiguous and covers its models', () => {
    // Two clusters 1 km apart, interleaved in the input.
    const pos = [0, 0, 0, 1000, 0, 0, 5, 0, 5, 1005, 0, 5, 10, 0, 0];
    const layout = buildCellLayout(pos, [2, 3, 2, 3, 2], 120);
    expect(layout.cells).toHaveLength(2);
    const [a, b] = layout.cells;
    expect([...layout.order.subarray(a.first, a.first + a.count)].sort()).toEqual([0, 2, 4]);
    expect([...layout.order.subarray(b.first, b.first + b.count)].sort()).toEqual([1, 3]);
    expect(a.min).toEqual([-2, -2, -2]);
    expect(b.max).toEqual([1008, 3, 8]);
    expect(layout.min[0]).toBe(-2);
    expect(layout.max[0]).toBe(1008);
  });
});

describe('visibleRuns', () => {
  // A row of trees every 10 m along z from +500 to -1500.
  const n = 201;
  const pos: number[] = [];
  for (let i = 0; i < n; i += 1) pos.push(8, 0, 500 - i * 10);
  const layout = buildCellLayout(pos, new Array(n).fill(4));
  const out = new Uint32Array(layout.cells.length * 2);

  it('draws what is ahead and none of what is behind', () => {
    const runs = visibleRuns(layout, planesOf([0, 3, 0], [0, 3, -10]), out);
    const drawn = new Set<number>();
    for (let r = 0; r < runs; r += 1) {
      for (let k = out[r * 2]; k < out[r * 2] + out[r * 2 + 1]; k += 1) drawn.add(layout.order[k]);
    }
    // Every tree from 10 m ahead to the end is drawn...
    for (let i = 51; i < n; i += 1) expect(drawn.has(i), `tree ${i}`).toBe(true);
    // ...and the trees well behind are not.
    for (let i = 0; i < 30; i += 1) expect(drawn.has(i), `tree ${i}`).toBe(false);
  });

  it('merges neighbouring cells into one run', () => {
    const runs = visibleRuns(layout, planesOf([0, 3, 0], [0, 3, -10]), out);
    expect(runs).toBeLessThanOrEqual(2);
  });

  it('returns nothing when the whole mesh is out of view', () => {
    expect(visibleRuns(layout, planesOf([0, 3, 600], [0, 3, 700]), out)).toBe(0);
  });

  it('never skips an instance whose box is in view (scenario: nothing visible is culled)', () => {
    // Sample cameras along and around the row; brute-force each instance.
    for (const [eye, at] of [
      [[0, 3, 0], [0, 3, -10]],
      [[30, 20, -600], [-10, 0, -620]],
      [[-40, 3, -1000], [10, 3, -900]],
    ] as [[number, number, number], [number, number, number]][]) {
      const planes = planesOf(eye, at);
      const runs = visibleRuns(layout, planes, out);
      const drawn = new Set<number>();
      for (let r = 0; r < runs; r += 1) {
        for (let k = out[r * 2]; k < out[r * 2] + out[r * 2 + 1]; k += 1) drawn.add(layout.order[k]);
      }
      for (let i = 0; i < n; i += 1) {
        const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
        const visible = !boxOutsideFrustum(planes, [p[0] - 4, p[1] - 4, p[2] - 4], [p[0] + 4, p[1] + 4, p[2] + 4]);
        if (visible) expect(drawn.has(i), `tree ${i} from ${eye}`).toBe(true);
      }
    }
  });
});

describe('model extent helpers', () => {
  it('meshRadius is the furthest vertex from the pivot', () => {
    expect(meshRadius(new Float32Array([0, 0, 0, 3, 4, 0, -1, 0, 0]))).toBe(5);
  });

  it('maxScale reads the largest axis scale of a model matrix', () => {
    const m = mat4();
    m[0] = 2; m[5] = 3; m[10] = 1.5; m[15] = 1;
    expect(maxScale(m)).toBe(3);
  });
});
