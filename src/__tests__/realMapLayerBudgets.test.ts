import { describe, it, expect } from 'vitest';
import type { WaterRoute, Coordinate } from '../lib/types/index';
import type { PerformanceMode } from '../lib/scenery/sceneryPlacement';
import { toEngineRoute } from '../lib/ui/sceneryRoute';
import { denseLandscapeFixture } from '../lib/services/denseLandscapeFixture';
import { TREELINE_BUDGET } from '../lib/scenery/landscapeScenery';
import { WOODLAND_TREE_BUDGET } from '../lib/scenery/woodlandTreePlan';
import { RELIEF_BUDGET } from '../lib/scenery/horizonRelief';
import { tierCapsFor } from '../lib/renderer/engine/tierCaps';

/**
 * #885 — the real-map layers (#763-#765) each hold to their per-tier budget on
 * a landscape dense enough to exceed every one of them (FR1, FR2, FR3). The
 * browser spec checks the same numbers on a GPU; this holds them in CI.
 */

const TIERS: PerformanceMode[] = ['basic', 'low', 'medium', 'high', 'extra-high'];
const MASK_CAP_BYTES = 4 * 1024 * 1024;
const COURSE_KM = 4;

/** A gently bending 4 km course, so every layer has both banks to fill. */
const coordinates: Coordinate[] = Array.from({ length: 41 }, (_, i) => ({
  lat: 52.2 + (i * 0.0009) / 1,
  lng: 5.1 + Math.sin(i / 8) * 0.004,
}));

const route = {
  id: 'budget-fixture',
  name: 'Budget fixture',
  description: '',
  distance: COURSE_KM,
  difficulty: 'easy',
  location: '',
  coordinates,
  elevationGain: 0,
  estimatedTime: 20,
  tags: [],
  createdAt: new Date(0),
} as unknown as WaterRoute;

const landscape = denseLandscapeFixture(coordinates);
const sceneFor = (tier: PerformanceMode) => toEngineRoute(route, null, tier, landscape);

describe('the dense landscape fixture (#885 FR1)', () => {
  it('holds every layer the budgets cover, more densely than any tier keeps', () => {
    expect(landscape).not.toBeNull();
    const built = landscape!.built.data!;
    const cover = landscape!.landCover.data!;
    expect(cover.some((f) => f.kind === 'wood' || f.kind === 'forest')).toBe(true);
    expect(cover.some((f) => f.kind === 'hedge')).toBe(true);
    expect(cover.some((f) => f.kind === 'coastline')).toBe(true);
    expect(built.places.some((p) => p.kind === 'town')).toBe(true);
    expect(built.landmarks.length).toBeGreaterThan(tierCapsFor('extra-high').maxLandmarks);
    expect(built.footprints.length).toBeGreaterThan(tierCapsFor('extra-high').maxBuildingsPerKm * COURSE_KM);
    expect(Math.max(...landscape!.elevation.data!.heights)).toBeGreaterThan(100);
  });

  it('is the same landscape every time', () => {
    const again = denseLandscapeFixture(coordinates)!;
    expect(again.landCover.data).toEqual(landscape!.landCover.data);
    expect(again.built.data).toEqual(landscape!.built.data);
    expect(again.elevation.data!.heights).toEqual(landscape!.elevation.data!.heights);
  });

  it('keeps the terrain at water level beside the course (#762)', () => {
    const grid = landscape!.elevation.data!;
    // Grid point nearest the course start (scene 0, 0).
    const col = Math.round((0 - grid.originX) / grid.stepX);
    const row = Math.round((0 - grid.originZ) / grid.stepZ);
    expect(Math.abs(grid.heights[row * grid.cols + col])).toBeLessThanOrEqual(2);
  });

  it('returns null for a course too short to lay anything along', () => {
    expect(denseLandscapeFixture([{ lat: 1, lng: 1 }])).toBeNull();
  });
});

describe.each(TIERS)('real-map layer budgets at %s (#885 FR2, FR3)', (tier) => {
  const scene = sceneFor(tier)!;
  const caps = tierCapsFor(tier);

  it('keeps treelines and wood-interior trees within budget', () => {
    expect(scene.landCoverSummary?.treelineInstances).toBeLessThanOrEqual(TREELINE_BUDGET[tier]);
    expect(scene.landCoverSummary?.woodlandTrees).toBeLessThanOrEqual(WOODLAND_TREE_BUDGET[tier]);
  });

  it('keeps the land-cover mask within 4 MB and reports its size', () => {
    expect(scene.landCoverSummary?.maskBytes).toBe(scene.landCover?.data.byteLength);
    expect(scene.landCoverSummary!.maskBytes).toBeLessThanOrEqual(MASK_CAP_BYTES);
  });

  it('keeps horizon landforms within budget per 4 km', () => {
    expect(scene.reliefSummary?.placed ?? 0).toBeLessThanOrEqual(RELIEF_BUDGET[tier]);
  });

  it('keeps skylines and landmarks within the tier caps', () => {
    expect(scene.builtSummary?.skylineInstances ?? 0).toBeLessThanOrEqual(caps.maxSkylineInstances);
    expect(scene.builtSummary?.landmarks ?? 0).toBeLessThanOrEqual(caps.maxLandmarks);
  });
});

describe('the budgets bind (#885 FR2)', () => {
  it.each(TIERS.filter((t) => t !== 'basic'))('fills every %s budget, so the caps are what stops each layer', (tier) => {
    const scene = sceneFor(tier)!;
    const caps = tierCapsFor(tier);
    expect(scene.landCoverSummary?.treelineInstances).toBe(TREELINE_BUDGET[tier]);
    expect(scene.landCoverSummary?.woodlandTrees).toBe(WOODLAND_TREE_BUDGET[tier]);
    expect(scene.builtSummary?.skylineInstances).toBe(caps.maxSkylineInstances);
    expect(scene.builtSummary?.landmarks).toBe(caps.maxLandmarks);
    // Landforms are also held per 4 km window of view (#763 FR7), which binds first.
    expect(scene.reliefSummary?.placed).toBeGreaterThan(0);
  });

  it('draws no landforms, skylines, landmarks or wood-interior trees at basic', () => {
    const scene = sceneFor('basic')!;
    expect(scene.reliefSummary?.placed ?? 0).toBe(0);
    expect(scene.builtSummary?.skylineInstances ?? 0).toBe(0);
    expect(scene.builtSummary?.landmarks ?? 0).toBe(0);
    expect(scene.landCoverSummary?.woodlandTrees ?? 0).toBe(0);
  });
});
