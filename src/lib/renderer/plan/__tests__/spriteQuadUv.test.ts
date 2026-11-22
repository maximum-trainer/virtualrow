// #719 VP-01 — the crossed-quad sprite billboard in `scenery.wgsl`
// previously mapped its UV from `local.x` alone, so quad B (whose
// `local.x` is constant 0 for every vertex) sampled a single texel
// column and read as pale horizontal streaks. These tests pin the
// per-quad UV mapping both in the TS helper used by the vertex
// shader's sibling planner AND in the shader source itself, so a
// future rewrite that drops either side trips here.

import { describe, expect, it } from 'vitest';
import sceneryWgsl from '../../passes/scenery.wgsl?raw';
import { QUAD_WIDTH, spriteQuadUv } from '../spriteQuadUv';

describe('spriteQuadUv (#719 VP-01)', () => {
  it('maps quad A across u in [0, 1] along local.x', () => {
    // vi 0..5 index into QUAD_VERTS 0..3 (card A: varies along local.x).
    const us = [0, 1, 2, 3, 4, 5].map((vi) => spriteQuadUv(vi).u);
    expect(Math.min(...us)).toBeCloseTo(0, 6);
    expect(Math.max(...us)).toBeCloseTo(1, 6);
    expect(new Set(us).size).toBeGreaterThan(1);
  });

  it('maps quad B across u in [0, 1] along local.z (no constant column)', () => {
    // vi 6..11 index into QUAD_VERTS 4..7 (card B: varies along local.z).
    const us = [6, 7, 8, 9, 10, 11].map((vi) => spriteQuadUv(vi).u);
    expect(Math.min(...us)).toBeCloseTo(0, 6);
    expect(Math.max(...us)).toBeCloseTo(1, 6);
    expect(new Set(us).size).toBeGreaterThan(1);
  });

  it('keeps v = 1 - local.y so the atlas top matches the crown top', () => {
    for (let vi = 0; vi < 12; vi += 1) {
      const { v } = spriteQuadUv(vi);
      expect(v === 0 || v === 1).toBe(true);
    }
    // vi 0 → QUAD_VERTS[0] = (-0.6, 0, 0) → v = 1 (base of the card).
    expect(spriteQuadUv(0).v).toBe(1);
    // vi 2 → QUAD_VERTS[2] = (0.6, 1, 0) → v = 0 (top of the card).
    expect(spriteQuadUv(2).v).toBe(0);
  });

  it('never produces a quad with a constant u (FR1 regression guard)', () => {
    for (let quad = 0; quad < 2; quad += 1) {
      const us = new Set<number>();
      for (let i = 0; i < 6; i += 1) us.add(spriteQuadUv(quad * 6 + i).u);
      expect(us.size, `quad ${quad} must not collapse u to a constant`).toBeGreaterThan(1);
    }
  });

  it('shares its formula with scenery.wgsl so the shader samples both axes', () => {
    // The WGSL expression must divide by the full quad width (1.2) and
    // offset by 0.5, and it must include BOTH local.x and local.z (not
    // just local.x, which was the bug). Matches shapes like
    //   (local.x + local.z) / 1.2 + 0.5
    // or an equivalent select() form.
    expect(sceneryWgsl).toMatch(new RegExp(`${QUAD_WIDTH}`.replace('.', '\\.')));
    expect(sceneryWgsl).toMatch(/local\.x[\s\S]{0,40}local\.z|local\.z[\s\S]{0,40}local\.x/);
    // Negative guard: the old "local.x + 0.5" lone-axis form must be gone.
    expect(sceneryWgsl).not.toMatch(/out\.uv\s*=\s*vec2<f32>\(local\.x \+ 0\.5,\s*1\.0 - local\.y\)/);
  });
});
