import { describe, expect, it } from 'vitest';
import {
  LEAF_TYPE_MODELS,
  WOODLAND_TREE_BUDGET,
  WOODLAND_TREE_CLEAR_M,
  WOODLAND_TREE_REACH_M,
  planWoodlandTrees,
} from '../lib/scenery/woodlandTreePlan';
import type { LandCoverFeature, ScenePoint } from '../lib/services/landscapeService';

const COURSE: ScenePoint[] = [[0, 2000], [0, -2000]];
const rect = (x0: number, x1: number, z0: number, z1: number): ScenePoint[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
const wood = (points: ScenePoint[], extra: Partial<LandCoverFeature> = {}): LandCoverFeature => ({ kind: 'wood', shape: 'polygon', points, ...extra });
const plan = (features: LandCoverFeature[], over: Partial<Parameters<typeof planWoodlandTrees>[0]> = {}) =>
  planWoodlandTrees({ features, course: COURSE, density: 0.5, regionTrees: ['e04-english-oak'], max: 10_000, ...over });

describe('planWoodlandTrees (#764 FR5)', () => {
  it('fills a wood inside its outline, out to 400 m from the course and no nearer than the bank', () => {
    const trees = plan([wood(rect(20, 800, -200, 200))]);
    expect(trees.length).toBeGreaterThan(100);
    for (const t of trees) {
      expect(t.x).toBeGreaterThanOrEqual(20);
      expect(t.x).toBeLessThanOrEqual(WOODLAND_TREE_REACH_M);
      expect(t.x).toBeGreaterThanOrEqual(WOODLAND_TREE_CLEAR_M);
      expect(Math.abs(t.z)).toBeLessThanOrEqual(200);
    }
    // Nearest first.
    expect(trees[0].distance).toBeLessThanOrEqual(trees[trees.length - 1].distance);
  });

  it('plants at the profile density', () => {
    const sparse = plan([wood(rect(100, 300, -200, 200))], { density: 0.1 }).length;
    const dense = plan([wood(rect(100, 300, -200, 200))], { density: 0.9 }).length;
    expect(dense / sparse).toBeGreaterThan(6);
    expect(dense / sparse).toBeLessThan(12);
  });

  it('takes species from the leaf type, else the region', () => {
    const conifers = plan([wood(rect(100, 300, -100, 100), { leafType: 'needleleaved' })]);
    expect(new Set(conifers.map((t) => t.id)).size).toBeGreaterThan(0);
    for (const t of conifers) expect(LEAF_TYPE_MODELS.needleleaved).toContain(t.id);
    const region = plan([wood(rect(100, 300, -100, 100))]);
    expect(new Set(region.map((t) => t.id))).toEqual(new Set(['e04-english-oak']));
    const none = plan([wood(rect(100, 300, -100, 100))], { regionTrees: [] });
    for (const t of none) expect(LEAF_TYPE_MODELS.mixed).toContain(t.id);
  });

  it('plants the same trees whatever else is on the map, and skips what is not a wood', () => {
    const alone = plan([wood(rect(100, 300, -100, 100))]);
    const withOthers = plan([
      { kind: 'farmland', shape: 'polygon', points: rect(-500, -100, -100, 100) },
      { kind: 'wood', shape: 'line', points: [[100, 0], [200, 0]] },
      wood(rect(100, 300, -100, 100)),
      wood(rect(2000, 2200, -100, 100)),
    ]);
    expect(withOthers).toEqual(alone);
  });

  it('holds the budget, nearest first, and none at basic or with no course', () => {
    const all = plan([wood(rect(50, 400, -1000, 1000))]);
    const capped = plan([wood(rect(50, 400, -1000, 1000))], { max: 20 });
    expect(capped).toEqual(all.slice(0, 20));
    expect(WOODLAND_TREE_BUDGET.basic).toBe(0);
    expect(plan([wood(rect(50, 400, -100, 100))], { max: WOODLAND_TREE_BUDGET.basic })).toEqual([]);
    expect(plan([wood(rect(50, 400, -100, 100))], { course: COURSE.slice(0, 1) })).toEqual([]);
    expect(plan([wood(rect(50, 400, -100, 100))], { density: 0 })).toEqual([]);
  });
});
