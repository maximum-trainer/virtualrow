/**
 * #727 VP-09 FR1/FR2 — instance culling by cell.
 *
 * A scenery model's instances are spread along the whole route, and the
 * mesh pass used to draw every one of them in the colour pass and in every
 * shadow cascade, wherever the boat was. Here the instances are binned into
 * square cells on the ground and re-ordered so each cell's instances are
 * contiguous in the instance buffer. A frame then tests each cell's box
 * against the view (or a cascade's) frustum and draws only the visible
 * cells, as `(firstInstance, count)` runs.
 *
 * Cells are spatial, not distances along the route, so a lap or an
 * out-and-back still draws the other leg's trees when they are in view.
 */

import type { Mat4 } from '../math/mat4';

/** Ground cell edge, metres. Large enough that a route has a few hundred, not thousands. */
export const INSTANCE_CELL_METRES = 120;

export interface InstanceCell {
  /** Instances `[first, first + count)` of the re-ordered list. */
  first: number;
  count: number;
  /** World-space box of the cell's instances, grown by the model's radius. */
  min: [number, number, number];
  max: [number, number, number];
}

export interface CellLayout {
  /** `order[k]` is the caller's index of the k-th instance in cell order. */
  order: Uint32Array;
  cells: InstanceCell[];
  /** Box around every cell, for a whole-mesh early out. */
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Bin instances into cells. `positions` holds each instance's world
 * translation (x, y, z interleaved); `radii[i]` is how far its model reaches
 * from that point (the mesh's bounding radius times the instance's scale).
 */
export const buildCellLayout = (
  positions: ArrayLike<number>,
  radii: ArrayLike<number>,
  cellMetres = INSTANCE_CELL_METRES,
): CellLayout => {
  const n = radii.length;
  const keys = new Map<string, number[]>();
  for (let i = 0; i < n; i += 1) {
    const key = `${Math.floor(positions[i * 3] / cellMetres)},${Math.floor(positions[i * 3 + 2] / cellMetres)}`;
    let list = keys.get(key);
    if (!list) {
      list = [];
      keys.set(key, list);
    }
    list.push(i);
  }
  const order = new Uint32Array(n);
  const cells: InstanceCell[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let k = 0;
  for (const list of keys.values()) {
    const cell: InstanceCell = { first: k, count: list.length, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const i of list) {
      order[k] = i;
      k += 1;
      const r = radii[i];
      for (let a = 0; a < 3; a += 1) {
        const p = positions[i * 3 + a];
        cell.min[a] = Math.min(cell.min[a], p - r);
        cell.max[a] = Math.max(cell.max[a], p + r);
      }
    }
    for (let a = 0; a < 3; a += 1) {
      min[a] = Math.min(min[a], cell.min[a]);
      max[a] = Math.max(max[a], cell.max[a]);
    }
    cells.push(cell);
  }
  return { order, cells, min, max };
};

/**
 * The six planes of a view-projection's frustum (WebGPU clip space, z in
 * [0, w]), each `(a, b, c, d)` with the inside where `a x + b y + c z + d >= 0`.
 * Written into `out` (24 floats); not normalised, which the box test does
 * not need.
 */
export const frustumPlanes = (m: Mat4 | Float32Array, out: Float32Array): Float32Array => {
  // Column-major: row r is (m[r], m[4 + r], m[8 + r], m[12 + r]).
  const row = (r: number, c: number): number => m[c * 4 + r];
  for (let c = 0; c < 4; c += 1) {
    const r0 = row(0, c);
    const r1 = row(1, c);
    const r2 = row(2, c);
    const r3 = row(3, c);
    out[0 + c] = r3 + r0; // left
    out[4 + c] = r3 - r0; // right
    out[8 + c] = r3 + r1; // bottom
    out[12 + c] = r3 - r1; // top
    out[16 + c] = r2; // near (z >= 0)
    out[20 + c] = r3 - r2; // far
  }
  return out;
};

/** Whether a world box lies wholly outside any one plane, so nothing of it can be seen. */
export const boxOutsideFrustum = (
  planes: Float32Array,
  min: readonly number[],
  max: readonly number[],
): boolean => {
  for (let p = 0; p < 24; p += 4) {
    const a = planes[p];
    const b = planes[p + 1];
    const c = planes[p + 2];
    // The box corner furthest along the plane's normal.
    const x = a >= 0 ? max[0] : min[0];
    const y = b >= 0 ? max[1] : min[1];
    const z = c >= 0 ? max[2] : min[2];
    if (a * x + b * y + c * z + planes[p + 3] < 0) return true;
  }
  return false;
};

/**
 * The runs of visible instances: `(first, count)` pairs written into `out`,
 * adjacent cells merged into one run. Returns the number of runs.
 */
export interface NearLimit {
  /** Eye position on the ground plane. */
  x: number;
  z: number;
  /** #725 FR7 — cells whose box is further than this (horizontally) are skipped; 0 means no limit. */
  maxDistance: number;
  /**
   * #727 FR4 — cells whose box comes within this (horizontally) are
   * skipped: the far side of an LOD split. Absent for none.
   */
  minDistance?: number;
}

/** Horizontal distance from (x, z) to a box, 0 inside it. */
const boxGroundDistance = (x: number, z: number, min: readonly number[], max: readonly number[]): number =>
  Math.hypot(Math.max(min[0] - x, 0, x - max[0]), Math.max(min[2] - z, 0, z - max[2]));

export const visibleRuns = (
  layout: CellLayout,
  planes: Float32Array,
  out: Uint32Array,
  near?: NearLimit | null,
): number => {
  if (boxOutsideFrustum(planes, layout.min, layout.max)) return 0;
  const maxDistance = near && near.maxDistance > 0 ? near.maxDistance : Infinity;
  const minDistance = near?.minDistance ?? -1;
  const ranged = !!near && (maxDistance < Infinity || minDistance >= 0);
  if (ranged && boxGroundDistance(near.x, near.z, layout.min, layout.max) > maxDistance) return 0;
  let runs = 0;
  for (const cell of layout.cells) {
    if (boxOutsideFrustum(planes, cell.min, cell.max)) continue;
    if (ranged) {
      const d = boxGroundDistance(near.x, near.z, cell.min, cell.max);
      if (d > maxDistance || d <= minDistance) continue;
    }
    const last = runs - 1;
    if (last >= 0 && out[last * 2] + out[last * 2 + 1] === cell.first) {
      out[last * 2 + 1] += cell.count;
    } else {
      out[runs * 2] = cell.first;
      out[runs * 2 + 1] = cell.count;
      runs += 1;
    }
  }
  return runs;
};

/** Largest distance of any vertex from the mesh's origin (the instance's pivot). */
export const meshRadius = (positions: Float32Array): number => {
  let r2 = 0;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const d = positions[i] * positions[i] + positions[i + 1] * positions[i + 1] + positions[i + 2] * positions[i + 2];
    if (d > r2) r2 = d;
  }
  return Math.sqrt(r2);
};

/** Largest axis scale of a column-major model matrix. */
export const maxScale = (m: ArrayLike<number>): number =>
  Math.sqrt(
    Math.max(
      m[0] * m[0] + m[1] * m[1] + m[2] * m[2],
      m[4] * m[4] + m[5] * m[5] + m[6] * m[6],
      m[8] * m[8] + m[9] * m[9] + m[10] * m[10],
    ),
  );
