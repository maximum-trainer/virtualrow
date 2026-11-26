import { describe, expect, it } from 'vitest';
import { LandscapeService } from '../lib/services/landscapeService';
import { LANDSCAPE_GRID_MIN_SPACING_M } from '../lib/services/landscapeArea';
import heerenveen from './fixtures/landscape/277.json';
import { expectLandscapePortContract } from './helpers/landscapePortContract';

/**
 * #762 TDD step 3 — one live call per landscape source (Open-Meteo GLO-90,
 * Overpass), asserting the shape we read and nothing about the content.
 *
 * Network-dependent, so opt-in like the mirror contract: run with
 * `npm run test:contract:landscape`. The cloud sandbox cannot reach either
 * host; run it from a desktop or an Actions runner.
 */
const enabled = process.env.LANDSCAPE_CONTRACT_CHECK === '1';

describe.skipIf(!enabled)('landscape sources contract (live network)', () => {
  const route = (heerenveen as { route: { lat: number; lng: number }[] }).route;

  it('loads every layer from the network in the shape the scene reads', async () => {
    const landscape = await new LandscapeService({ cache: null, publish: false }).load(route);

    expect(landscape.elevation.source).toBe('network');
    const grid = landscape.elevation.data!;
    expect(grid.heights).toBeInstanceOf(Float32Array);
    expect(grid.heights.length).toBe(grid.cols * grid.rows);
    expect(grid.spacingM).toBeGreaterThanOrEqual(LANDSCAPE_GRID_MIN_SPACING_M);
    expect(Array.from(grid.heights).some(Number.isFinite)).toBe(true);

    expect(landscape.landCover.source).toBe('network');
    for (const f of landscape.landCover.data!) {
      expect(['polygon', 'line']).toContain(f.shape);
      expect(f.points.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z))).toBe(true);
    }

    expect(landscape.built.source).toBe('network');
    const built = landscape.built.data!;
    expect(Array.isArray(built.footprints)).toBe(true);
    expect(Array.isArray(built.places)).toBe(true);
    expect(Array.isArray(built.landmarks)).toBe(true);

    // #762 AC-R1: the live sources keep the same port contract as every other backend.
    expectLandscapePortContract(landscape, route);
  }, 180_000);
});
