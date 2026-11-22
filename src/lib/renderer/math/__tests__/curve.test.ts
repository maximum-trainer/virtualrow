import { describe, expect, it } from 'vitest';
import { RouteCurve } from '../curve';
import { vec3 } from '../vec3';

describe('RouteCurve', () => {
  it('samples a single-point curve', () => {
    const c = new RouteCurve([vec3(1, 2, 3)]);
    const s = c.sample(0.5);
    expect([s.position[0], s.position[1], s.position[2]]).toEqual([1, 2, 3]);
    expect(s.angle).toBe(0);
  });

  it('returns a sensible default on an empty curve', () => {
    const c = new RouteCurve([]);
    const s = c.sample(0.3);
    expect([...s.position]).toEqual([0, 0, 0]);
    expect(s.tangent[2]).toBe(-1);
  });

  it('samples position along a straight line', () => {
    const c = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -10)]);
    const s = c.sample(0.5);
    expect(s.position[2]).toBeCloseTo(-5, 1);
  });

  it('samples a closed loop by wrapping', () => {
    const c = new RouteCurve(
      [vec3(0, 0, 0), vec3(10, 0, 0), vec3(10, 0, -10), vec3(0, 0, -10)],
      true,
    );
    expect(c.length).toBe(4);
    const s = c.sample(1);
    // At t=1 we are back at the start of a closed loop.
    expect(Math.hypot(s.position[0], s.position[2])).toBeLessThan(0.1);
  });

  it('approximates the length of a straight segment', () => {
    const c = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -100)]);
    const len = c.approximateLength(32);
    expect(len).toBeGreaterThan(95);
    expect(len).toBeLessThan(105);
  });

  it('returns zero length when there is nothing to measure', () => {
    expect(new RouteCurve([]).approximateLength()).toBe(0);
    expect(new RouteCurve([vec3(0, 0, 0)]).approximateLength()).toBe(0);
  });

  it('clamps progress to [0, 1]', () => {
    const c = new RouteCurve([vec3(0, 0, 0), vec3(10, 0, 0)]);
    expect(c.sample(-1).position[0]).toBeLessThan(1);
    expect(c.sample(2).position[0]).toBeGreaterThan(9);
  });

  // --- Arc-length parameterisation (ported from the React scene's
  // `getCurveDistances` + `distanceToProgress`, src/components/rower3d/curve.ts
  // before #542). `progress` is a fraction of the route's LENGTH, so the boat
  // covers equal metres for equal progress however unevenly the control points
  // are spaced.
  describe('arc-length sampling', () => {
    // Spacing as the route pipeline really produces it: 5 m steps where a
    // short span was subdivided, 10 m steps elsewhere. A uniform-parameter
    // sampler reaches only 40 m of this 100 m line at progress 0.5.
    const uneven = (): RouteCurve =>
      new RouteCurve(
        [0, 5, 10, 15, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((d) => vec3(0, 0, -d)),
      );

    it('puts half progress at half the distance on unevenly spaced points', () => {
      expect(uneven().sample(0.5).position[2]).toBeCloseTo(-50, 0);
    });

    it('advances equal distance for equal progress steps', () => {
      const c = uneven();
      const steps: number[] = [];
      let prev = c.sample(0).position[2];
      for (let i = 1; i <= 20; i += 1) {
        const z = c.sample(i / 20).position[2];
        steps.push(Math.abs(z - prev));
        prev = z;
      }
      const min = Math.min(...steps);
      const max = Math.max(...steps);
      expect(max / min).toBeLessThan(1.05);
    });

    it('still exposes the raw spline parameter for callers that need it', () => {
      const c = uneven();
      // Parameter 0.5 of 12 spans is the seventh control point.
      expect(c.sampleUniform(0.5).position[2]).toBeCloseTo(-40, 1);
    });

    it('measures a bend by its arc, not its chord', () => {
      // Quarter circle of radius 100 m in 10 degree steps: arc is 157.08 m.
      const pts = [];
      for (let d = 0; d <= 90; d += 10) {
        const a = (d * Math.PI) / 180;
        pts.push(vec3(100 * Math.sin(a), 0, -100 * (1 - Math.cos(a))));
      }
      const c = new RouteCurve(pts);
      expect(c.lengthMeters).toBeGreaterThan(156.5);
      expect(c.lengthMeters).toBeLessThan(157.6);
      // The old 32-chord estimate is replaced by the table; both entry points agree.
      expect(c.approximateLength(4)).toBeCloseTo(c.lengthMeters, 6);
    });

    it('maps distance to progress and back', () => {
      const c = uneven();
      expect(c.progressAtDistance(25)).toBeCloseTo(0.25, 3);
      expect(c.progressAtDistance(-5)).toBe(0);
      expect(c.progressAtDistance(1e9)).toBe(1);
    });
  });

  // --- Closed loops (ported from `createRouteCurve`'s `points.pop()`): a lap
  // course arrives with its last point on top of its first. Kept, that
  // duplicate makes a zero-length span at the seam and the tangent there flips.
  describe('closed-loop seam', () => {
    const lap = (): RouteCurve =>
      new RouteCurve(
        [vec3(0, 0, 0), vec3(100, 0, 0), vec3(100, 0, -100), vec3(0, 0, -100), vec3(0.5, 0, 0.2)],
        true,
      );

    it('drops a duplicated closing point', () => {
      expect(lap().length).toBe(4);
    });

    it('keeps the heading continuous across the seam', () => {
      const c = lap();
      const before = c.sample(0.999).angle;
      const after = c.sample(0.001).angle;
      let d = Math.abs(after - before);
      if (d > Math.PI) d = 2 * Math.PI - d;
      expect(d).toBeLessThan(0.1);
    });

    it('leaves an open route with coincident ends alone', () => {
      const c = new RouteCurve([vec3(0, 0, 0), vec3(10, 0, 0), vec3(10, 0, -10), vec3(0, 0, 0)], false);
      expect(c.length).toBe(4);
    });
  });
});
