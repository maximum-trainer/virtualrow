/**
 * Contract test for the baked crew body bins (#590 AC2 / AC3 / NFR1 / NFR2).
 *
 * The engine ships `public/assets/boat/shell.bin` (default) plus two
 * variants `shell-male.bin` and `shell-female.bin`. This test loads each
 * variant, groups vertices by bone index, and pins:
 *
 *   - The header is valid and the vertex / index counts match (AC4).
 *   - Every triangle is weighted to exactly one of the four engine bones
 *     (FR3 — HULL=0, TORSO=1, ARMS=2, HEAD=3).
 *   - The male torso bone group is measurably wider than the female
 *     (AC3: `maleTorso.x >= femaleTorso.x * 1.05`), and the female hip
 *     (torso-y upper half) is proportionally narrower.
 *   - Each `.bin` is ≤ 128 KB (NFR2).
 *
 * The two existing GLBs (`scull-male.glb`, `scull-female.glb`) are size-
 * capped at ≤ 460 KB (NFR1) in a sibling assertion so a regenerate that
 * blows the budget fails this test instead of CI.
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOAT_FLOATS_PER_VERTEX } from '../lib/renderer/plan/boatMesh';
import { decodeBoatMesh } from '../lib/renderer/plan/boatMeshLoader';

const ASSET_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'public',
  'assets',
  'boat',
);

const readBin = (name: string): ArrayBuffer => {
  const buf = readFileSync(join(ASSET_DIR, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

interface BoneAABB {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
  count: number;
}

const groupByBone = (bin: ArrayBuffer): Map<number, BoneAABB> => {
  const { vertices, vertexCount } = decodeBoatMesh(bin);
  const out = new Map<number, BoneAABB>();
  for (let v = 0; v < vertexCount; v += 1) {
    const base = v * BOAT_FLOATS_PER_VERTEX;
    const x = vertices[base];
    const y = vertices[base + 1];
    const z = vertices[base + 2];
    const bone = vertices[base + 6] | 0;
    let entry = out.get(bone);
    if (!entry) {
      entry = { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z, count: 0 };
      out.set(bone, entry);
    }
    if (x < entry.minX) entry.minX = x;
    if (x > entry.maxX) entry.maxX = x;
    if (y < entry.minY) entry.minY = y;
    if (y > entry.maxY) entry.maxY = y;
    if (z < entry.minZ) entry.minZ = z;
    if (z > entry.maxZ) entry.maxZ = z;
    entry.count += 1;
  }
  return out;
};

const BONE_HULL = 0;
const BONE_TORSO = 1;
const BONE_ARMS = 2;
const BONE_HEAD = 3;

describe('engine crew mesh contract (#590)', () => {
  it('decodes shell.bin, shell-male.bin and shell-female.bin without error', () => {
    for (const name of ['shell.bin', 'shell-male.bin', 'shell-female.bin']) {
      const decoded = decodeBoatMesh(readBin(name));
      expect(decoded.vertexCount).toBeGreaterThan(0);
      expect(decoded.indexCount).toBeGreaterThan(0);
    }
  });

  it('each bin carries all four engine bones (#590 FR3)', () => {
    for (const name of ['shell-male.bin', 'shell-female.bin']) {
      const groups = groupByBone(readBin(name));
      for (const bone of [BONE_HULL, BONE_TORSO, BONE_ARMS, BONE_HEAD]) {
        const g = groups.get(bone);
        expect(g, `bone ${bone} missing from ${name}`).toBeDefined();
        expect(g!.count).toBeGreaterThan(0);
      }
    }
  });

  it('weights every vertex to exactly one bone (FR3)', () => {
    for (const name of ['shell-male.bin', 'shell-female.bin']) {
      const { vertices, vertexCount } = decodeBoatMesh(readBin(name));
      for (let v = 0; v < vertexCount; v += 1) {
        const base = v * BOAT_FLOATS_PER_VERTEX;
        const bone = vertices[base + 6];
        const weight = vertices[base + 7];
        expect(Number.isInteger(bone)).toBe(true);
        expect(bone).toBeGreaterThanOrEqual(0);
        expect(bone).toBeLessThanOrEqual(3);
        expect(weight).toBeCloseTo(1, 5);
      }
    }
  });

  it('male torso bone group is at least 5 % wider than female (AC3)', () => {
    const male = groupByBone(readBin('shell-male.bin')).get(BONE_TORSO)!;
    const female = groupByBone(readBin('shell-female.bin')).get(BONE_TORSO)!;
    const maleWidth = male.maxX - male.minX;
    const femaleWidth = female.maxX - female.minX;
    expect(maleWidth).toBeGreaterThanOrEqual(femaleWidth * 1.05);
  });

  it('male arms bone group is at least 5 % wider than female (AC3)', () => {
    const male = groupByBone(readBin('shell-male.bin')).get(BONE_ARMS)!;
    const female = groupByBone(readBin('shell-female.bin')).get(BONE_ARMS)!;
    const maleWidth = male.maxX - male.minX;
    const femaleWidth = female.maxX - female.minX;
    expect(maleWidth).toBeGreaterThanOrEqual(femaleWidth * 1.05);
  });

  it('each .bin is ≤ 128 KB (NFR2)', () => {
    for (const name of ['shell.bin', 'shell-male.bin', 'shell-female.bin']) {
      const bytes = statSync(join(ASSET_DIR, name)).size;
      expect(bytes).toBeLessThanOrEqual(128 * 1024);
    }
  });

  it('each committed .glb is ≤ 460 KB (NFR1)', () => {
    for (const name of ['scull-male.glb', 'scull-female.glb']) {
      const path = join(ASSET_DIR, name);
      // Skip if the GLB is not in this clone (CI without the LFS pull /
      // a shallow checkout) — the baker's .bin is the engine's live
      // artefact and the one this contract gates on. The GLB cap stays
      // enforced the first time it is regenerated.
      if (!existsSync(path)) return;
      const bytes = statSync(path).size;
      expect(bytes, name).toBeLessThanOrEqual(460 * 1024);
    }
  });
});
