// #745 VP-25 FR4 — strip rows follow the route's detail, not a fixed 10 m.
// Intent ported from the React scene's routeStripGeometry / curve tests:
// more geometry on a longer route, bounded at both ends, and bends earn rows.
import { describe, expect, it } from 'vitest';
import {
  adaptiveSegmentCount,
  MAX_ROWS,
  MAX_TURN_PER_ROW_DEGREES,
  MIN_ROWS,
  stripSchedule,
  TARGET_METRES_BETWEEN_ROWS,
} from '../stripSchedule';
import { buildWaterStrip, defaultStripDivisions } from '../waterStrip';
import { buildBankStrips, BANK_COLUMNS } from '../bankStrip';
import { RouteCurve } from '../../math/curve';
import { vec3 } from '../../math/vec3';
import { toEngineRoute } from '../../../ui/sceneryRoute';
import { willowbrookRiverCoordinates } from '../../../../data/seedRouteCoordinates';
import { WILLOWBROOK_ROUTE_ID } from '../../../../components/rower3d/sceneryTrack';
import type { WaterRoute } from '../../../types';

const straight = (metres: number) => new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -metres)]);
/** A straight run into a 60 m-radius hairpin and back out. */
const hairpin = () => {
  const pts = [];
  // Evenly spaced control points (~5 m), so the spline has no kinks of its own.
  for (let z = 0; z > -1000; z -= 5) pts.push(vec3(0, 0, z));
  for (let a = 0; a < 36; a++) {
    const th = (a / 36) * Math.PI;
    pts.push(vec3(60 - 60 * Math.cos(th), 0, -1000 - 60 * Math.sin(th)));
  }
  for (let z = -1000; z <= 0; z += 5) pts.push(vec3(120, 0, z));
  return new RouteCurve(pts);
};

const turnDegrees = (curve: RouteCurve, ts: Float64Array) => {
  const s = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };
  const p = Array.from(ts, (t) => { curve.sample(t, s); return [s.position[0], s.position[2]]; });
  let max = 0;
  for (let i = 2; i < p.length; i++) {
    const a = [p[i - 1][0] - p[i - 2][0], p[i - 1][1] - p[i - 2][1]];
    const b = [p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]];
    const cos = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));
    max = Math.max(max, (Math.acos(Math.min(1, cos)) * 180) / Math.PI);
  }
  return max;
};

describe('adaptive strip rows (#745 FR4)', () => {
  it('spends more rows on a longer route, between a floor and a ceiling', () => {
    expect(adaptiveSegmentCount(0)).toBe(MIN_ROWS);
    expect(adaptiveSegmentCount(Number.NaN)).toBe(MIN_ROWS);
    expect(adaptiveSegmentCount(500)).toBe(MIN_ROWS);
    expect(adaptiveSegmentCount(6000)).toBe(6000 / TARGET_METRES_BETWEEN_ROWS);
    expect(adaptiveSegmentCount(1e7)).toBe(MAX_ROWS);
  });

  it('samples a straight route at the target spacing, ascending from 0 to 1', () => {
    const ts = stripSchedule(straight(6000));
    expect(ts[0]).toBe(0);
    expect(ts[ts.length - 1]).toBe(1);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    expect(ts.length - 1).toBe(Math.ceil(6000 / TARGET_METRES_BETWEEN_ROWS));
  });

  it('pulls rows into a bend so no row turns much more than the target', () => {
    const curve = hairpin();
    const ts = stripSchedule(curve);
    expect(turnDegrees(curve, ts)).toBeLessThan(MAX_TURN_PER_ROW_DEGREES * 1.5);
    // The same count spread evenly turns far more on the hairpin.
    const even = Float64Array.from({ length: ts.length }, (_, i) => i / (ts.length - 1));
    expect(turnDegrees(curve, even)).toBeGreaterThan(turnDegrees(curve, ts) * 1.5);
  });

  it('water and banks share the rows, so their edges stay one polyline', () => {
    const curve = hairpin();
    const rows = stripSchedule(curve).length;
    const water = buildWaterStrip(curve);
    const bank = buildBankStrips({ curve, footprint: null });
    expect(water.positions.length / 6).toBe(rows);
    // The left bank's waterline column sits on the water's left edge, row by row.
    for (let r = 0; r < rows; r += 7) {
      const b = r * BANK_COLUMNS.length;
      expect(bank.positions[b * 3]).toBeCloseTo(water.positions[r * 6], 3);
      expect(bank.positions[b * 3 + 2]).toBeCloseTo(water.positions[r * 6 + 2], 3);
    }
  });

  it('does not raise the demo route\'s strip triangles', () => {
    const route = toEngineRoute({
      id: WILLOWBROOK_ROUTE_ID, name: 'Willowbrook', description: '', distance: 6.7, difficulty: 'easy', location: '',
      coordinates: willowbrookRiverCoordinates, elevationGain: 0, estimatedTime: 0, tags: [], createdAt: new Date('2026-01-01'),
    } as WaterRoute);
    const curve = new RouteCurve(route!.curvePoints!.map(([x, y, z]) => vec3(x, y, z)));
    const before = defaultStripDivisions(curve);
    expect(stripSchedule(curve).length - 1).toBeLessThanOrEqual(before);
  });
});
