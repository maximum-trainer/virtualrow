/**
 * Crew silhouette differentiation test (#590 AC5 / NFR5).
 *
 * Loads the committed `shell-male.bin` and `shell-female.bin`, projects
 * each mesh's vertices onto a tiny 128×128 XY mask using the /row
 * chase camera's framing (orthographic drop + simple scale fit), and
 * asserts the two silhouettes XOR to at least 5 % non-overlapping
 * foreground pixels (NFR5).
 *
 * CPU-only — no GPU adapter, no WebGPU — so this runs on SwiftShader
 * CI shards without a guard.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOAT_FLOATS_PER_VERTEX } from '../../plan/boatMesh';
import { decodeBoatMesh } from '../../plan/boatMeshLoader';

const ASSET_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', '..',
  'public', 'assets', 'boat',
);

const readBin = (name: string): ArrayBuffer => {
  const buf = readFileSync(join(ASSET_DIR, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

const SIZE = 128;

/**
 * Rasterise every triangle of the mesh into a bitmask via a simple
 * scan-converter. XY is projected directly (chase camera looks down -Z);
 * every vertex is normalised to [0, SIZE) by the shared body-local range
 * so the two variants share the same framing and only the geometry
 * differs.
 */
const rasterise = (bin: ArrayBuffer): Uint8Array => {
  const { vertices, indices, indexCount } = decodeBoatMesh(bin);
  // Only crew bones (1 = TORSO, 2 = ARMS, 3 = HEAD) — the hull is the
  // same across variants and dominates the silhouette, drowning out the
  // body difference. Mask on the body alone to let AC5 bite.
  const mask = new Uint8Array(SIZE * SIZE);
  // Framing: fit the body's X range into a 60% centred band so hull
  // overshoot doesn't push the body off-canvas, and Y so the head sits
  // near the top.
  const BODY_HALF_X = 0.5;
  const BODY_MIN_Y = -0.1;
  const BODY_MAX_Y = 1.0;
  const toPx = (x: number, y: number): [number, number] => {
    const u = ((x + BODY_HALF_X) / (2 * BODY_HALF_X)) * SIZE;
    const v = ((BODY_MAX_Y - y) / (BODY_MAX_Y - BODY_MIN_Y)) * SIZE;
    return [u, v];
  };
  for (let i = 0; i < indexCount; i += 3) {
    const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
    const b0 = vertices[i0 * BOAT_FLOATS_PER_VERTEX + 6] | 0;
    const b1 = vertices[i1 * BOAT_FLOATS_PER_VERTEX + 6] | 0;
    const b2 = vertices[i2 * BOAT_FLOATS_PER_VERTEX + 6] | 0;
    // Skip hull triangles (bone 0) — the only ones not weighted to the
    // body. Keep triangles that are entirely body (worth bitmasking).
    if (b0 === 0 || b1 === 0 || b2 === 0) continue;
    const [ax, ay] = toPx(vertices[i0 * BOAT_FLOATS_PER_VERTEX], vertices[i0 * BOAT_FLOATS_PER_VERTEX + 1]);
    const [bx, by] = toPx(vertices[i1 * BOAT_FLOATS_PER_VERTEX], vertices[i1 * BOAT_FLOATS_PER_VERTEX + 1]);
    const [cx, cy] = toPx(vertices[i2 * BOAT_FLOATS_PER_VERTEX], vertices[i2 * BOAT_FLOATS_PER_VERTEX + 1]);
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(ay, by, cy)));
    // Standard half-space tri test, inclusive edges.
    const edge = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): number =>
      (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const w0 = edge(bx, by, cx, cy, px + 0.5, py + 0.5);
        const w1 = edge(cx, cy, ax, ay, px + 0.5, py + 0.5);
        const w2 = edge(ax, ay, bx, by, px + 0.5, py + 0.5);
        if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
          mask[py * SIZE + px] = 1;
        }
      }
    }
  }
  return mask;
};

describe('crew variant silhouette differs by ≥ 5 % non-overlap (#590 AC5)', () => {
  it('male and female body silhouettes read as distinct', () => {
    const male = rasterise(readBin('shell-male.bin'));
    const female = rasterise(readBin('shell-female.bin'));
    let maleOn = 0, femaleOn = 0, xor = 0, union = 0;
    for (let i = 0; i < male.length; i += 1) {
      const m = male[i], f = female[i];
      if (m) maleOn += 1;
      if (f) femaleOn += 1;
      if (m || f) union += 1;
      if (m !== f) xor += 1;
    }
    // Sanity: both masks hit something.
    expect(maleOn).toBeGreaterThan(0);
    expect(femaleOn).toBeGreaterThan(0);
    // AC5: non-overlap ≥ 5 % of the foreground union pixels.
    const nonOverlap = xor / Math.max(union, 1);
    expect(nonOverlap).toBeGreaterThanOrEqual(0.05);
  });
});
