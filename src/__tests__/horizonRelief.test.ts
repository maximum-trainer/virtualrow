import { describe, expect, it } from 'vitest';
import {
  RELIEF_BUDGET,
  RELIEF_MODELS,
  RELIEF_WATER_CLEAR_M,
  heightAt,
  horizonProfile,
  planHorizonRelief,
  reliefFootprint,
  ridgeRuns,
  type HorizonSample,
} from '../lib/scenery/horizonRelief';
import { buildLandCoverMask } from '../lib/scenery/landCoverMask';
import type { ElevationGrid, ScenePoint } from '../lib/services/landscapeService';
import type { Coordinate } from '../lib/types/index';
import { routeCurvePoints } from '../lib/utils/routeWorldCurve';
import lochNess from './fixtures/landscape/180.json';
import heerenveen from './fixtures/landscape/277.json';

/** A synthetic grid over x, z in [-3000, 3000], 50 m spacing, height from `f`. */
const grid = (f: (x: number, z: number) => number, spacing = 50): ElevationGrid => {
  const cols = Math.round(6000 / spacing) + 1;
  const rows = cols;
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) heights[r * cols + c] = f(-3000 + c * spacing, 3000 - r * spacing);
  }
  return { originX: -3000, originZ: 3000, stepX: spacing, stepZ: -spacing, spacingM: spacing, cols, rows, heights, complete: true };
};
/** A straight north-south course, 4 km, along x = 0. */
const COURSE: ScenePoint[] = [[0, 2000], [0, -2000]];
/** A 200 m ridge running north-south along x = 1000. */
const ridge = (x: number) => 200 * Math.exp(-(((x - 1000) / 150) ** 2));

describe('heightAt (#763 FR1)', () => {
  it('interpolates between grid points and is NaN off the grid', () => {
    const g = grid((x) => x / 10);
    expect(heightAt(g, 25, 0)).toBeCloseTo(2.5, 5);
    expect(heightAt(g, -1234, 777)).toBeCloseTo(-123.4, 3);
    expect(heightAt(g, 5000, 0)).toBeNaN();
  });
});

describe('horizonProfile (#763 FR1)', () => {
  it('gives 72 bearings and finds the ridge east at its elevation angle', () => {
    const profile = horizonProfile(grid(ridge), 0, 0);
    expect(profile).toHaveLength(72);
    const east = profile[18];
    expect(east.bearingDeg).toBe(90);
    expect(east.distance).toBeGreaterThan(900);
    expect(east.distance).toBeLessThan(1100);
    expect(east.angleDeg).toBeCloseTo(11.3, 0);
    expect(profile[54].angleDeg).toBeLessThan(0.01);
  });

  it('ignores ground nearer than 300 m', () => {
    const profile = horizonProfile(grid((x) => (Math.abs(x - 200) < 60 ? 100 : 0)), 0, 0);
    expect(profile[18].angleDeg).toBe(0);
  });
});

describe('ridgeRuns (#763 FR2, FR3)', () => {
  const sample = (b: number, angleDeg: number): HorizonSample => ({ bearingDeg: b * 5, angleDeg, distance: 1000, height: 10 });

  it('merges adjacent high bearings, across north too, and cuts runs at 30 degrees', () => {
    const profile = Array.from({ length: 72 }, (_, b) => sample(b, b <= 2 || b >= 70 ? 3 : b >= 20 && b < 34 ? 2 : 0));
    const runs = ridgeRuns(profile);
    const bearings = runs.map((r) => r.map((s) => s.bearingDeg));
    expect(bearings).toContainEqual([100, 105, 110, 115, 120, 125]);
    expect(bearings).toContainEqual([350, 355, 0, 5, 10]);
    expect(runs.every((r) => r.length <= 6)).toBe(true);
    expect(runs.flat()).toHaveLength(19);
  });

  it('finds nothing in flat land (FR3)', () => {
    expect(ridgeRuns(Array.from({ length: 72 }, (_, b) => sample(b, 0.4)))).toEqual([]);
  });
});

