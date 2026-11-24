/**
 * #765 VP-37 — buildings, town skylines and landmarks from the #762 built
 * form, out to the horizon.
 *
 * Pure. FR1 three distance bands from the course: near (to 600 m) every real
 * footprint, mid (to 1,200 m) only the big or tall ones, far none. FR3
 * `f47-skyline-strip` along the course-facing edge of each settlement beyond
 * the near band. FR4 landmarks at their real place and height from the
 * nearest kit model. FR5 skylines and landmarks stand on the drawn hills.
 * FR7 nothing on the water. The building budget and its ranking by apparent
 * size (FR2) are the engine's, over every building it is handed.
 */
import type { BuildingProfile, BuildingSpec } from '../renderer/plan/buildings';
import type {
  BuiltForm,
  BuiltFootprint,
  ElevationGrid,
  LandCoverFeature,
  LandmarkKind,
  PlaceKind,
  ScenePoint,
} from '../services/landscapeService';
import { LANDSCAPE_REACH_M } from '../services/landscapeArea';
import { LandCoverClass, classAt, type LandCoverMask } from './landCoverMask';
import { heightAt, landformSurfaceAt, type ReliefPlacement } from './horizonRelief';
import { nearestOnCourse, signedArea, stripsOnFacingEdges } from './treelinePlan';

/** FR1 — the near band: every real footprint. */
export const BUILT_NEAR_M = 600;
/** FR1 — the mid band: only buildings over `MID_MIN_HEIGHT_M` tall or `MID_MIN_AREA_M2` in plan. */
export const BUILT_MID_M = 1200;
export const MID_MIN_HEIGHT_M = 12;
export const MID_MIN_AREA_M2 = 600;
/** FR7 — nothing built stands nearer the course line than this. */
export const BUILT_WATER_CLEAR_M = 30;
/** A footprint smaller than this is not worth a prism. */
const MIN_FOOTPRINT_M2 = 4;

export const SKYLINE_MODEL_ID = 'f47-skyline-strip';
/** The strip's authored size: 100 m long (local X), 20 m deep. */
const SKYLINE_STRIP_M = 100;
const SKYLINE_DEPTH_M = 20;
/** FR3 — skyline height by settlement. */
export const SKYLINE_SCALE: Record<PlaceKind, number> = { hamlet: 1, village: 1, town: 1.5, city: 2.5 };
/** FR3 — strips a place with no built-up outline gets, centred on it. */
const SKYLINE_STRIPS_FOR_PLACE: Record<PlaceKind, number> = { hamlet: 0, village: 1, town: 3, city: 5 };
/** A built-up area takes the settlement kind of a place this near its outline. */
const PLACE_REACH_M = 1500;
const BUILT_UP = new Set(['residential', 'industrial', 'commercial', 'retail']);

/** FR4 — the kit model each landmark kind is drawn with, and that model's height. */
export const LANDMARK_MODELS: Record<LandmarkKind, { id: string; top: number; defaultHeight: number }> = {
  tower: { id: 'g10-observation-tower', top: 34, defaultHeight: 30 },
  // No chimney or mast in the kit yet: the nearest shapes stand in (#449).
  chimney: { id: 'g10-observation-tower', top: 34, defaultHeight: 60 },
  mast: { id: 'f40-pylon-lattice', top: 40, defaultHeight: 80 },
  lighthouse: { id: 'g07-lighthouse-harbour', top: 15, defaultHeight: 20 },
  water_tower: { id: 'g11-water-tower-masonry', top: 34, defaultHeight: 30 },
  church: { id: 'd-gb-02-church-square-tower', top: 24, defaultHeight: 30 },
  cathedral: { id: 'd-gb-02-church-square-tower', top: 24, defaultHeight: 60 },
  power_tower: { id: 'f40-pylon-lattice', top: 40, defaultHeight: 40 },
  wind_turbine: { id: 'd-nl-05-wind-turbine', top: 130, defaultHeight: 130 },
  tall: { id: 'g01-skyscraper-tower', top: 90, defaultHeight: 40 },
};

/** FR1 — a building's height when OSM gives neither `height` nor levels. */
const DEFAULT_HEIGHT_M: Record<string, number> = {
  house: 6,
  detached: 6,
  semidetached_house: 6,
  terrace: 8,
  residential: 9,
  apartments: 15,
  commercial: 12,
  retail: 8,
  office: 15,
  industrial: 10,
  warehouse: 10,
  church: 15,
  cathedral: 30,
  school: 9,
  garage: 3,
  shed: 3,
};
const FALLBACK_HEIGHT_M = 6;

