// #737 VP-19 FR2 — render stats are this frame's; cumulative counts live in total* fields.
import { describe, expect, it } from 'vitest';
import { assembleRenderStats, emptyRenderGroups, type FrameRenderInputs } from '../frameRenderStats';
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
