/**
 * Vitest for the local scenery-generation harness (#449 AC4 / AC5 / AC11 / AC12 / NFR5).
 *
 * The workflow and the local `run.mjs` share one `invokeLlmCad` shim —
 * these tests pin the harness's size-cap behaviour and the shim's
 * returned shape so a future refactor of the shim keeps the acceptance
 * criteria met.
 */

import { describe, expect, it } from 'vitest';
import { invokeLlmCad, checkSizeCap } from '../scenery-generation/run.mjs';

describe('scenery-generation harness (#449)', () => {
  it('invokeLlmCad returns one GLB and one placement per course (AC4)', async () => {
    const result = await invokeLlmCad({ courseId: 'course-a', courseSha: 'abc1234567890' });
    expect(Array.isArray(result.glbs)).toBe(true);
    expect(result.glbs.length).toBeGreaterThan(0);
    expect(result.placements.length).toBeGreaterThan(0);
    for (const glb of result.glbs) {
      expect(typeof glb.modelId).toBe('string');
      expect(glb.modelId.startsWith('r-')).toBe(true);
      expect(glb.filename.endsWith('.glb')).toBe(true);
      expect(glb.bytes).toBeInstanceOf(Uint8Array);
    }
    for (const p of result.placements) {
      expect(p.assetPath).toMatch(/^\/assets\/scenery\/tier-r\//);
      expect(Number.isFinite(p.distanceAlongRouteMeters)).toBe(true);
      expect(p.scale).toBeGreaterThan(0);
    }
  });

  it('checkSizeCap admits a small GLB (AC5)', () => {
    expect(checkSizeCap(new Uint8Array(100 * 1024))).toBe(true);
  });

  it('checkSizeCap rejects a GLB above the gzipped cap (AC5 / NFR2)', () => {
    // 1 MB raw × 0.65 ≈ 666 KB, over the 500 KB gzipped cap.
    expect(checkSizeCap(new Uint8Array(1024 * 1024))).toBe(false);
  });

  it('invokeLlmCad is deterministic for the same course id (AC12)', async () => {
    const a = await invokeLlmCad({ courseId: 'course-a', courseSha: 'abc1234567890' });
    const b = await invokeLlmCad({ courseId: 'course-a', courseSha: 'abc1234567890' });
    expect(a.glbs.length).toBe(b.glbs.length);
    expect(a.placements[0].modelId).toBe(b.placements[0].modelId);
  });
});
