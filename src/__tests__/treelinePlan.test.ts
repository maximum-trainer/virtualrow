import { describe, expect, it } from 'vitest';
import { TREELINE_STRIP_M, planTreelines, signedArea } from '../lib/scenery/treelinePlan';
import type { LandCoverFeature, ScenePoint } from '../lib/services/landscapeService';

const square = (cx: number, cz: number, half: number, clockwise = false): ScenePoint[] => {
  const ring: ScenePoint[] = [
    [cx - half, cz - half],
    [cx + half, cz - half],
    [cx + half, cz + half],
    [cx - half, cz + half],
  ];
  if (clockwise) ring.reverse();
  return [...ring, ring[0]];
};
/** A straight north-south course through the origin, 4 km long. */
const COURSE: ScenePoint[] = Array.from({ length: 41 }, (_, i) => [0, -2000 + i * 100]);
const wood = (points: ScenePoint[], kind: LandCoverFeature['kind'] = 'wood'): LandCoverFeature => ({
  kind,
  shape: 'polygon',
  points,
});

describe('planTreelines (#764 FR4)', () => {
  it('lines the western edge of a wood 500 m east of the course, and nothing else (AC)', () => {
    for (const clockwise of [false, true]) {
      const plan = planTreelines([wood(square(500, 0, 150, clockwise))], COURSE);
      expect(plan.woodlandPolygons).toBe(1);
      // A 300 m edge takes three 100 m strips, end to end.
      expect(plan.instances).toHaveLength(3);
      for (const strip of plan.instances) {
        expect(Math.abs(strip.x - 350)).toBeLessThanOrEqual(10);
        expect(strip.z).toBeGreaterThanOrEqual(-150);
        expect(strip.z).toBeLessThanOrEqual(150);
        // Running north-south: local +X along ±Z.
        expect(Math.abs(Math.cos(strip.yaw))).toBeLessThan(1e-6);
        expect(strip.distance).toBeCloseTo(353, 0);
      }
      const zs = plan.instances.map((s) => s.z).sort((a, b) => a - b);
      expect(zs[1] - zs[0]).toBeCloseTo(TREELINE_STRIP_M, 0);
    }
  });

  it('keeps a small wood near the course and drops one far away', () => {
    const near = wood(square(300, 0, 20));
    const far = wood(square(900, 0, 20));
    const plan = planTreelines([near, far], COURSE);
    expect(plan.woodlandPolygons).toBe(2);
    expect(plan.instances.every((s) => s.x < 400)).toBe(true);
    expect(plan.instances.length).toBeGreaterThan(0);
  });

  it('places nothing beyond the landscape reach, for other land cover, or without a course', () => {
    expect(planTreelines([wood(square(3000, 0, 300))], COURSE).instances).toHaveLength(0);
    expect(planTreelines([wood(square(500, 0, 150), 'meadow')], COURSE).woodlandPolygons).toBe(0);
    expect(planTreelines([wood(square(500, 0, 150))], []).instances).toHaveLength(0);
    expect(planTreelines([wood([[0, 0], [1, 0], [0, 0]])], COURSE).instances).toHaveLength(0);
  });

  it('lines every edge of a wood the course runs round, with the chain wrapping the first vertex', () => {
    // A lap round a 600 m square wood.
    const lap: ScenePoint[] = [
      [-500, -500],
      [500, -500],
      [500, 500],
      [-500, 500],
      [-500, -500],
    ];
    const plan = planTreelines([wood(square(0, 0, 300))], lap, 1000);
    expect(plan.instances).toHaveLength(24);
  });

  it('keeps the nearest strips when the budget is short', () => {
    const plan = planTreelines([wood(square(400, 0, 150)), wood(square(-1200, 0, 150))], COURSE, 3);
    expect(plan.instances).toHaveLength(3);
    expect(plan.instances.every((s) => s.x > 0)).toBe(true);
  });

  it('measures signed area by winding', () => {
    expect(signedArea(square(0, 0, 1).slice(0, -1))).toBeCloseTo(4);
    expect(signedArea(square(0, 0, 1, true).slice(0, -1))).toBeCloseTo(-4);
  });
});
