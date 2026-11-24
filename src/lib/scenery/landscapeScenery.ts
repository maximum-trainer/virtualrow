/**
 * #764 VP-36 — what the scene takes from a route's #762 land cover: the class
 * mask the ground samples (FR1-FR3) and the treelines on the real woods (FR4).
 * Null when the land-cover layer is unavailable, so the scene is exactly what
 * it was without it (FR9).
 */
import type { PerformanceMode } from './sceneryPlacement';
import type { Landscape, ScenePoint } from '../services/landscapeService';
import { LANDSCAPE_REACH_M } from '../services/landscapeArea';
import { buildLandCoverMask, type LandCoverClassId, type LandCoverMask } from './landCoverMask';
import { TREELINE_BUDGET_MEDIUM, TREELINE_MODEL_ID, planTreelines, type TreelineInstance } from './treelinePlan';

/** FR8 — resident treeline strips per tier, `medium` being the issue's 300. */
export const TREELINE_BUDGET: Record<PerformanceMode, number> = {
  basic: TREELINE_BUDGET_MEDIUM / 4,
  low: TREELINE_BUDGET_MEDIUM / 2,
  medium: TREELINE_BUDGET_MEDIUM,
  high: TREELINE_BUDGET_MEDIUM * 1.5,
  'extra-high': TREELINE_BUDGET_MEDIUM * 2,
};

/** FR10 — `__ROWER3D_SCENERY.landCover`. */
export interface LandCoverSummary {
  classesPresent: LandCoverClassId[];
  woodlandPolygons: number;
  treelineInstances: number;
  hedgeMetres: number;
}

export interface LandscapeScenery {
  landCover: LandCoverMask;
  treelineModelId: typeof TREELINE_MODEL_ID;
  treelines: TreelineInstance[];
  summary: LandCoverSummary;
}

export const landscapeScenery = (
  landscape: Landscape | null | undefined,
  curvePoints: ReadonlyArray<readonly [number, number, number]>,
  tier: PerformanceMode,
  water: ScenePoint[][] = [],
): LandscapeScenery | null => {
  const features = landscape?.landCover.source !== 'unavailable' ? landscape?.landCover.data : null;
  if (!features || curvePoints.length < 2) return null;
  const course: ScenePoint[] = curvePoints.map(([x, , z]) => [x, z]);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of course) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const landCover = buildLandCoverMask({
    bounds: {
      minX: minX - LANDSCAPE_REACH_M,
      minZ: minZ - LANDSCAPE_REACH_M,
      maxX: maxX + LANDSCAPE_REACH_M,
      maxZ: maxZ + LANDSCAPE_REACH_M,
    },
    features,
    water,
  });
  const plan = planTreelines(features, course, TREELINE_BUDGET[tier]);
  return {
    landCover,
    treelineModelId: TREELINE_MODEL_ID,
    treelines: plan.instances,
    summary: {
      classesPresent: landCover.classesPresent,
      woodlandPolygons: plan.woodlandPolygons,
      treelineInstances: plan.instances.length,
      hedgeMetres: Math.round(landCover.hedgeMetres),
    },
  };
};