export interface SkylineInstance {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  distance: number;
}

export interface LandmarkInstance {
  id: string;
  kind: LandmarkKind;
  x: number;
  y: number;
  z: number;
  scale: number;
  /** The height it stands for, metres. */
  height: number;
  distance: number;
}

export interface BuiltFormPlan {
  buildings: BuildingSpec[];
  skylines: SkylineInstance[];
  landmarks: LandmarkInstance[];
  /** FR10 — `__ROWER3D_BUILDINGS`. */
  summary: { near: number; mid: number; skylineInstances: number; landmarks: number };
}

export interface BuiltFormInput {
  built: BuiltForm | null | undefined;
  course: readonly ScenePoint[];
  /** #764's land-cover features: the built-up outlines skylines stand along. */
  landCover?: readonly LandCoverFeature[] | null;
  mask?: LandCoverMask | null;
  water?: readonly ScenePoint[][];
  /** FR5 — #763's grid and the landforms drawn from it. */
  grid?: ElevationGrid | null;
  relief?: readonly ReliefPlacement[];
  maxSkylines: number;
  maxLandmarks: number;
}

const profileFor = (kind: string): BuildingProfile =>
  kind === 'commercial' || kind === 'retail' || kind === 'office'
    ? 'commercial'
    : kind === 'house' || kind === 'residential' || kind === 'apartments' || kind === 'detached' || kind === 'terrace'
      ? 'residential'
      : kind === 'industrial' || kind === 'warehouse'
        ? 'industrial'
        : 'fallback';

const openRing = (ring: readonly ScenePoint[]): ScenePoint[] => {
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  return closed ? ring.slice(0, -1) : [...ring];
};

const insideRing = (ring: readonly ScenePoint[], x: number, z: number): boolean => {
  let inside = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xa, za] = ring[a];
    const [xb, zb] = ring[b];
    if (za > z !== zb > z && x < xa + ((z - za) * (xb - xa)) / (zb - za)) inside = !inside;
  }
  return inside;
};

/** FR1 — a footprint as the engine's prism, with its plan area; null when too small. */
export const footprintToSpec = (fp: BuiltFootprint): { spec: BuildingSpec; areaM2: number } | null => {
  const open = openRing(fp.points);
  if (open.length < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of open) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const areaM2 = Math.abs(signedArea(open));
  if (areaM2 < MIN_FOOTPRINT_M2) return null;
  return {
    spec: {
      x: (minX + maxX) / 2,
      z: (minZ + maxZ) / 2,
      halfWidth: (maxX - minX) / 2,
      halfDepth: (maxZ - minZ) / 2,
      height: fp.heightM ?? DEFAULT_HEIGHT_M[fp.kind] ?? FALLBACK_HEIGHT_M,
      profile: profileFor(fp.kind),
    },
    areaM2,
  };
};

