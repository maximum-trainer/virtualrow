import { describe, expect, it } from 'vitest';
import {
  LANDSCAPE_GRID_MAX_POINTS,
  LANDSCAPE_GRID_MIN_SPACING_M,
  LANDSCAPE_REACH_M,
  distanceToCourse,
  latticeAt,
  latticeLat,
  latticeLng,
  latticeSceneXZ,
  latticeSpacingForRung,
  planElevationLattice,
  routeFrame,
} from '../lib/services/landscapeArea';
import { latLngToMeters } from '../lib/utils/geoUtils';

const line = (from: { lat: number; lng: number }, to: { lat: number; lng: number }, n = 20) =>
  Array.from({ length: n + 1 }, (_, i) => ({
    lat: from.lat + ((to.lat - from.lat) * i) / n,
    lng: from.lng + ((to.lng - from.lng) * i) / n,
  }));

describe('routeFrame', () => {
  it('is null without a usable coordinate, and simplifies a straight course to its ends', () => {
    expect(routeFrame([])).toBeNull();
    expect(routeFrame([{ lat: Number.NaN, lng: 0 }])).toBeNull();
    const frame = routeFrame(line({ lat: 51.5, lng: -0.1 }, { lat: 51.5, lng: -0.07 }))!;
    expect(frame.origin).toEqual({ lat: 51.5, lng: -0.1 });
    expect(frame.simplified).toHaveLength(2);
    expect(frame.points[0]).toEqual({ x: 0, y: 0 });
  });

  it('measures distance to a one-point course as distance to that point', () => {
    const frame = routeFrame([{ lat: 51.5, lng: -0.1 }])!;
    expect(distanceToCourse(frame, 3, 4)).toBeCloseTo(5);
  });
});

describe('the elevation lattice (FR2, FR3a, FR3c)', () => {
  it('uses the finest 90 m spacing for a short course', () => {
    const frame = routeFrame(line({ lat: 51.5, lng: -0.1 }, { lat: 51.5, lng: -0.095 }))!;
    const lattice = planElevationLattice(frame, 100_000);
    expect(lattice.spacingM).toBe(LANDSCAPE_GRID_MIN_SPACING_M);
  });

  it('coarsens a long course to stay under 2,000 points, at the finest rung that fits', () => {
    const frame = routeFrame(line({ lat: 57.1, lng: -4.7 }, { lat: 57.4, lng: -4.3 }, 60))!;
    const lattice = planElevationLattice(frame);
    expect(lattice.count).toBeLessThanOrEqual(LANDSCAPE_GRID_MAX_POINTS);
    expect(lattice.spacingM).toBeGreaterThan(LANDSCAPE_GRID_MIN_SPACING_M);
    const rung = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((k) => latticeSpacingForRung(k) === lattice.spacingM)!;
    expect(latticeAt(frame, latticeSpacingForRung(rung - 1)).count).toBeGreaterThan(LANDSCAPE_GRID_MAX_POINTS);
  });

  it('steps down from an estimate that was too coarse', () => {
    // A tight loop: its length overstates its area, so the first guess is coarse.
    const loop = Array.from({ length: 41 }, (_, i) => ({
      lat: 51.5 + 0.002 * Math.sin((i / 40) * 2 * Math.PI * 6),
      lng: -0.1 + 0.003 * Math.cos((i / 40) * 2 * Math.PI * 6),
    }));
    const frame = routeFrame(loop)!;
    const lattice = planElevationLattice(frame, 2000);
    expect(lattice.count).toBeLessThanOrEqual(2000);
    if (lattice.spacingM > LANDSCAPE_GRID_MIN_SPACING_M) {
      const finer = latticeSpacingForRung(
        [1, 2, 3, 4, 5, 6].find((k) => latticeSpacingForRung(k) === lattice.spacingM)! - 1,
      );
      expect(latticeAt(frame, finer).count).toBeGreaterThan(2000);
    }
  });

  it('covers the buffered line, not its bounding box, on a diagonal course', () => {
    const frame = routeFrame(line({ lat: 52.0, lng: 4.0 }, { lat: 52.2, lng: 4.35 }))!;
    const lattice = planElevationLattice(frame);
    // A 2 km buffer round a ~32 km diagonal fills well under half its box.
    expect(lattice.count / (lattice.cols * lattice.rows)).toBeLessThan(0.4);
    // The box corner far from the line is outside.
    expect(lattice.inside[(lattice.rows - 1) * lattice.cols]).toBe(0);
    for (let row = 0; row < lattice.rows; row += 7) {
      for (let col = 0; col < lattice.cols; col += 7) {
        const m = latLngToMeters(latticeLat(lattice, row), latticeLng(lattice, col), frame.origin.lat, frame.origin.lng);
        const inside = distanceToCourse(frame, m.x, m.y) <= LANDSCAPE_REACH_M + 1;
        if (lattice.inside[row * lattice.cols + col]) expect(inside).toBe(true);
      }
    }
  });

  it('puts two routes on the same water on the same lattice points', () => {
    const a = routeFrame(line({ lat: 51.5, lng: -0.1 }, { lat: 51.5, lng: -0.07 }))!;
    const b = routeFrame(line({ lat: 51.501, lng: -0.09 }, { lat: 51.502, lng: -0.06 }))!;
    const la = latticeAt(a, 90);
    const lb = latticeAt(b, 90);
    expect(la.dLat).toBe(lb.dLat);
    expect(la.dLng).toBe(lb.dLng);
    const pointsOf = (l: typeof la) => {
      const set = new Set<string>();
      for (let r = 0; r < l.rows; r += 1) for (let c = 0; c < l.cols; c += 1) set.add(`${latticeLat(l, r)},${latticeLng(l, c)}`);
      return set;
    };
    const pa = pointsOf(la);
    const shared = [...pointsOf(lb)].filter((p) => pa.has(p));
    expect(shared.length).toBeGreaterThan(la.cols * la.rows * 0.5);
  });

  it('maps the lattice onto a regular scene-XZ grid in the routeCurvePoints frame', () => {
    const frame = routeFrame(line({ lat: 51.5, lng: -0.1 }, { lat: 51.52, lng: -0.05 }))!;
    const lattice = planElevationLattice(frame);
    const { originX, originZ, stepX, stepZ } = latticeSceneXZ(lattice, frame.origin);
    expect(stepZ).toBeLessThan(0);
    const row = lattice.rows - 1;
    const col = lattice.cols - 1;
    const m = latLngToMeters(
      (lattice.lat0Index + row) * lattice.dLat,
      (lattice.lng0Index + col) * lattice.dLng,
      frame.origin.lat,
      frame.origin.lng,
    );
    expect(originX + col * stepX).toBeCloseTo(m.x, 3);
    expect(originZ + row * stepZ).toBeCloseTo(-m.y, 3);
  });
});
