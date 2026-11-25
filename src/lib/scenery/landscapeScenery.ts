/**
 * #764 VP-36 — what the scene takes from a route's #762 land cover: the class
 * mask the ground samples (FR1-FR3) and the treelines on the real woods (FR4).
 * Null when the land-cover layer is unavailable, so the scene is exactly what
 * it was without it (FR9).
 */
import type { PerformanceMode } from './sceneryPlacement';
import type { Landscape, ScenePoint } from '../services/landscapeService';
import { LANDSCAPE_REACH_M } from '../services/landscapeArea';
import { buildLandCoverMask, seawardOfCoast, type LandCoverClassId, type LandCoverMask } from './landCoverMask';
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
  /** #885 FR3 — kit trees planted inside the real woods (#764 FR5); set by the route builder. */
  woodlandTrees: number;
  /** #885 FR3 — the class mask's upload size, held to 4 MB. */
  maskBytes: number;
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
      woodlandTrees: 0,
      maskBytes: landCover.data.byteLength,
    },
  };
};

/** FR6 — how far either side of the course the coast test looks. */
export const COAST_PROBE_M = 300;
/** The share of stations that must agree before a course counts as coastal. */
const COAST_AGREEMENT = 2 / 3;

/**
 * FR6 — which bank is land on a sea course, from the map's coastline: at each
 * course point, the sea lies `COAST_PROBE_M` off one side and not the other.
 * Undefined with no coastline, or when the course has land (or sea) on both
 * sides for much of its length, as in an estuary.
 */
export const coastLandSide = (
  landscape: Landscape | null | undefined,
  curvePoints: ReadonlyArray<readonly [number, number, number]>,
): 'left' | 'right' | undefined => {
  const features = landscape?.landCover.source !== 'unavailable' ? landscape?.landCover.data : null;
  if (!features || curvePoints.length < 2 || !features.some((f) => f.kind === 'coastline')) return undefined;
  let seaLeft = 0;
  let seaRight = 0;
  let stations = 0;
  for (let k = 0; k < curvePoints.length; k += 1) {
    const [ax, , az] = curvePoints[Math.max(0, k - 1)];
    const [bx, , bz] = curvePoints[Math.min(curvePoints.length - 1, k + 1)];
    const len = Math.hypot(bx - ax, bz - az);
    if (len === 0) continue;
    const tx = (bx - ax) / len;
    const tz = (bz - az) / len;
    const [x, , z] = curvePoints[k];
    // The left bank is where the bank strip's perp (−tz, tx) is negative.
    const left = seawardOfCoast(features, x + tz * COAST_PROBE_M, z - tx * COAST_PROBE_M);
    const right = seawardOfCoast(features, x - tz * COAST_PROBE_M, z + tx * COAST_PROBE_M);
    stations += 1;
    if (left && !right) seaLeft += 1;
    if (right && !left) seaRight += 1;
  }
  if (stations === 0) return undefined;
  if (seaLeft >= stations * COAST_AGREEMENT) return 'right';
  if (seaRight >= stations * COAST_AGREEMENT) return 'left';
  return undefined;
};
