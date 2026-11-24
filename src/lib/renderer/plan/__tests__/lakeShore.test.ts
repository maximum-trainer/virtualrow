// #745 VP-25 FR2 — a drawn lake has a shore. Ported in intent from the React
// scene's `lakeGeometry.test.ts` ("lake shore and islands", FR5/FR6 of #493).
import { describe, expect, it } from 'vitest';
import { buildLakeShore, LAKE_SHORE_WIDTH_METRES } from '../lakeShore';
import { BANK_LIFT_METRES } from '../bankStrip';
import { WATER_SURFACE_Y } from '../waterStrip';
import { lakeWater, type LakeOutline } from '../waterFootprint';

const square = (x0: number, z0: number, x1: number, z1: number) => [
  { x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 },
];
// 400 m square of water around the origin, with a 40 m island at (100, 100).
const lake: LakeOutline = { outer: square(-200, -200, 200, 200), holes: [square(80, 80, 120, 120)] };

type Tri = [[number, number, number], [number, number, number], [number, number, number]];
const triangles = (g: ReturnType<typeof buildLakeShore>): Tri[] => {
  const v = (i: number): [number, number, number] => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
  const out: Tri[] = [];
  for (let t = 0; t < g.indices.length; t += 3) out.push([v(g.indices[t]), v(g.indices[t + 1]), v(g.indices[t + 2])]);
  return out;
};
const covers = (g: ReturnType<typeof buildLakeShore>, x: number, z: number) =>
  triangles(g).some(([a, b, c]) => {
    const side = (p: number[], q: number[]) => (q[0] - p[0]) * (z - p[2]) - (q[2] - p[2]) * (x - p[0]);
    const [d1, d2, d3] = [side(a, b), side(b, c), side(c, a)];
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  });

describe('lake shore (#745 FR2)', () => {
  const shore = buildLakeShore([lake]);

  it('runs out from the waterline away from the water, at the bank height, facing the sky', () => {
    for (let i = 1; i < shore.positions.length; i += 3) expect(shore.positions[i]).toBeCloseTo(WATER_SURFACE_Y + BANK_LIFT_METRES, 6);
    for (const [a, b, c] of triangles(shore)) {
      const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      expect(ny).toBeGreaterThan(0);
    }
    let maxX = -Infinity;
    for (let i = 0; i < shore.positions.length; i += 3) maxX = Math.max(maxX, shore.positions[i]);
    expect(maxX).toBeCloseTo(200 + LAKE_SHORE_WIDTH_METRES * Math.SQRT2 * Math.SQRT1_2, 0);
    expect(covers(shore, 0, 0)).toBe(false);
    expect(covers(shore, 215, 0)).toBe(true);
    expect(covers(shore, 0, -215)).toBe(true);
  });

  it('draws the island\'s shore inside it, narrowed so the island keeps a middle', () => {
    expect(covers(shore, 85, 100)).toBe(true);
    expect(covers(shore, 100, 100)).toBe(false);
    expect(covers(shore, 75, 100)).toBe(false);
  });

  it('carries the bank\'s shore distance: 0 at the water, the band width at its edge', () => {
    const d = [...shore.sides].filter((_, i) => i % 2 === 1);
    expect(Math.min(...d)).toBe(0);
    expect(Math.max(...d)).toBe(LAKE_SHORE_WIDTH_METRES);
    expect([...shore.sides].filter((_, i) => i % 2 === 0).every((s) => s === 0)).toBe(true);
  });

  it('opens where the route\'s ribbon runs out of the lake (React `ribbonClearings`)', () => {
    // A 40 m ribbon leaving the lake eastward along z = 0.
    const ribbon = (x: number, z: number) => x > 150 && Math.abs(z) < 20;
    const inLake = lakeWater([lake])!;
    const opened = buildLakeShore([lake], { onWater: (x, z) => ribbon(x, z) || inLake(x, z) });
    expect(covers(opened, 215, 0)).toBe(false);
    expect(covers(opened, 215, 100)).toBe(true);
  });

  it('builds nothing from no lake, and finite vertices for a degenerate ring', () => {
    expect(buildLakeShore([]).indices.length).toBe(0);
    const g = buildLakeShore([{ outer: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }], holes: [] }]);
    expect([...g.positions].every(Number.isFinite)).toBe(true);
  });
});
