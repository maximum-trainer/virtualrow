import { afterEach, describe, it, expect } from 'vitest';

import { WATER_SURFACE_Y } from '../lib/renderer/plan/waterStrip';
import {
  buildPolygonWater,
  clipPolygonToDisc,
  earClip,
  signedArea,
  type Vec2XZ,
} from '../lib/renderer/plan/waterPolygon';
import { isPolygonWaterEnabled } from '../lib/renderer/engine/polygonWater';

/**
 * #493 Phase 3 unit coverage for the polygon-water geometry builder:
 * AC14 (flat water Y), the ear-clipping core, hole handling, and the
 * disc clip Phase 3b feeds the pass per frame.
 */

const square: Vec2XZ[] = [
  { x: 0, z: 0 },
  { x: 10, z: 0 },
  { x: 10, z: 10 },
  { x: 0, z: 10 },
];

describe('signedArea', () => {
  it('is positive for a CCW ring in XZ', () => {
    expect(signedArea(square)).toBeCloseTo(100, 5);
  });

  it('is negative for a CW ring', () => {
    expect(signedArea([...square].reverse())).toBeCloseTo(-100, 5);
  });
});

describe('earClip (simple polygons)', () => {
  it('triangulates a square into two triangles', () => {
    const tris = earClip(square);
    expect(tris.length).toBe(6);
  });

  it('triangulates a concave L-shape without overlap (area sum = L area)', () => {
    const L: Vec2XZ[] = [
      { x: 0, z: 0 },
      { x: 4, z: 0 },
      { x: 4, z: 2 },
      { x: 2, z: 2 },
      { x: 2, z: 4 },
      { x: 0, z: 4 },
    ];
    const tris = earClip(L);
    expect(tris.length % 3).toBe(0);
    let areaSum = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const a = L[tris[i]];
      const b = L[tris[i + 1]];
      const c = L[tris[i + 2]];
      areaSum += 0.5 * ((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    }
    expect(areaSum).toBeCloseTo(12, 2);
  });

  it('triangulates a convex pentagon exactly (n-2 triangles)', () => {
    const pent: Vec2XZ[] = [
      { x: 0, z: 0 },
      { x: 4, z: 0 },
      { x: 5, z: 3 },
      { x: 2, z: 5 },
      { x: -1, z: 3 },
    ];
    const tris = earClip(pent);
    expect(tris.length).toBe(9); // 3 triangles × 3 indices
    let areaSum = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const a = pent[tris[i]];
      const b = pent[tris[i + 1]];
      const c = pent[tris[i + 2]];
      areaSum += 0.5 * ((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    }
    // Expected pentagon area via shoelace.
    expect(areaSum).toBeCloseTo(Math.abs(signedArea(pent)), 2);
  });
});

describe('buildPolygonWater (AC14: flat Y)', () => {
  // Float32Array truncates, so the AC14 check tolerates the ~1e-7 of
  // precision loss against the WATER_SURFACE_Y literal (-0.1 in f32 ≈
  // -0.1000000014…). Still asserts "exactly one Y" across the mesh.
  it('emits every vertex at WATER_SURFACE_Y', () => {
    const { positions } = buildPolygonWater({ outer: square, holes: [] });
    expect(positions.length).toBe(square.length * 3);
    const ys = new Set<number>();
    for (let i = 0; i < positions.length; i += 3) {
      expect(positions[i + 1]).toBeCloseTo(WATER_SURFACE_Y, 6);
      ys.add(positions[i + 1]);
    }
    expect(ys.size).toBe(1);
  });

  it('still flat with holes (every island vertex also at WATER_SURFACE_Y)', () => {
    const island: Vec2XZ[] = [
      { x: 4, z: 4 },
      { x: 4, z: 6 },
      { x: 6, z: 6 },
      { x: 6, z: 4 },
    ]; // CW
    const { positions, indices } = buildPolygonWater({ outer: square, holes: [island] });
    expect(positions.length).toBeGreaterThan(0);
    const ys = new Set<number>();
    for (let i = 0; i < positions.length; i += 3) {
      expect(positions[i + 1]).toBeCloseTo(WATER_SURFACE_Y, 6);
      ys.add(positions[i + 1]);
    }
    expect(ys.size).toBe(1);
    // Something was triangulated.
    expect(indices.length).toBeGreaterThan(0);
  });

  it('normalises a CW outer ring and still produces triangles', () => {
    const cw = [...square].reverse();
    const { indices } = buildPolygonWater({ outer: cw, holes: [] });
    expect(indices.length).toBe(6);
  });

  it('returns an empty mesh for a degenerate ring', () => {
    const degenerate: Vec2XZ[] = [{ x: 0, z: 0 }, { x: 1, z: 1 }];
    const { positions, indices } = buildPolygonWater({ outer: degenerate, holes: [] });
    expect(positions.length).toBe(0);
    expect(indices.length).toBe(0);
  });

  it('every emitted triangle index references a valid position vertex', () => {
    const island: Vec2XZ[] = [
      { x: 3, z: 3 },
      { x: 3, z: 5 },
      { x: 5, z: 5 },
      { x: 5, z: 3 },
    ].reverse(); // CW
    const { positions, indices } = buildPolygonWater({ outer: square, holes: [island] });
    const vertexCount = positions.length / 3;
    for (let i = 0; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThanOrEqual(0);
      expect(indices[i]).toBeLessThan(vertexCount);
    }
  });
});

describe('clipPolygonToDisc (FR7 / D8c)', () => {
  it('leaves a polygon fully inside the disc almost unchanged', () => {
    const small: Vec2XZ[] = [
      { x: -1, z: -1 },
      { x: 1, z: -1 },
      { x: 1, z: 1 },
      { x: -1, z: 1 },
    ];
    // Disc covers it generously.
    const clipped = clipPolygonToDisc(small, 0, 0, 50);
    // Area is preserved to within the 32-gon approximation of the circle.
    expect(Math.abs(signedArea(clipped))).toBeCloseTo(4, 1);
  });

  it('empties a polygon entirely outside the disc', () => {
    const far: Vec2XZ[] = [
      { x: 100, z: 100 },
      { x: 110, z: 100 },
      { x: 110, z: 110 },
      { x: 100, z: 110 },
    ];
    const clipped = clipPolygonToDisc(far, 0, 0, 20);
    expect(clipped.length).toBe(0);
  });

  it('shrinks a large polygon to roughly the disc area (~ π r²)', () => {
    const big: Vec2XZ[] = [
      { x: -100, z: -100 },
      { x: 100, z: -100 },
      { x: 100, z: 100 },
      { x: -100, z: 100 },
    ];
    const clipped = clipPolygonToDisc(big, 0, 0, 10, 64);
    // 64 segments approximate the circle to <1 % area error.
    const expected = Math.PI * 10 * 10;
    expect(Math.abs(signedArea(clipped))).toBeGreaterThan(expected * 0.98);
    expect(Math.abs(signedArea(clipped))).toBeLessThan(expected * 1.02);
  });
});

describe('isPolygonWaterEnabled (AC13 kill switch, #493 Phase 4 default-on)', () => {
  afterEach(() => {
    delete (window as unknown as { __VIRTUALROW_POLYGON_WATER?: boolean })
      .__VIRTUALROW_POLYGON_WATER;
  });

  it('is on when nothing is set (new Phase 4 default)', () => {
    delete (window as unknown as { __VIRTUALROW_POLYGON_WATER?: boolean })
      .__VIRTUALROW_POLYGON_WATER;
    expect(isPolygonWaterEnabled()).toBe(true);
  });

  it('is on with the explicit opt-in flag', () => {
    (window as unknown as { __VIRTUALROW_POLYGON_WATER?: boolean })
      .__VIRTUALROW_POLYGON_WATER = true;
    expect(isPolygonWaterEnabled()).toBe(true);
  });

  it('is off when the kill switch is explicitly false', () => {
    (window as unknown as { __VIRTUALROW_POLYGON_WATER?: boolean })
      .__VIRTUALROW_POLYGON_WATER = false;
    expect(isPolygonWaterEnabled()).toBe(false);
  });
});