describe('planHorizonRelief (#763)', () => {
  it('places nothing without elevation data (FR8)', () => {
    expect(planHorizonRelief({ grid: null, course: COURSE, tier: 'medium' })).toBeNull();
    expect(planHorizonRelief({ grid: grid(ridge), course: COURSE.slice(0, 1), tier: 'medium' })).toBeNull();
  });

  it('puts the ridge east of the course at its real height (AC: height matches the terrain)', () => {
    const plan = planHorizonRelief({ grid: grid(ridge), course: COURSE, tier: 'medium' })!;
    const beside = plan.placements.filter((p) => Math.abs(p.z) <= 2000);
    expect(beside.length).toBeGreaterThan(0);
    for (const p of plan.placements) {
      expect(p.x).toBeGreaterThan(900);
      expect(p.x).toBeLessThan(1100);
    }
    for (const p of beside) {
      // Bearing 80-100 degrees from the nearest course point, 900-1,100 m out.
      expect(p.x).toBeGreaterThan(900);
      expect(p.x).toBeLessThan(1100);
      const top = RELIEF_MODELS[p.id].top * p.scale;
      expect(Math.atan2(top, p.x) * (180 / Math.PI)).toBeGreaterThan(11.3 - 1.5);
      expect(Math.atan2(top, p.x) * (180 / Math.PI)).toBeLessThan(11.3 + 1.5);
      // Its length lies across the bearing (along the ridge).
      expect(Math.abs(Math.cos(p.yaw))).toBeLessThan(0.1);
    }
    expect(plan.summary.maxElevationDeg).toBeGreaterThan(10);
    expect(plan.summary.placed).toBe(plan.placements.length);
  });

  it('keeps flat land flat (FR3)', () => {
    const plan = planHorizonRelief({ grid: grid((x, z) => 1.5 * Math.sin(x / 300) * Math.cos(z / 400) + 1.5), course: COURSE, tier: 'medium' })!;
    expect(plan.placements).toEqual([]);
  });

  it('puts hills on both sides of a valley', () => {
    const valley = grid((x) => Math.min(600, Math.max(0, (Math.abs(x) - 300) * 0.4)));
    const plan = planHorizonRelief({ grid: valley, course: COURSE, tier: 'medium' })!;
    expect(plan.placements.some((p) => p.x > 300)).toBe(true);
    expect(plan.placements.some((p) => p.x < -300)).toBe(true);
    const profile = horizonProfile(valley, 0, 0);
    expect(profile[18].angleDeg).toBeGreaterThan(5);
    expect(profile[54].angleDeg).toBeGreaterThan(5);
  });

  it('is placed once per route in world space (FR4, AC: hills do not move)', () => {
    const a = planHorizonRelief({ grid: grid(ridge), course: COURSE, tier: 'medium' })!;
    const b = planHorizonRelief({ grid: grid(ridge), course: COURSE, tier: 'medium' })!;
    expect(b.placements).toEqual(a.placements);
    // Neighbouring stations see the same ridge: no two landforms within 150 m.
    for (const p of a.placements) {
      for (const q of a.placements) if (p !== q) expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeGreaterThanOrEqual(150);
    }
  });

  it('chooses the model by distance, woods and slope (FR2)', () => {
    const far = planHorizonRelief({ grid: grid((x) => 300 * Math.exp(-(((x - 1700) / 150) ** 2))), course: COURSE, tier: 'medium' })!;
    expect(new Set(far.placements.map((p) => p.id))).toEqual(new Set(['f46-hill-ridge-far']));
    const gentle = planHorizonRelief({ grid: grid((x) => 30 * Math.exp(-(((x - 700) / 200) ** 2))), course: COURSE, tier: 'medium' })!;
    expect(new Set(gentle.placements.map((p) => p.id))).toEqual(new Set(['f10-ridge-rolling-meadow']));
    const steep = planHorizonRelief({ grid: grid((x) => (x > 700 ? Math.min(120, (x - 700) * 0.8) : 0)), course: COURSE, tier: 'medium' })!;
    expect(steep.placements.some((p) => p.id === 'f12-bluff-steep')).toBe(true);
    const woods = buildLandCoverMask({
      bounds: { minX: -3000, minZ: -3000, maxX: 3000, maxZ: 3000 },
      features: [{ kind: 'wood', shape: 'polygon', points: [[400, -3000], [1000, -3000], [1000, 3000], [400, 3000], [400, -3000]] }],
    });
    const wooded = planHorizonRelief({
      grid: grid((x) => 30 * Math.exp(-(((x - 700) / 200) ** 2))),
      course: COURSE,
      tier: 'medium',
      landCover: woods,
    })!;
    expect(new Set(wooded.placements.map((p) => p.id))).toEqual(new Set(['f11-hillside-wooded']));
  });

  it('never stands a landform on the water (FR6)', () => {
    // A hill right by a bend: the course doubles back east of it.
    const course: ScenePoint[] = [[0, 2000], [0, -2000], [1400, -2000], [1400, 2000]];
    const lake: ScenePoint[] = [[-1500, -500], [-900, -500], [-900, 500], [-1500, 500], [-1500, -500]];
    const hills = grid((x) => 150 * Math.exp(-(((x - 700) / 120) ** 2)) + 150 * Math.exp(-(((x + 1200) / 150) ** 2)));
    const plan = planHorizonRelief({ grid: hills, course, tier: 'medium', water: [lake] })!;
    expect(plan.placements.length).toBeGreaterThan(0);
    const inLake = ([x, z]: ScenePoint) => x > -1500 && x < -900 && z > -500 && z < 500;
    const toCourse = ([x, z]: ScenePoint) =>
      Math.min(
        z >= -2000 && z <= 2000 ? Math.abs(x) : Infinity,
        x >= 0 && x <= 1400 ? Math.abs(z + 2000) : Infinity,
        z >= -2000 && z <= 2000 ? Math.abs(x - 1400) : Infinity,
        Math.hypot(x, z - 2000),
        Math.hypot(x - 1400, z - 2000),
      );
    for (const p of plan.placements) {
      for (const corner of reliefFootprint(p)) {
        expect(toCourse(corner)).toBeGreaterThanOrEqual(RELIEF_WATER_CLEAR_M);
        expect(inLake(corner)).toBe(false);
      }
    }
  });

  it('holds the tier budget, none at basic (FR7)', () => {
    const bumpy = grid((x, z) => 80 + 60 * Math.sin(x / 170) * Math.sin(z / 190));
    const long: ScenePoint[] = [[0, 2500], [0, -2500]];
    expect(planHorizonRelief({ grid: bumpy, course: long, tier: 'basic' })!.placements).toEqual([]);
    const medium = planHorizonRelief({ grid: bumpy, course: long, tier: 'medium' })!;
    expect(medium.placements.length).toBeGreaterThan(0);
    expect(medium.placements.length).toBeLessThanOrEqual(RELIEF_BUDGET.medium);
    expect(RELIEF_BUDGET.high).toBeGreaterThan(RELIEF_BUDGET.medium);
  });
});

