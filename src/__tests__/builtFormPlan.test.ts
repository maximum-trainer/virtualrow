import { describe, expect, it } from 'vitest';
import {
  BUILT_NEAR_M,
  LANDMARK_MODELS,
  SKYLINE_SCALE,
  footprintToSpec,
  planBuiltForm,
} from '../lib/scenery/builtFormPlan';
import { buildLandCoverMask } from '../lib/scenery/landCoverMask';
import type { BuiltForm, BuiltFootprint, ElevationGrid, LandCoverFeature, ScenePoint } from '../lib/services/landscapeService';

/** A straight north-south course along x = 0, 4 km: z from 2000 (south) to -2000 (north). */
const COURSE: ScenePoint[] = [[0, 2000], [0, -2000]];
const square = (cx: number, cz: number, half: number): ScenePoint[] => [
  [cx - half, cz - half],
  [cx + half, cz - half],
  [cx + half, cz + half],
  [cx - half, cz + half],
  [cx - half, cz - half],
];
const shed = (x: number, z: number, half = 4, heightM?: number, kind = 'shed'): BuiltFootprint => ({
  kind,
  ...(heightM !== undefined ? { heightM } : {}),
  points: square(x, z, half),
});
const form = (over: Partial<BuiltForm> = {}): BuiltForm => ({ footprints: [], places: [], landmarks: [], ...over });
const plan = (built: BuiltForm, over: Partial<Parameters<typeof planBuiltForm>[0]> = {}) =>
  planBuiltForm({ built, course: COURSE, maxSkylines: 40, maxLandmarks: 12, ...over })!;
const bearingFrom = (x: number, z: number, at: ScenePoint) => ((Math.atan2(x - at[0], -(z - at[1])) * 180) / Math.PI + 360) % 360;

describe('footprintToSpec (#765 FR1)', () => {
  it('takes the tagged height, else a default by kind, and skips slivers', () => {
    expect(footprintToSpec(shed(100, 0, 5, 20))!.spec).toMatchObject({ x: 100, z: 0, halfWidth: 5, halfDepth: 5, height: 20 });
    expect(footprintToSpec(shed(100, 0, 5, undefined, 'apartments'))!.spec.height).toBe(15);
    expect(footprintToSpec(shed(100, 0, 5, undefined, 'industrial'))!.spec.profile).toBe('industrial');
    expect(footprintToSpec(shed(100, 0, 5, undefined, 'mystery'))!.spec.height).toBe(6);
    expect(footprintToSpec(shed(100, 0, 0.5))).toBeNull();
    expect(footprintToSpec({ kind: 'house', points: [[0, 0], [1, 1]] })).toBeNull();
  });
});

