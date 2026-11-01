import { describe, expect, it } from 'vitest';
import {
  simplifyPolygon,
  simplifyPolygons,
  simplifyRing,
} from '../lib/renderer/plan/polygonSimplify';
import { signedArea, type Vec2XZ } from '../lib/renderer/plan/waterPolygon';
import { tierCapsFor } from '../lib/renderer/engine/tierCaps';

/**
 * #493 Phase 5 / FR9 / AC7 — per-tier polygon simplification.
 */

const circle = (n: number, r = 100): Vec2XZ[] => {
  const out: Vec2XZ[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push({ x: r * Math.cos(t), z: r * Math.sin(t) });
  }
  return out;
};

describe('simplifyRing', () => {
  it('returns the ring verbatim when already under budget', () => {
    const ring = circle(5);
    expect(simplifyRing(ring, 10)).toBe(ring);
    expect(simplifyRing(ring, 5)).toBe(ring);
  });

  it('returns the ring verbatim for degenerate (<3) inputs', () => {
    const ring: Vec2XZ[] = [{ x: 0, z: 0 }, { x: 1, z: 1 }];
    expect(simplifyRing(ring, 1)).toBe(ring);
  });

  it('reduces to the vertex budget', () => {
    const ring = circle(64);
    const out = simplifyRing(ring, 16);
    expect(out.length).toBe(16);
  });

  it('clamps the budget to a minimum of 3', () => {
    const ring = circle(32);
    const out = simplifyRing(ring, 1);
    expect(out.length).toBe(3);
  });

  it('preserves area within 10 % when halving the vertex count of a circle', () => {
    const ring = circle(64, 100);
    const before = Math.abs(signedArea(ring));
    const out = simplifyRing(ring, 32);
    const after = Math.abs(signedArea(out));
    expect(after).toBeGreaterThan(before * 0.9);
    expect(after).toBeLessThan(before * 1.05);
  });

  it('is deterministic: same input + budget → identical output', () => {
    const ring = circle(50);
    const a = simplifyRing(ring, 20);
    const b = simplifyRing(ring, 20);
    expect(a).toEqual(b);
  });

  it('breaks ties by lowest index (strict less-than, #588 FR4 — kills `area <= worstArea` mutant)', () => {
    // A regular hexagon: every vertex's removal costs the same triangle
    // area. The source comment at polygonSimplify.ts:51 says "Strict
    // less-than keeps the lower index on ties — determinism." StrykerJS
    // flagged `if (area < worstArea)` → `if (area <= worstArea)` as a
    // survivor because no previous test distinguished the two. With
    // strict <, worstIdx sticks at 0 on the first all-equal pass; with
    // ≤ it would walk to the last index. This test fixes the
    // discriminator.
    const ring = circle(6, 10);
    const simplified = simplifyRing(ring, 5);
    expect(simplified.length).toBe(5);
    // Index 0 of the hexagon is at (10, 0). Strict < removes it;
    // ≤ would remove the last vertex (index 5).
    const hadIndexZero = simplified.some(
      (p) => Math.abs(p.x - 10) < 1e-9 && Math.abs(p.z - 0) < 1e-9,
    );
    expect(hadIndexZero, 'the first vertex (10, 0) must be gone — strict <').toBe(false);
  });

  it('drops the near-collinear vertex before the sharp corner on an L-shape with a stub', () => {
    // Square with an extra almost-collinear vertex on the top edge: that
    // vertex has the smallest removal-area and must go first.
    const ring: Vec2XZ[] = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
      { x: 5, z: 10.0001 },
      { x: 0, z: 10 },
    ];
    const out = simplifyRing(ring, 4);
    expect(out.length).toBe(4);
    // The near-collinear point { 5, 10.0001 } should be gone.
    expect(out.find((p) => p.x === 5 && Math.abs(p.z - 10.0001) < 1e-6)).toBeUndefined();
  });
});

describe('simplifyPolygon', () => {
  it('keeps holes verbatim and only simplifies the outer ring', () => {
    const outer = circle(64, 100);
    const holes = [circle(32, 10)];
    const polygon = { outer, holes };
    const out = simplifyPolygon(polygon, 20);
    expect(out.outer.length).toBe(20);
    expect(out.holes).toBe(holes);
    expect(out.holes[0].length).toBe(32);
  });

  it('returns the same reference when nothing needed simplifying', () => {
    const polygon = { outer: circle(8), holes: [] };
    expect(simplifyPolygon(polygon, 32)).toBe(polygon);
  });
});

describe('tierCapsFor.polygonWaterMaxVertices (#493 Phase 5 / FR9)', () => {
  it('tightens monotonically from basic → extra-high', () => {
    const basic = tierCapsFor('basic').polygonWaterMaxVertices;
    const low = tierCapsFor('low').polygonWaterMaxVertices;
    const medium = tierCapsFor('medium').polygonWaterMaxVertices;
    const high = tierCapsFor('high').polygonWaterMaxVertices;
    const extraHigh = tierCapsFor('extra-high').polygonWaterMaxVertices;
    expect(basic).toBeLessThan(low);
    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThan(high);
    expect(high).toBeLessThan(extraHigh);
    // basic still bounds enough shape to read as a lake, not a diamond.
    expect(basic).toBeGreaterThanOrEqual(128);
  });

  it('falls back to the default tier for an unknown string', () => {
    expect(tierCapsFor('mystery').polygonWaterMaxVertices).toBe(
      tierCapsFor(undefined).polygonWaterMaxVertices,
    );
  });
});

describe('simplifyPolygons', () => {
  it('returns the same array reference when every polygon was unchanged', () => {
    const polys = [{ outer: circle(5), holes: [] }, { outer: circle(6), holes: [] }];
    expect(simplifyPolygons(polys, 32)).toBe(polys);
  });

  it('returns a new array when any polygon was simplified', () => {
    const polys = [{ outer: circle(5), holes: [] }, { outer: circle(80), holes: [] }];
    const out = simplifyPolygons(polys, 32);
    expect(out).not.toBe(polys);
    expect(out[0].outer.length).toBe(5);
    expect(out[1].outer.length).toBe(32);
  });
});
