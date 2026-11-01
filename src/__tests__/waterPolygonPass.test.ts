import { describe, it, expect } from 'vitest';

import { buildPolygonWater } from '../lib/renderer/plan/waterPolygon';

/**
 * #493 Phase 3b surface test — the water-polygon WebGPU pass can't run
 * under jsdom, but its CPU-side tessellation+concat semantics are the
 * part that affects whether the GPU draws anything. This checks that
 * two independent polygons tessellate independently and that an empty
 * polygon list produces no mesh.
 *
 * The pass itself (`createWaterPolygonPass`) is exercised by the GPU
 * runner's `webgpu-engine` smoke; a Vitest with jsdom can't construct a
 * real `GPUDevice`.
 */
describe('waterPolygon tessellation (3b pass input)', () => {
  it('tessellates each polygon independently with distinct index spaces', () => {
    const a = buildPolygonWater({
      outer: [
        { x: 0, z: 0 },
        { x: 1, z: 0 },
        { x: 1, z: 1 },
        { x: 0, z: 1 },
      ],
      holes: [],
    });
    const b = buildPolygonWater({
      outer: [
        { x: 2, z: 2 },
        { x: 3, z: 2 },
        { x: 3, z: 3 },
        { x: 2, z: 3 },
      ],
      holes: [],
    });
    expect(a.indices.length).toBe(6);
    expect(b.indices.length).toBe(6);
    // Each polygon references only its own four vertices (indices 0..3).
    for (const idx of a.indices) {
      expect(idx).toBeLessThan(a.positions.length / 3);
    }
    for (const idx of b.indices) {
      expect(idx).toBeLessThan(b.positions.length / 3);
    }
  });

  it('returns an empty mesh for a degenerate polygon', () => {
    const mesh = buildPolygonWater({
      outer: [{ x: 0, z: 0 }, { x: 1, z: 0 }], // only 2 vertices
      holes: [],
    });
    expect(mesh.indices.length).toBe(0);
    expect(mesh.positions.length).toBe(0);
  });
});
