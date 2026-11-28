/**
 * #763 VP-35 — hills on the horizon from the real terrain around a route.
 *
 * D1 (a): the kit's landform models (`f10`, `f11`, `f12`, `f46`), placed and
 * scaled from the horizon the #762 elevation grid gives each course station.
 * Pure: a function of the grid, the course and the land cover.
 *
 * FR1 the horizon profile at every station; FR2 one landform per ridge run,
 * its top at the run's elevation angle; FR3 nothing where the land is flat;
 * FR4 placed once per route in world space, neighbours merged; FR6 never on
 * the water; FR7 a resident budget per tier; FR8 nothing without data.
 */
import type { ElevationGrid, ScenePoint } from '../services/landscapeService';
import { LANDSCAPE_REACH_M } from '../services/landscapeArea';
import type { PerformanceMode } from './sceneryPlacement';
import { LandCoverClass, classAt, type LandCoverMask } from './landCoverMask';

/** FR1 — metres between the stations a horizon is worked out from. */
export const RELIEF_STATION_EVERY_M = 250;
/** FR1 — bearings around each station (5 degree steps). */
export const RELIEF_BEARINGS = 72;
/** FR1 — the nearest ground that counts as horizon, metres. */
export const RELIEF_NEAR_M = 300;
/** FR1 — metres between samples along a bearing. */
const RELIEF_MARCH_M = 25;
/** FR3 — a run lower than this, in degrees, is flat land: nothing is placed. */
export const RELIEF_MIN_ANGLE_DEG = 0.5;
/** FR3 — and lower than this, metres above the water, is no hill at any distance. */
export const RELIEF_MIN_HEIGHT_M = 5;
/** FR2 — the widest arc one landform stands for, in bearings (30 degrees). */
const RELIEF_RUN_MAX_BEARINGS = 6;
/** FR4 — landforms nearer than this (or half their length) are one hill. */
export const RELIEF_DEDUPE_M = 150;
/** FR2 — beyond this a landform is the far ridge. */
export const RELIEF_FAR_M = 1200;
/** FR2 — a slope steeper than this (rise over run) is a bluff. */
const RELIEF_STEEP_SLOPE = 0.35;
/** FR6 — the nearest a landform's footprint comes to the course, metres. */
export const RELIEF_WATER_CLEAR_M = 80;
/** #886 FR2 — and how far beyond the water's own edge it stays, metres. */
export const RELIEF_BANK_MARGIN_M = 40;
/** FR7 — landforms resident at once, `medium` being the issue's 24; none at `basic`. */
export const RELIEF_BUDGET: Record<PerformanceMode, number> = {
  basic: 0,
  low: 12,
  medium: 24,
  high: 36,
  'extra-high': 48,
};

/**
 * The kit landforms: how tall (top above the model's origin) and how long
 * (on its local X) and deep (local Z) each is, in metres, from
 * `scripts/build_scenery.py`. A placement scales one uniformly.
 */
export const RELIEF_MODELS = {
  'f10-ridge-rolling-meadow': { top: 12, length: 68, depth: 44 },
  'f11-hillside-wooded': { top: 17, length: 89, depth: 53 },
  'f12-bluff-steep': { top: 25, length: 60, depth: 26 },
  'f46-hill-ridge-far': { top: 30, length: 260, depth: 60 },
} as const;
export type ReliefModelId = keyof typeof RELIEF_MODELS;

export interface HorizonSample {
  /** Degrees clockwise from north. */
  bearingDeg: number;
  /** The highest elevation angle along the bearing, degrees; 0 with no ground. */
  angleDeg: number;
  /** Metres from the station to where that angle occurs. */
  distance: number;
  /** The ground's height there above the water, metres. */
  height: number;
}

export interface ReliefPlacement {
  id: ReliefModelId;
  x: number;
  z: number;
  /** Radians, the engine's `rotationY`: the model's length lies across the bearing. */
  yaw: number;
  scale: number;
  /** The run's elevation angle from its station, degrees. */
  angleDeg: number;
  /** Metres along the course of the station it was seen from. */
  along: number;
}

export interface ReliefPlan {
  placements: ReliefPlacement[];
  /** FR9 — `__ROWER3D_SCENERY.relief`. */
  summary: { runs: number; placed: number; maxElevationDeg: number };
}

