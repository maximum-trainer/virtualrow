// #725 — every-leg clearance measures against the spline as drawn.
import { describe, expect, it } from 'vitest';
import { CENTRELINE_SAMPLE_METRES, centrelineIndex, sampledCentreline } from '../everyLegClearance';
import { RouteCurve } from '../../renderer/math/curve';
import { vec3 } from '../../renderer/math/vec3';

describe('sampledCentreline (#725)', () => {
  it('samples the curve every ~5 m from start to finish', () => {
    const curve = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -500), vec3(0, 0, -1000)]);
    const pts = sampledCentreline(curve);
    expect(pts.length).toBe(Math.ceil(1000 / CENTRELINE_SAMPLE_METRES) + 1);
    expect(pts[0][2]).toBeCloseTo(0, 3);
    expect(pts[pts.length - 1][2]).toBeCloseTo(-1000, 1);
    for (let i = 1; i < pts.length; i++) {
      expect(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2])).toBeLessThanOrEqual(CENTRELINE_SAMPLE_METRES + 0.5);
    }
  });

  it('follows the spline where it swings wide of a sharp turn', () => {
    // A hairpin: the spline bulges past the turn point, the control polyline does not.
    const curve = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -400), vec3(40, 0, -400), vec3(40, 0, 0)]);
    const spline = centrelineIndex(sampledCentreline(curve));
    let far = 0;
    const s = sampledCentreline(curve);
    for (const p of s) far = Math.min(far, p[2]);
    // A point on the spline's apex is on the sampled centreline.
    const apex = s.find((p) => p[2] === far)!;
    expect(spline.distance(apex[0], apex[2], 5)).toBeLessThan(0.01);
  });
});
