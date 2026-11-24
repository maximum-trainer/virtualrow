import { describe, expect, it } from 'vitest';
import { TREELINE_BUDGET, landscapeScenery } from '../lib/scenery/landscapeScenery';
import { LandCoverClass, classAt } from '../lib/scenery/landCoverMask';
import type { LandCoverFeature, Landscape, ScenePoint } from '../lib/services/landscapeService';

const square = (cx: number, cz: number, half: number): ScenePoint[] => [
  [cx - half, cz - half],
  [cx + half, cz - half],
  [cx + half, cz + half],
  [cx - half, cz + half],
  [cx - half, cz - half],
];
const CURVE: [number, number, number][] = Array.from({ length: 41 }, (_, i) => [0, 0, -2000 + i * 100]);
const landscape = (features: LandCoverFeature[] | null, source: 'network' | 'unavailable' = 'network'): Landscape => ({
  origin: { lat: 0, lng: 0 },
  key: 'k',
  elevation: { source: 'unavailable', ms: 0, count: 0, data: null },
  landCover: { source, ms: 0, count: features?.length ?? 0, data: features },
  built: { source: 'unavailable', ms: 0, count: 0, data: null },
});

describe('landscapeScenery (#764)', () => {
  it('leaves the scene as it was without land-cover data (FR9)', () => {
    expect(landscapeScenery(null, CURVE, 'medium')).toBeNull();
    expect(landscapeScenery(landscape(null, 'unavailable'), CURVE, 'medium')).toBeNull();
    expect(landscapeScenery(landscape([]), CURVE.slice(0, 1), 'medium')).toBeNull();
  });

  it('builds the mask over the course plus 2 km, lines the wood, and summarises (FR1, FR4, FR10)', () => {
    const features: LandCoverFeature[] = [
      { kind: 'wood', shape: 'polygon', points: square(500, 0, 150) },
      { kind: 'residential', shape: 'polygon', points: square(-400, 0, 200) },
      { kind: 'hedge', shape: 'line', points: [[-1000, 500], [-1000, 900]] },
    ];
    const out = landscapeScenery(landscape(features), CURVE, 'medium', [square(0, 0, 20)])!;
    expect(out.landCover.originX).toBe(-2000);
    expect(out.landCover.originZ).toBe(-4000);
    expect(classAt(out.landCover, 500, 0)).toBe(LandCoverClass.woodland);
    expect(classAt(out.landCover, -400, 0)).toBe(LandCoverClass.built);
    expect(classAt(out.landCover, 0, 0)).toBe(LandCoverClass.water);
    expect(out.treelineModelId).toBe('f45-treeline-strip');
    expect(out.treelines).toHaveLength(3);
    expect(out.summary).toEqual({
      classesPresent: [LandCoverClass.woodland, LandCoverClass.built, LandCoverClass.water, LandCoverClass.hedge],
      woodlandPolygons: 1,
      treelineInstances: 3,
      hedgeMetres: 400,
    });
  });

  it('caps treelines by tier, 300 at medium (FR8)', () => {
    expect(TREELINE_BUDGET.medium).toBe(300);
    expect(TREELINE_BUDGET.basic).toBeLessThan(TREELINE_BUDGET.low);
    expect(TREELINE_BUDGET['extra-high']).toBeGreaterThan(TREELINE_BUDGET.high);
    // Two long woods, one each side: 38 strips apiece, 76 in all.
    const strip = (x0: number, x1: number): LandCoverFeature => ({
      kind: 'forest',
      shape: 'polygon',
      points: [[x0, -1900], [x1, -1900], [x1, 1900], [x0, 1900], [x0, -1900]],
    });
    const woods = [strip(300, 600), strip(-600, -300)];
    expect(landscapeScenery(landscape(woods), CURVE, 'medium')!.treelines).toHaveLength(76);
    expect(landscapeScenery(landscape(woods), CURVE, 'basic')!.treelines).toHaveLength(TREELINE_BUDGET.basic);
  });
});