describe('landformSurfaceAt (#765 FR5)', () => {
  it('is the landform top at its centre, lower towards its edge, and 0 off it', async () => {
    const { landformSurfaceAt } = await import('../lib/scenery/horizonRelief');
    const hill = { id: 'f46-hill-ridge-far' as const, x: 1000, z: 0, yaw: 0, scale: 2, angleDeg: 3, along: 0 };
    expect(landformSurfaceAt([hill], 1000, 0)).toBeCloseTo(60, 5);
    // Along the length (local X = world X at yaw 0), half-way out: 3/4 height.
    expect(landformSurfaceAt([hill], 1000 + 130, 0)).toBeCloseTo(45, 5);
    expect(landformSurfaceAt([hill], 1000, 61)).toBe(0);
    expect(landformSurfaceAt([], 1000, 0)).toBe(0);
  });
});

/**
 * #763 ACs on real terrain: Copernicus GLO-90 heights through Open-Meteo,
 * recorded 2026-11-24 with scripts/record-landscape-fixtures.ts.
 */
describe('planHorizonRelief on recorded real terrain (#763 ACs)', () => {
  type Recorded = { route: Coordinate[]; elevation: Omit<ElevationGrid, 'heights'> & { heights: (number | null)[] } };
  const load = (fixture: unknown) => {
    const { route, elevation } = fixture as Recorded;
    const grid: ElevationGrid = { ...elevation, heights: Float32Array.from(elevation.heights, (h) => h ?? NaN) };
    const course = routeCurvePoints(route).map(([x, , z]) => [x, z] as ScenePoint);
    return { grid, course };
  };
  /** Which side of the start-finish line a point is on. */
  const sideOf = (course: ScenePoint[], x: number, z: number) => {
    const [ax, az] = course[0];
    const [bx, bz] = course[course.length - 1];
    return Math.sign((bx - ax) * (z - az) - (bz - az) * (x - ax));
  };

  it('Loch Ness (rownative 180) has its hills on both shores', () => {
    const { grid, course } = load(lochNess);
    const plan = planHorizonRelief({ grid, course, tier: 'medium' })!;
    expect(plan.summary.maxElevationDeg).toBeGreaterThan(15);
    expect(plan.placements.length).toBeGreaterThan(40);
    expect(plan.placements.length).toBeLessThanOrEqual(plan.summary.placed);
    const left = plan.placements.filter((p) => sideOf(course, p.x, p.z) > 0).length;
    const right = plan.placements.filter((p) => sideOf(course, p.x, p.z) < 0).length;
    expect(left).toBeGreaterThan(20);
    expect(right).toBeGreaterThan(20);
    // Half-way down the loch the hills stand above both shores.
    const [mx, mz] = course[Math.floor(course.length / 2)];
    const profile = horizonProfile(grid, mx, mz);
    const peak = (from: number, to: number) => Math.max(...profile.filter((s) => s.bearingDeg >= from && s.bearingDeg <= to).map((s) => s.angleDeg));
    expect(peak(90, 160)).toBeGreaterThan(5);
    expect(peak(250, 340)).toBeGreaterThan(5);
  });

  it('the Heerenveen canal (rownative 277) stays flat but for a few low knolls', () => {
    const { grid, course } = load(heerenveen);
    const plan = planHorizonRelief({ grid, course, tier: 'medium' })!;
    // The highest ground in view is a ~20 m patch near the start (GLO-90 is a
    // surface model, so a wood or buildings read as ground).
    expect(plan.summary.maxElevationDeg).toBeLessThan(4);
    expect(plan.placements.length).toBeLessThanOrEqual(10);
    for (const p of plan.placements) {
      expect(p.id).toBe('f10-ridge-rolling-meadow');
      expect(RELIEF_MODELS[p.id].top * p.scale).toBeLessThan(25);
    }
    const [mx, mz] = course[Math.floor(course.length / 2)];
    for (const s of horizonProfile(grid, mx, mz)) expect(s.angleDeg).toBeLessThan(0.5);
  });
});