/** The grid's height at world (x, z), bilinear; NaN off the grid or where unknown. */
export const heightAt = (grid: ElevationGrid, x: number, z: number): number => {
  const fc = (x - grid.originX) / grid.stepX;
  const fr = (z - grid.originZ) / grid.stepZ;
  const c0 = Math.floor(fc);
  const r0 = Math.floor(fr);
  if (c0 < 0 || r0 < 0 || c0 >= grid.cols - 1 || r0 >= grid.rows - 1) return NaN;
  const tc = fc - c0;
  const tr = fr - r0;
  const at = (c: number, r: number) => grid.heights[r * grid.cols + c];
  const top = at(c0, r0) * (1 - tc) + at(c0 + 1, r0) * tc;
  const bottom = at(c0, r0 + 1) * (1 - tc) + at(c0 + 1, r0 + 1) * tc;
  return top * (1 - tr) + bottom * tr;
};

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;
/** Scene direction of a compass bearing: north is -z, east +x. */
const bearingDir = (bearingDeg: number): [number, number] => [Math.sin(toRad(bearingDeg)), -Math.cos(toRad(bearingDeg))];

/** FR1 — the horizon from (x, z): per bearing, the highest elevation angle out to the landscape's reach. */
export const horizonProfile = (grid: ElevationGrid, x: number, z: number, reach = LANDSCAPE_REACH_M): HorizonSample[] => {
  const out: HorizonSample[] = [];
  for (let b = 0; b < RELIEF_BEARINGS; b += 1) {
    const bearingDeg = (b * 360) / RELIEF_BEARINGS;
    const [dx, dz] = bearingDir(bearingDeg);
    let best: HorizonSample = { bearingDeg, angleDeg: 0, distance: 0, height: 0 };
    for (let r = RELIEF_NEAR_M; r <= reach; r += RELIEF_MARCH_M) {
      const h = heightAt(grid, x + dx * r, z + dz * r);
      if (!(h > 0)) continue;
      const angleDeg = toDeg(Math.atan2(h, r));
      if (angleDeg > best.angleDeg) best = { bearingDeg, angleDeg, distance: r, height: h };
    }
    out.push(best);
  }
  return out;
};

/** Stations every `RELIEF_STATION_EVERY_M` along the course, with their distance along it. */
const stationsAlong = (course: readonly ScenePoint[]): Array<{ x: number; z: number; along: number }> => {
  const out: Array<{ x: number; z: number; along: number }> = [];
  let along = 0;
  let next = 0;
  for (let k = 1; k < course.length; k += 1) {
    const [x0, z0] = course[k - 1];
    const [x1, z1] = course[k];
    const len = Math.hypot(x1 - x0, z1 - z0);
    while (len > 0 && next <= along + len) {
      const t = (next - along) / len;
      out.push({ x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, along: next });
      next += RELIEF_STATION_EVERY_M;
    }
    along += len;
  }
  if (out.length === 0 && course.length > 0) out.push({ x: course[0][0], z: course[0][1], along: 0 });
  return out;
};

/** FR2 — adjacent bearings above the flat threshold, merged (around north too) and cut to at most 30 degrees. */
export const ridgeRuns = (profile: readonly HorizonSample[]): HorizonSample[][] => {
  const n = profile.length;
  const high = profile.map((s) => s.angleDeg >= RELIEF_MIN_ANGLE_DEG);
  if (!high.some(Boolean)) return [];
  // Start just after a low bearing so a run across north is not cut in two.
  const start = high.every(Boolean) ? 0 : (high.findIndex((h, i) => !h && high[(i + 1) % n]) + 1) % n;
  const runs: HorizonSample[][] = [];
  let run: HorizonSample[] = [];
  for (let k = 0; k < n; k += 1) {
    const s = profile[(start + k) % n];
    if (high[(start + k) % n] && run.length < RELIEF_RUN_MAX_BEARINGS) {
      run.push(s);
      continue;
    }
    if (run.length > 0) runs.push(run);
    run = high[(start + k) % n] ? [s] : [];
  }
  if (run.length > 0) runs.push(run);
  return runs;
};

/**
 * #886 — the course point nearest (x, z): how far it is, how far along the
 * course, and which bank (x, z) is on. The left bank is where the bank
 * strip's perp (-tz, tx) is negative, as in `sceneryRoute.ts`.
 */
const nearestOnCourse = (
  course: readonly ScenePoint[],
  x: number,
  z: number,
): { distance: number; along: number; side: 'left' | 'right' } => {
  let best = { distance: Infinity, along: 0, side: 'left' as 'left' | 'right' };
  let along = 0;
  for (let k = 1; k < course.length; k += 1) {
    const [x0, z0] = course[k - 1];
    const [x1, z1] = course[k];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / (len * len))) : 0;
    const distance = Math.hypot(x - x0 - t * dx, z - z0 - t * dz);
    if (distance < best.distance) {
      const s = len > 0 ? ((x - x0) * -dz + (z - z0) * dx) / len : 0;
      best = { distance, along: along + t * len, side: s < 0 ? 'left' : 'right' };
    }
    along += len;
  }
  return best;
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

