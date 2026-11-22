import { describe, it, expect } from 'vitest';
import type { Coordinate } from '../lib/types/index';
import {
  routeCurvePoints,
  upsampleRouteCoordinates,
  DEFAULT_ROUTE_POINT_RESOLUTION_METERS,
} from '../lib/utils/routeWorldCurve';

/**
 * #570 AC2 — the three-free route→world-curve transform the /row route feeds
 * the WebGPU engine. Convention (from the retiring scene's gpsToScenePoints,
 * SCENE_SCALE = 1 → world metres): origin = first point; X = east; Z = negated
 * north; Y = 0.
 */
describe('routeCurvePoints (#570 AC2)', () => {
  it('returns [] for fewer than two coordinates', () => {
    expect(routeCurvePoints([])).toEqual([]);
    expect(routeCurvePoints([{ lat: 10, lng: 10 }])).toEqual([]);
  });

  it('puts the first coordinate at the origin', () => {
    const points = routeCurvePoints([
      { lat: 51.5, lng: -0.1 },
      { lat: 51.5, lng: -0.099 },
    ]);
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points[0][0]).toBeCloseTo(0, 6);
    expect(points[0][1]).toBe(0);
    expect(points[0][2]).toBeCloseTo(0, 6);
  });

  it('maps east to +X with Z≈0 (one unit = one metre)', () => {
    // ~0.001° of longitude at the equator ≈ 111 m east.
    const points = routeCurvePoints([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.001 },
    ]);
    const last = points[points.length - 1];
    expect(last[0]).toBeGreaterThan(100);
    expect(last[0]).toBeLessThan(120);
    expect(last[2]).toBeCloseTo(0, 3);
    expect(points.every((p) => p[1] === 0)).toBe(true);
  });

  it('maps north to −Z (the boat runs in −Z)', () => {
    const points = routeCurvePoints([
      { lat: 0, lng: 0 },
      { lat: 0.001, lng: 0 },
    ]);
    const last = points[points.length - 1];
    expect(last[2]).toBeLessThan(-100);
    expect(last[0]).toBeCloseTo(0, 3);
  });

  it('densifies a long straight leg onto the resolution grid', () => {
    // ~111 m east → ceil(111/10) ≈ 12 subdivisions → more than the 2 inputs.
    const points = routeCurvePoints([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.001 },
    ]);
    expect(points.length).toBeGreaterThan(5);
    // X increases monotonically along a due-east leg.
    for (let i = 1; i < points.length; i++) {
      expect(points[i][0]).toBeGreaterThanOrEqual(points[i - 1][0]);
    }
  });
});

describe('upsampleRouteCoordinates', () => {
  it('leaves a route of under two points untouched', () => {
    const one: Coordinate[] = [{ lat: 1, lng: 2 }];
    expect(upsampleRouteCoordinates(one)).toBe(one);
  });

  it('keeps the endpoints and adds interior points on a long leg', () => {
    const coords: Coordinate[] = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.001 },
    ];
    const dense = upsampleRouteCoordinates(coords, DEFAULT_ROUTE_POINT_RESOLUTION_METERS);
    expect(dense.length).toBeGreaterThan(coords.length);
    expect(dense[0]).toEqual(coords[0]);
    expect(dense[dense.length - 1]).toEqual(coords[1]);
  });

  it('does not subdivide a leg shorter than the resolution', () => {
    // ~1 m apart — under the 10 m grid, so no interior points.
    const coords: Coordinate[] = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.00001 },
    ];
    expect(upsampleRouteCoordinates(coords)).toHaveLength(2);
  });
});

// The engine addresses everything along a route by `progress`: the boat, the
// ghost, shore widths, scenery bands, distance posts. That only works if
// progress means distance. `routeCurvePoints` yields points 5-10 m apart, so a
// curve sampled by raw spline parameter moves the boat at up to twice the
// speed on some stretches as on others for the same metres rowed.
describe('route points through the engine curve', () => {
  const stepsAlong = (sampleAt: (t: number) => { position: ArrayLike<number> }, n: number): number[] => {
    const out: number[] = [];
    let prev = sampleAt(0).position;
    for (let i = 1; i <= n; i += 1) {
      const p = sampleAt(i / n).position;
      out.push(Math.hypot(p[0] - prev[0], p[2] - prev[2]));
      prev = [p[0], p[1], p[2]];
    }
    return out;
  };

  it('moves the boat the same distance for every equal slice of the demo route', async () => {
    const { willowbrookRiverCoordinates } = await import('../data/seedRouteCoordinates');
    const { RouteCurve } = await import('../lib/renderer/math/curve');
    const { vec3 } = await import('../lib/renderer/math/vec3');
    const points = routeCurvePoints(willowbrookRiverCoordinates);
    const curve = new RouteCurve(points.map(([x, y, z]) => vec3(x, y, z)));

    const even = stepsAlong((t) => curve.sample(t), 400);
    const raw = stepsAlong((t) => curve.sampleUniform(t), 400);

    expect(Math.max(...even) / Math.min(...even)).toBeLessThan(1.03);
    // What the engine did before: the same slices by raw parameter (22% spread
    // on this route; more where a short span sits beside a long one).
    expect(Math.max(...raw) / Math.min(...raw)).toBeGreaterThan(1.15);
  });
});