describe('planBuiltForm (#765)', () => {
  it('leaves the scene as it was without built data (FR9)', () => {
    expect(planBuiltForm({ built: null, course: COURSE, maxSkylines: 40, maxLandmarks: 12 })).toBeNull();
    expect(planBuiltForm({ built: form(), course: COURSE.slice(0, 1), maxSkylines: 40, maxLandmarks: 12 })).toBeNull();
  });

  it('bands buildings by distance: all near, big or tall mid, none far (FR1)', () => {
    const out = plan(
      form({
        footprints: [
          shed(100, 0),
          shed(-500, 0),
          shed(800, 0),
          shed(900, 0, 4, 20),
          shed(-1000, 0, 15),
          shed(1500, 0, 30, 60),
        ],
      }),
    );
    expect(out.buildings.map((b) => b.x).sort((a, b) => a - b)).toEqual([-1000, -500, 100, 900]);
    expect(out.summary).toMatchObject({ near: 2, mid: 2 });
  });

  it('keeps buildings off the water (FR7)', () => {
    const lake = square(300, 0, 100);
    const mask = buildLandCoverMask({ bounds: { minX: -3000, minZ: -3000, maxX: 3000, maxZ: 3000 }, features: [], water: [square(-300, 0, 60)] });
    const out = plan(form({ footprints: [shed(10, 0), shed(300, 0), shed(-300, 0), shed(100, 500)] }), { water: [lake], mask });
    expect(out.buildings.map((b) => [b.x, b.z])).toEqual([[100, 500]]);
  });

  it('lines a town on the horizon along its course-facing edge (FR3, AC: a town on the horizon)', () => {
    const town: LandCoverFeature = { kind: 'residential', shape: 'polygon', points: square(-1500, 0, 200) };
    const out = plan(
      form({ places: [{ kind: 'town', name: 'T', x: -1500, z: 0 }], footprints: [shed(-1500, 0, 10, 20)] }),
      { landCover: [town] },
    );
    expect(out.skylines.length).toBeGreaterThan(0);
    for (const s of out.skylines) {
      const bearing = bearingFrom(s.x, s.z, [0, s.z]);
      expect(bearing).toBeGreaterThanOrEqual(255);
      expect(bearing).toBeLessThanOrEqual(285);
      expect(s.distance).toBeGreaterThanOrEqual(1300);
      expect(s.distance).toBeLessThanOrEqual(1700);
      expect(s.scale).toBe(SKYLINE_SCALE.town);
    }
    // No individual building beyond 1,200 m.
    expect(out.buildings).toEqual([]);
    expect(out.summary.skylineInstances).toBe(out.skylines.length);
  });

  it('gives a place with no outline its own strips, sized by the settlement (FR3)', () => {
    const out = plan(form({ places: [{ kind: 'city', x: 1800, z: 0 }, { kind: 'village', x: -900, z: -1000 }, { kind: 'hamlet', x: -900, z: 1000 }, { kind: 'town', x: 300, z: 0 }] }));
    const city = out.skylines.filter((s) => s.x > 1000);
    expect(city).toHaveLength(5);
    expect(city.every((s) => s.scale === 2.5 && Math.abs(s.x - 1800) < 1)).toBe(true);
    // Across the line of sight: local X runs north-south.
    expect(Math.abs(Math.cos(city[0].yaw))).toBeLessThan(1e-6);
    expect(out.skylines.filter((s) => s.x < 0)).toHaveLength(1);
    // The town inside the near band gets no skyline: its buildings are drawn.
    expect(out.skylines.some((s) => Math.abs(s.x - 300) < 1)).toBe(false);
  });

  it('caps the skyline strips, nearest first (FR8)', () => {
    const out = plan(form({ places: [{ kind: 'city', x: 1800, z: 0 }, { kind: 'city', x: 900, z: 0 }] }), { maxSkylines: 5 });
    expect(out.skylines).toHaveLength(5);
    expect(out.skylines.every((s) => s.x < 1000)).toBe(true);
    expect(plan(form({ places: [{ kind: 'city', x: 1800, z: 0 }] }), { maxSkylines: 0 }).skylines).toEqual([]);
  });

  it('puts a church spire where it is, at its height (FR4, AC: a church spire is where it is)', () => {
    // 700 m north-east of the 2 km station (z = 0).
    const at: ScenePoint = [700 * Math.SQRT1_2, -700 * Math.SQRT1_2];
    const out = plan(form({ landmarks: [{ kind: 'church', heightM: 45, x: at[0], z: at[1] }] }));
    expect(out.landmarks).toHaveLength(1);
    const l = out.landmarks[0];
    expect(Math.hypot(l.x - at[0], l.z - at[1])).toBeLessThan(15);
    expect(l.id).toBe(LANDMARK_MODELS.church.id);
    expect(l.scale * LANDMARK_MODELS.church.top).toBeCloseTo(45, 5);
    expect(out.summary.landmarks).toBe(1);
  });

  it('ranks landmarks by prominence within the budget and keeps them off the water (FR4, FR7, FR8)', () => {
    const out = plan(
      form({
        landmarks: [
          { kind: 'mast', heightM: 200, x: 1500, z: 0 },
          { kind: 'water_tower', x: 400, z: 0 },
          { kind: 'chimney', x: 1900, z: 0 },
          { kind: 'lighthouse', x: 5, z: 0 },
          { kind: 'tall', heightM: 40, x: 9000, z: 0 },
        ],
      }),
      { maxLandmarks: 2 },
    );
    expect(out.landmarks.map((l) => l.kind)).toEqual(['mast', 'water_tower']);
    expect(out.landmarks[1].height).toBe(LANDMARK_MODELS.water_tower.defaultHeight);
  });

  it('stands skylines and landmarks on the drawn hills, never above them (FR5)', () => {
    const cols = 121;
    const heights = new Float32Array(cols * cols).fill(80);
    const grid: ElevationGrid = { originX: -3000, originZ: 3000, stepX: 50, stepZ: -50, spacingM: 50, cols, rows: cols, heights, complete: true };
    const hill = { id: 'f46-hill-ridge-far' as const, x: 1500, z: 0, yaw: Math.PI / 2, scale: 4, angleDeg: 3, along: 0 };
    const out = plan(
      form({ places: [{ kind: 'village', x: 1500, z: 0 }], landmarks: [{ kind: 'tower', x: 1500, z: 100 }, { kind: 'tower', x: -1500, z: 0 }] }),
      { grid, relief: [hill] },
    );
    // On the hill: the terrain's 80 m, under the landform's 120 m top.
    expect(out.skylines[0].y).toBeCloseTo(80, 5);
    expect(out.landmarks.find((l) => l.x > 0)!.y).toBeCloseTo(80, 5);
    // Off any landform: on the flat ground.
    expect(out.landmarks.find((l) => l.x < 0)!.y).toBe(0);
  });

  it('keeps open country open (AC)', () => {
    const out = plan(form());
    expect(out.buildings).toEqual([]);
    expect(out.skylines).toEqual([]);
    expect(out.landmarks).toEqual([]);
    expect(BUILT_NEAR_M).toBe(600);
  });
});