const chooseModel = (grid: ElevationGrid, x: number, z: number, distance: number, landCover: LandCoverMask | null): ReliefModelId => {
  if (distance > RELIEF_FAR_M) return 'f46-hill-ridge-far';
  if (landCover && classAt(landCover, x, z) === LandCoverClass.woodland) return 'f11-hillside-wooded';
  const d = grid.spacingM / 2;
  const sx = (heightAt(grid, x + d, z) - heightAt(grid, x - d, z)) / (2 * d);
  const sz = (heightAt(grid, x, z + d) - heightAt(grid, x, z - d)) / (2 * d);
  if (Math.hypot(sx, sz) > RELIEF_STEEP_SLOPE) return 'f12-bluff-steep';
  return 'f10-ridge-rolling-meadow';
};

/**
 * FR2 — the landform's length lies along the ground's contour at (x, z),
 * across the slope; on level ground, across the bearing it was seen on.
 * Model +X maps to (cos yaw, -sin yaw) in the scene.
 */
const alongContour = (grid: ElevationGrid, x: number, z: number, bearingDeg: number): number => {
  const d = grid.spacingM / 2;
  const gx = heightAt(grid, x + d, z) - heightAt(grid, x - d, z);
  const gz = heightAt(grid, x, z + d) - heightAt(grid, x, z - d);
  if (!(Math.hypot(gx, gz) > 1e-3)) return -toRad(bearingDeg);
  // The contour runs at right angles to the gradient: (-gz, gx).
  return Math.atan2(-gx, -gz);
};

/** The scaled footprint's four corners and centre, in world XZ. */
export const reliefFootprint = (p: Pick<ReliefPlacement, 'id' | 'x' | 'z' | 'yaw' | 'scale'>): ScenePoint[] => {
  const { length, depth } = RELIEF_MODELS[p.id];
  const ax = Math.cos(p.yaw);
  const az = -Math.sin(p.yaw);
  const hl = (length * p.scale) / 2;
  const hd = (depth * p.scale) / 2;
  const corners: ScenePoint[] = [[p.x, p.z]];
  for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    // Local +Z is (sin yaw, cos yaw) in the scene.
    corners.push([p.x + u * hl * ax + v * hd * Math.sin(p.yaw), p.z + u * hl * az + v * hd * Math.cos(p.yaw)]);
  }
  return corners;
};

/**
 * #886 FR1, FR2 — how far a landform's footprint stays clear of the water:
 * the nearest corner's distance to the course, less the clearance its bank
 * needs (`RELIEF_WATER_CLEAR_M`, or the water's half-width there plus
 * `RELIEF_BANK_MARGIN_M`). Negative is too close; -Infinity is a corner
 * across the water from a one-sided course's land.
 */
export const reliefClearanceMargin = (
  p: Pick<ReliefPlacement, 'id' | 'x' | 'z' | 'yaw' | 'scale'>,
  {
    course,
    landSide,
    halfWidthAt,
  }: Pick<HorizonReliefInput, 'course' | 'landSide' | 'halfWidthAt'>,
): number => {
  const centre = nearestOnCourse(course, p.x, p.z);
  const clear = Math.max(RELIEF_WATER_CLEAR_M, (halfWidthAt?.(centre.along, centre.side) ?? 0) + RELIEF_BANK_MARGIN_M);
  let margin = Infinity;
  for (const [x, z] of reliefFootprint(p)) {
    const near = nearestOnCourse(course, x, z);
    if (landSide !== undefined && near.side !== landSide) return -Infinity;
    margin = Math.min(margin, near.distance - clear);
  }
  return margin;
};

export interface HorizonReliefInput {
  grid: ElevationGrid | null | undefined;
  course: readonly ScenePoint[];
  tier: PerformanceMode;
  landCover?: LandCoverMask | null;
  /** Lakes and other water areas, world XZ. */
  water?: readonly ScenePoint[][];
  /** #886 FR1 — the bank that is land on a coastal or one-sided course; landforms stand only there. */
  landSide?: 'left' | 'right';
  /**
   * #886 FR2 — the water's half-width (metres) on `side` at `along` metres down
   * the course. A landform stays this plus `RELIEF_BANK_MARGIN_M` back, so a
   * canal keeps its hills close and a lake pushes them out to the horizon.
   */
  halfWidthAt?: (along: number, side: 'left' | 'right') => number;
}