export const planBuiltForm = (input: BuiltFormInput): BuiltFormPlan | null => {
  const { built, landCover = null, mask = null, water = [], grid = null, relief = [] } = input;
  const course = [...input.course];
  if (!built || course.length < 2) return null;

  const wet = (x: number, z: number, clear: number): boolean =>
    nearestOnCourse(course, x, z).distance < clear ||
    water.some((ring) => insideRing(ring, x, z)) ||
    (mask !== null && [LandCoverClass.water, LandCoverClass.sea].includes(classAt(mask, x, z) as 9 | 11));
  // FR5 — raised to the terrain, but never above the landform drawn there.
  const standOn = (x: number, z: number): number => {
    if (!grid) return 0;
    const h = heightAt(grid, x, z);
    return Number.isFinite(h) ? Math.max(0, Math.min(h, landformSurfaceAt(relief, x, z))) : 0;
  };

  // FR1 — the bands.
  const buildings: BuildingSpec[] = [];
  let near = 0;
  let mid = 0;
  for (const fp of built.footprints) {
    const made = footprintToSpec(fp);
    if (!made) continue;
    const { spec, areaM2 } = made;
    const d = nearestOnCourse(course, spec.x, spec.z).distance;
    if (d > BUILT_MID_M || wet(spec.x, spec.z, BUILT_WATER_CLEAR_M + Math.min(spec.halfWidth, spec.halfDepth))) continue;
    if (d > BUILT_NEAR_M) {
      if (spec.height <= MID_MIN_HEIGHT_M && areaM2 <= MID_MIN_AREA_M2) continue;
      mid += 1;
    } else {
      near += 1;
    }
    buildings.push(spec);
  }

  // FR3 — skylines along each settlement beyond the near band.
  const places = built.places.filter((p) => p.kind !== 'hamlet');
  const kindNear = (ring: ScenePoint[]): PlaceKind => {
    let best: PlaceKind = 'village';
    let bestD = PLACE_REACH_M;
    for (const p of places) {
      const d = insideRing(ring, p.x, p.z) ? 0 : Math.min(...ring.map(([x, z]) => Math.hypot(x - p.x, z - p.z)));
      if (d < bestD || (d === bestD && SKYLINE_SCALE[p.kind] > SKYLINE_SCALE[best])) {
        bestD = d;
        best = p.kind;
      }
    }
    return best;
  };
  let skylines: SkylineInstance[] = [];
  const outlined: ScenePoint[][] = [];
  for (const f of landCover ?? []) {
    if (f.shape !== 'polygon' || !BUILT_UP.has(f.kind)) continue;
    const ring = openRing(f.points);
    if (ring.length < 3) continue;
    const nearest = Math.min(...ring.map(([x, z]) => nearestOnCourse(course, x, z).distance));
    if (nearest <= BUILT_NEAR_M || nearest > LANDSCAPE_REACH_M) continue;
    outlined.push(ring);
    const scale = SKYLINE_SCALE[kindNear(ring)];
    const strips = stripsOnFacingEdges(ring, course, {
      stripM: SKYLINE_STRIP_M * scale,
      minPieceM: (SKYLINE_STRIP_M * scale) / 2,
      insetM: (SKYLINE_DEPTH_M * scale) / 2,
    });
    for (const s of strips) skylines.push({ x: s.x, y: 0, z: s.z, yaw: s.yaw, scale, distance: s.distance });
  }
  for (const p of places) {
    if (outlined.some((ring) => insideRing(ring, p.x, p.z))) continue;
    const { point, distance } = nearestOnCourse(course, p.x, p.z);
    if (distance <= BUILT_NEAR_M || distance > LANDSCAPE_REACH_M) continue;
    const scale = SKYLINE_SCALE[p.kind];
    const dx = (p.x - point[0]) / distance;
    const dz = (p.z - point[1]) / distance;
    // Local +X across the line of sight: (cos yaw, -sin yaw) = (-dz, dx).
    const yaw = Math.atan2(-dx, -dz);
    const n = SKYLINE_STRIPS_FOR_PLACE[p.kind];
    for (let k = 0; k < n; k += 1) {
      const off = (k - (n - 1) / 2) * SKYLINE_STRIP_M * scale;
      const x = p.x - dz * off;
      const z = p.z + dx * off;
      skylines.push({ x, y: 0, z, yaw, scale, distance: nearestOnCourse(course, x, z).distance });
    }
  }
  skylines = skylines
    .filter((s) => !wet(s.x, s.z, BUILT_NEAR_M))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(0, input.maxSkylines))
    .map((s) => ({ ...s, y: standOn(s.x, s.z) }));

  // FR4 — landmarks, the most prominent (height over distance) first.
  const landmarks = built.landmarks
    .map((l): LandmarkInstance | null => {
      const model = LANDMARK_MODELS[l.kind];
      const distance = nearestOnCourse(course, l.x, l.z).distance;
      if (distance > LANDSCAPE_REACH_M || wet(l.x, l.z, BUILT_WATER_CLEAR_M)) return null;
      const height = l.heightM ?? model.defaultHeight;
      return { id: model.id, kind: l.kind, x: l.x, y: 0, z: l.z, scale: height / model.top, height, distance };
    })
    .filter((l): l is LandmarkInstance => l !== null)
    .sort((a, b) => b.height / Math.max(b.distance, 1) - a.height / Math.max(a.distance, 1))
    .slice(0, Math.max(0, input.maxLandmarks))
    .map((l) => ({ ...l, y: standOn(l.x, l.z) }));

  return {
    buildings,
    skylines,
    landmarks,
    summary: { near, mid, skylineInstances: skylines.length, landmarks: landmarks.length },
  };
};
