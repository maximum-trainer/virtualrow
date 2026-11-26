import { expect } from 'vitest';
import type { Coordinate } from '../../lib/types/index';
import { BUILT_FOOTPRINT_REACH_M, type Landscape, type LandscapeLayer } from '../../lib/services/landscapeService';
import { LANDSCAPE_GRID_MIN_SPACING_M, distanceToCourse, routeFrame } from '../../lib/services/landscapeArea';

/**
 * #762 AC-R1 — what every `LandscapePort` backend promises, whatever its
 * source: the network service, its cache, the offline stub, the dense budget
 * fixture, and the live sources (`landscapeContract.test.ts`). One set of
 * assertions so a new backend cannot drift from the shape the scene reads.
 */
export const expectLandscapePortContract = (landscape: Landscape, route: Coordinate[]): void => {
  expect(typeof landscape.key).toBe('string');
  expect(landscape.key.length).toBeGreaterThan(0);
  if (route.length > 0) expect(landscape.origin).toEqual(route[0]);

  const layers: [string, LandscapeLayer<unknown>][] = [
    ['elevation', landscape.elevation],
    ['landCover', landscape.landCover],
    ['built', landscape.built],
  ];
  for (const [name, layer] of layers) {
    expect(['network', 'cache', 'unavailable'], name).toContain(layer.source);
    expect(Number.isFinite(layer.ms) && layer.ms >= 0, `${name}.ms`).toBe(true);
    expect(Number.isInteger(layer.count) && layer.count >= 0, `${name}.count`).toBe(true);
    // FR1: an unavailable layer carries no data, an available one always does.
    expect(layer.data === null, `${name}.data`).toBe(layer.source === 'unavailable');
  }

  const grid = landscape.elevation.data;
  if (grid) {
    expect(grid.heights).toBeInstanceOf(Float32Array);
    expect(grid.heights.length).toBe(grid.cols * grid.rows);
    expect(grid.spacingM).toBeGreaterThanOrEqual(LANDSCAPE_GRID_MIN_SPACING_M); // FR3, AC-R3
    expect(grid.stepX).toBeGreaterThan(0);
    expect(grid.stepZ).toBeLessThan(0);
    expect(landscape.elevation.count).toBeLessThanOrEqual(grid.cols * grid.rows);
    expect(Array.from(grid.heights).some(Number.isFinite)).toBe(true);
  }

  for (const f of landscape.landCover.data ?? []) {
    expect(['polygon', 'line']).toContain(f.shape);
    expect(typeof f.kind).toBe('string');
    expect(f.points.length).toBeGreaterThanOrEqual(2);
    expect(f.points.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z))).toBe(true);
  }

  const built = landscape.built.data;
  if (built) {
    expect(Array.isArray(built.footprints)).toBe(true);
    expect(Array.isArray(built.places)).toBe(true);
    expect(Array.isArray(built.landmarks)).toBe(true);
    const frame = routeFrame(route);
    for (const fp of built.footprints) {
      expect(fp.points.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z))).toBe(true);
      // FR5 / AC "city payload is bounded": no footprint beyond 600 m (scene z is -north).
      if (frame) {
        const nearest = Math.min(...fp.points.map(([x, z]) => distanceToCourse(frame, x, -z)));
        expect(nearest).toBeLessThanOrEqual(BUILT_FOOTPRINT_REACH_M + 1);
      }
    }
    for (const p of [...built.places, ...built.landmarks]) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);
    }
  }
};