/** FR1-FR4, FR6, FR7 — the landforms the route's horizon calls for; null with no elevation data (FR8). */
export const planHorizonRelief = ({
  grid,
  course,
  tier,
  landCover = null,
  water = [],
  landSide,
  halfWidthAt,
}: HorizonReliefInput): ReliefPlan | null => {
  if (!grid || course.length < 2) return null;
  const candidates: ReliefPlacement[] = [];
  let runs = 0;
  let maxElevationDeg = 0;
  const clearance = { course, landSide, halfWidthAt };
  const onWater = (p: ReliefPlacement): boolean =>
    reliefClearanceMargin(p, clearance) < 0 ||
    reliefFootprint(p).some(
      ([x, z]) =>
        water.some((ring) => insideRing(ring, x, z)) ||
        (landCover !== null &&
          [LandCoverClass.water, LandCoverClass.sea].includes(classAt(landCover, x, z) as 9 | 11)),
    );
  for (const station of stationsAlong(course)) {
    const profile = horizonProfile(grid, station.x, station.z);
    for (const s of profile) maxElevationDeg = Math.max(maxElevationDeg, s.angleDeg);
    for (const run of ridgeRuns(profile)) {
      runs += 1;
      const peak = run.reduce((a, b) => (b.angleDeg > a.angleDeg ? b : a));
      if (peak.height < RELIEF_MIN_HEIGHT_M) continue;
      const [dx, dz] = bearingDir(peak.bearingDeg);
      const slope = Math.tan(toRad(peak.angleDeg));
      // FR6 — a landform whose footprint reaches the water steps back along
      // its bearing, keeping its elevation angle, or is dropped.
      let placed: ReliefPlacement | null = null;
      for (let distance = peak.distance, tries = 0; tries < 4 && distance <= LANDSCAPE_REACH_M; tries += 1) {
        const x = station.x + dx * distance;
        const z = station.z + dz * distance;
        const id = chooseModel(grid, x, z, distance, landCover);
        const p: ReliefPlacement = {
          id,
          x,
          z,
          yaw: alongContour(grid, x, z, peak.bearingDeg),
          scale: (slope * distance) / RELIEF_MODELS[id].top,
          angleDeg: peak.angleDeg,
          along: station.along,
        };
        if (!onWater(p)) {
          placed = p;
          break;
        }
        distance += (RELIEF_MODELS[id].depth * p.scale) / 2;
      }
      if (placed) candidates.push(placed);
    }
  }
  // FR4 — the same hill seen from neighbouring stations is one landform: the
  // tallest view of it stays.
  candidates.sort((a, b) => b.angleDeg - a.angleDeg || a.along - b.along);
  const kept: ReliefPlacement[] = [];
  for (const c of candidates) {
    const reach = (p: ReliefPlacement) => Math.max(RELIEF_DEDUPE_M, (RELIEF_MODELS[p.id].length * p.scale) / 2);
    if (kept.some((k) => Math.hypot(k.x - c.x, k.z - c.z) < Math.max(reach(k), reach(c)))) continue;
    kept.push(c);
  }
  // FR7 — at most the tier's budget within any stretch the camera can see
  // (the landscape's reach both ways): half of it in each window that long.
  const window = 2 * LANDSCAPE_REACH_M;
  const perWindow = Math.floor(RELIEF_BUDGET[tier] / 2);
  const inWindow = new Map<number, number>();
  const placements = kept.filter((p) => {
    const w = Math.floor(p.along / window);
    const n = inWindow.get(w) ?? 0;
    if (n >= perWindow) return false;
    inWindow.set(w, n + 1);
    return true;
  });
  placements.sort((a, b) => a.along - b.along || a.x - b.x);
  return { placements, summary: { runs, placed: placements.length, maxElevationDeg: Math.round(maxElevationDeg * 10) / 10 } };
};

/**
 * #765 FR5 — the height of the drawn landforms' surface at world (x, z): each
 * taken as a dome over its scaled footprint, 0 where none stands. What stands
 * on a hill is raised no higher than this, so nothing floats over a landform.
 */
export const landformSurfaceAt = (placements: readonly ReliefPlacement[], x: number, z: number): number => {
  let best = 0;
  for (const p of placements) {
    const { top, length, depth } = RELIEF_MODELS[p.id];
    const dx = x - p.x;
    const dz = z - p.z;
    // Local +X is (cos yaw, -sin yaw); local +Z is (sin yaw, cos yaw).
    const u = (dx * Math.cos(p.yaw) - dz * Math.sin(p.yaw)) / ((length * p.scale) / 2);
    const v = (dx * Math.sin(p.yaw) + dz * Math.cos(p.yaw)) / ((depth * p.scale) / 2);
    const q = u * u + v * v;
    if (q < 1) best = Math.max(best, top * p.scale * (1 - q));
  }
  return best;
};
