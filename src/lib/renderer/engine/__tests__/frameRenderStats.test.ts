// #737 VP-19 FR2 — render stats are this frame's; cumulative counts live in total* fields.
import { describe, expect, it } from 'vitest';
import {
  assembleRenderStats,
  emptyPanelStats,
  emptyRenderGroups,
  writePanelStats,
  type FrameRenderInputs,
} from '../frameRenderStats';
import { overBudget } from '../../renderBudget';
import type { Rower3DRenderStats } from '../telemetry';

const fresh = (): Omit<Rower3DRenderStats, 'drawCalls'> => ({
  draws: 0,
  triangles: 0,
  instances: 0,
  sceneryDispatch: 0,
  sceneryDraws: 0,
  sceneryTriangles: 0,
  totalSceneryDispatch: 0,
  totalSceneryDraws: 0,
  totalSceneryTriangles: 0,
  shadowDraws: 0,
  shadowTriangles: 0,
  shadowAtlasBytes: 0,
  residentMeshes: 0,
  residentMeshBytes: 0,
  groups: emptyRenderGroups(),
});

const inputs = (): FrameRenderInputs => ({
  passes: 10,
  sceneryDispatch: 3,
  sceneryMesh: { draws: 5, instances: 40, triangles: 4000 },
  sprites: { draws: 3, pools: [{ drawn: 7 }, { drawn: -1 }, { drawn: 3 }] },
  buildings: { drawn: 12, triangles: 360 },
  shadows: { draws: 6, instances: 50, triangles: 5000 },
  shadowAtlasBytes: 1024,
});

describe('assembleRenderStats', () => {
  it('publishes the resident kit meshes and their bytes (#727 FR5)', () => {
    const s = fresh();
    assembleRenderStats(s, { ...inputs(), sceneryMesh: { draws: 5, instances: 40, triangles: 4000, residentMeshes: 7, residentBytes: 9000 } });
    expect(s.residentMeshes).toBe(7);
    expect(s.residentMeshBytes).toBe(9000);
  });

  it('breaks the frame down by group, with the scene as the lit groups together', () => {
    const s = fresh();
    assembleRenderStats(s, inputs());
    expect(s.groups.sceneryMesh).toEqual({ draws: 5, instances: 40, triangles: 4000 });
    // A pool whose cull has not been read back yet counts as nothing drawn.
    expect(s.groups.sprites).toEqual({ draws: 3, instances: 10, triangles: 40 });
    expect(s.groups.buildings).toEqual({ draws: 1, instances: 12, triangles: 360 });
    expect(s.groups.shadows).toEqual({ draws: 6, instances: 50, triangles: 5000 });
    expect(s.groups.scene).toEqual({ draws: 9, instances: 62, triangles: 4400 });
    expect(s.triangles).toBe(4400 + 5000);
    expect(s.instances).toBe(62 + 50);
    expect(s.draws).toBe(10);
    expect(s.sceneryDispatch).toBe(3);
    expect(s.sceneryDraws).toBe(8);
    expect(s.sceneryTriangles).toBe(4040);
    expect(s.shadowDraws).toBe(6);
    expect(s.shadowTriangles).toBe(5000);
    expect(s.shadowAtlasBytes).toBe(1024);
  });

  it('gives identical non-total stats for two identical frames, and grows only the totals', () => {
    const s = fresh();
    assembleRenderStats(s, inputs());
    const first = JSON.parse(JSON.stringify(s)) as typeof s;
    assembleRenderStats(s, inputs());
    for (const key of Object.keys(s) as (keyof typeof s)[]) {
      if (String(key).startsWith('total')) continue;
      expect(s[key], String(key)).toEqual(first[key]);
    }
    expect(s.triangles).toBeGreaterThan(0);
    expect(s.instances).toBeGreaterThan(0);
    expect(s.totalSceneryDispatch).toBe(6);
    expect(s.totalSceneryDraws).toBe(16);
    expect(s.totalSceneryTriangles).toBe(8080);
  });

  it('draws no buildings when none were issued', () => {
    const s = fresh();
    assembleRenderStats(s, { ...inputs(), buildings: { drawn: 0, triangles: 0 } });
    expect(s.groups.buildings).toEqual({ draws: 0, instances: 0, triangles: 0 });
  });
});

// #737 VP-19 FR3 — the debug panel reads the engine's frame cost and pacing.
describe('writePanelStats', () => {
  const pacing = { samples: 600, p50: 16.7, p95: 30, p99: 40, max: 80, over25ms: 40, over50ms: 1, longestStallMs: 80 };

  it('hands the panel the real draw calls, triangles, fps and p95 for the tier', () => {
    const s = fresh();
    assembleRenderStats(s, inputs());
    const out = emptyPanelStats();
    writePanelStats(out, { stats: s, pacing, tier: 'high', otherPasses: 7, now: 1234 });
    expect(out.drawing).toBe('webgpu');
    expect(out.performanceMode).toBe('high');
    // 7 other passes + 9 scene draws + 6 shadow draws.
    expect(out.drawCalls).toBe(22);
    expect(out.triangles).toBe(9400);
    expect(out.p95Ms).toBe(30);
    expect(out.fps).toBeCloseTo(1000 / 16.7, 6);
    expect(out.sampledAt).toBe(1234);
    // The panel flags a p95 over the tier's budget through `overBudget`.
    expect(overBudget('high', { p95Ms: out.p95Ms })).toEqual(['p95Ms']);
  });

  it('leaves fps and p95 out until a frame interval has been measured, and defaults an unknown tier to medium', () => {
    const out = emptyPanelStats();
    writePanelStats(out, { stats: fresh(), pacing: { ...pacing, samples: 0, p50: 0, p95: 0 }, tier: undefined, otherPasses: 0, now: 1 });
    expect(out.fps).toBeUndefined();
    expect(out.p95Ms).toBeUndefined();
    expect(out.performanceMode).toBe('medium');
  });
});
