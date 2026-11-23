import { describe, expect, it } from 'vitest';
import { bridgeParallelLegs, islandLand, PARALLEL_LEG_OVERLAP_METRES } from '../parallelLegs';
import { buildBankStrips } from '../bankStrip';
import { buildWaterStrip } from '../waterStrip';
import { routeWaterFootprint, surfaceAt } from '../waterFootprint';
import { RouteCurve } from '../../math/curve';
import { vec3 } from '../../math/vec3';

// #742 VP-22 FR2 — two legs closer than their waters plus a bank's width
// have water between them, not a spit of grass.

/** A 2 km out-and-back whose legs run `spacing` metres apart, centre to centre. */
const outAndBack = (spacing: number): RouteCurve => {
  const pts = [];
  for (let z = 0; z >= -1000; z -= 50) pts.push(vec3(0, 0, z));
  const r = spacing / 2;
  for (let k = 1; k < 8; k += 1) {
    const a = (k / 8) * Math.PI;
    pts.push(vec3(r - r * Math.cos(a), 0, -1000 - r * Math.sin(a)));
  }
  for (let z = -1000; z <= 0; z += 50) pts.push(vec3(spacing, 0, z));
  return new RouteCurve(pts, false);
};
const narrow = () => ({ left: 10, right: 10 });

describe('bridgeParallelLegs (#742 FR2)', () => {
  it('widens each leg on the side facing the other until the waters meet', () => {
    const curve = outAndBack(60); // shores 40 m apart, under a 60 m bank
    const { edgesForProgress, bridged } = bridgeParallelLegs(curve, narrow);
    expect(bridged).toBeGreaterThan(0);
    // Outbound (heading -Z): the right side faces the return leg at x = 60.
    const out = edgesForProgress(0.2);
    expect(out.left).toBeCloseTo(10, 5);
    // From the centreline to the return leg's near shore is 60 - 10 m.
    expect(out.right).toBeCloseTo(50 + PARALLEL_LEG_OVERLAP_METRES, 1);
    // Return (heading +Z): its right side faces back towards x = 0.
    const back = edgesForProgress(0.8);
    expect(back.left).toBeCloseTo(10, 5);
    expect(back.right).toBeCloseTo(50 + PARALLEL_LEG_OVERLAP_METRES, 1);
  });

  it('leaves no grass between the legs', () => {
    const curve = outAndBack(60);
    const { edgesForProgress } = bridgeParallelLegs(curve, narrow);
    const water = routeWaterFootprint(buildWaterStrip(curve, { edgesForProgress }));
    for (let z = -100; z >= -900; z -= 10) {
      for (let x = 5; x <= 55; x += 5) {
        expect(water.contains(x, z, 0), `water at (${x}, ${z})`).toBe(true);
      }
    }
    const bank = buildBankStrips({ curve, edgesForProgress });
    for (let o = 0; o < bank.indices.length; o += 3) {
      const [i0, i1, i2] = [bank.indices[o], bank.indices[o + 1], bank.indices[o + 2]];
      if (i0 === i1 && i1 === i2) continue;
      const cx = (bank.positions[i0 * 3] + bank.positions[i1 * 3] + bank.positions[i2 * 3]) / 3;
      const cz = (bank.positions[i0 * 3 + 2] + bank.positions[i1 * 3 + 2] + bank.positions[i2 * 3 + 2]) / 3;
      const between = cx > 12 && cx < 48 && cz < -100 && cz > -900;
      expect(between, `bank triangle at (${cx.toFixed(1)}, ${cz.toFixed(1)})`).toBe(false);
    }
  });

  it('keeps the boat on water every 10 m of the course (FR6 scenario)', () => {
    const curve = outAndBack(30);
    const { edgesForProgress } = bridgeParallelLegs(curve, narrow);
    const water = routeWaterFootprint(buildWaterStrip(curve, { edgesForProgress }));
    const length = curve.approximateLength(64);
    const sample = { position: vec3(), tangent: vec3(0, 0, -1), angle: 0 };
    for (let m = 0; m <= length; m += 10) {
      curve.sample(m / length, sample);
      expect(surfaceAt(water, undefined, sample.position[0], sample.position[2]), `at ${m} m`).toBe('water');
    }
  });

  it('flags the parallel stretches of the course as selfParallel', () => {
    const { selfParallel } = bridgeParallelLegs(outAndBack(60), narrow);
    const flagged = (t: number) => selfParallel.some(([a, b]) => t >= a && t <= b);
    for (let t = 0; t <= 0.45; t += 0.01) expect(flagged(t), `outbound at ${t.toFixed(2)}`).toBe(true);
    for (let t = 0.55; t <= 1; t += 0.01) expect(flagged(t), `return at ${t.toFixed(2)}`).toBe(true);
    expect(flagged(0.5), 'the apex of the turn').toBe(false);
    for (const [a, b] of selfParallel) expect(a).toBeLessThanOrEqual(b);
  });

  it('flags legs whose waters already overlap, without widening them', () => {
    const { edgesForProgress, selfParallel } = bridgeParallelLegs(outAndBack(15), narrow);
    expect(selfParallel.length).toBeGreaterThan(0);
    expect(edgesForProgress(0.2)).toEqual({ left: 10, right: 10 });
  });

  it('keeps the bank between legs further apart than a bank is wide', () => {
    const { edgesForProgress, bridged, selfParallel } = bridgeParallelLegs(outAndBack(200), narrow);
    expect(bridged).toBe(0);
    expect(selfParallel).toEqual([]);
    expect(edgesForProgress(0.2)).toEqual({ left: 10, right: 10 });
  });

  it('leaves a single-leg river alone', () => {
    const curve = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -1000)], false);
    const { edgesForProgress, bridged, selfParallel } = bridgeParallelLegs(curve, narrow);
    expect(bridged).toBe(0);
    expect(selfParallel).toEqual([]);
    expect(edgesForProgress(0.5)).toEqual({ left: 10, right: 10 });
  });

  it('keeps land that OSM maps between the legs (an island)', () => {
    const island = (x: number, z: number) => x > 20 && x < 40 && z < -300 && z > -700;
    const { edgesForProgress } = bridgeParallelLegs(outAndBack(60), narrow, { isLand: island });
    expect(edgesForProgress(0.25).right).toBeCloseTo(10, 5); // z ≈ -500: island between
    expect(edgesForProgress(0.05).right).toBeGreaterThanOrEqual(40); // z ≈ -100: open water
  });

  it('uses the symmetric default when the route has no measured edges', () => {
    const { edgesForProgress } = bridgeParallelLegs(outAndBack(80), undefined, { halfWidth: 20 });
    expect(edgesForProgress(0.2).left).toBeCloseTo(20, 5);
    expect(edgesForProgress(0.2).right).toBeGreaterThanOrEqual(40);
  });

  it('returns the input edges unchanged without a curve', () => {
    const { edgesForProgress, bridged } = bridgeParallelLegs(null, narrow);
    expect(bridged).toBe(0);
    expect(edgesForProgress(0.3)).toEqual({ left: 10, right: 10 });
  });
});

describe('islandLand (#742 FR2)', () => {
  it('is land inside a lake\'s island and water elsewhere', () => {
    const square = [{ x: 20, z: -300 }, { x: 40, z: -300 }, { x: 40, z: -700 }, { x: 20, z: -700 }];
    const land = islandLand([{ holes: [square] }])!;
    expect(land(30, -500)).toBe(true);
    expect(land(10, -500)).toBe(false);
    expect(land(30, -800)).toBe(false);
  });

  it('is undefined for a route with no islands', () => {
    expect(islandLand(undefined)).toBeUndefined();
    expect(islandLand([{ holes: [] }])).toBeUndefined();
  });
});

// A brute-force oracle: every station's ray against every shoreline of the
// strip more than `window` metres of route away, no grid. The fast search
// must agree with it on a course that is rotated, uneven and lopsided.
describe('bridgeParallelLegs against a brute-force search', () => {
  const rotate = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return (x: number, z: number) => vec3(x * Math.cos(a) - z * Math.sin(a), 0, x * Math.sin(a) + z * Math.cos(a));
  };
  /** Out-and-back with the return leg drifting from 50 m to 90 m away. */
  const skewed = (deg: number, mirror = 1): RouteCurve => {
    const at = rotate(deg);
    const pts = [];
    for (let z = 0; z >= -1000; z -= 50) pts.push(at(0, z));
    for (let k = 1; k < 8; k += 1) {
      const a = (k / 8) * Math.PI;
      pts.push(at(mirror * (45 - 45 * Math.cos(a)), -1000 - 45 * Math.sin(a)));
    }
    for (let z = -1000; z <= 0; z += 50) pts.push(at(mirror * (90 + (z / 1000) * 40), z));
    return new RouteCurve(pts, false);
  };
  const lopsided = (t: number) => ({ left: 6 + 4 * t, right: 14 - 6 * t });

  const oracle = (curve: RouteCurve, divisions: number, gap = 60) => {
    const p = buildWaterStrip(curve, { edgesForProgress: lopsided, divisions }).positions;
    const n = divisions + 1;
    const c: Array<[number, number]> = [];
    const u: Array<[number, number]> = [];
    const along: number[] = [];
    let widest = 0;
    for (let i = 0; i < n; i += 1) {
      const e = lopsided(i / divisions);
      const [lx, lz, rx, rz] = [p[i * 6], p[i * 6 + 2], p[i * 6 + 3], p[i * 6 + 5]];
      const len = Math.hypot(rx - lx, rz - lz);
      u.push([(rx - lx) / len, (rz - lz) / len]);
      const f = e.left / (e.left + e.right);
      c.push([lx + (rx - lx) * f, lz + (rz - lz) * f]);
      along.push(i === 0 ? 0 : along[i - 1] + Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]));
      widest = Math.max(widest, e.left, e.right);
    }
    const window = gap + 2 * widest;
    const out: Array<{ left: number; right: number }> = [];
    for (let i = 0; i < n; i += 1) {
      const e = lopsided(i / divisions);
      const res = { left: e.left, right: e.right };
      for (const side of [-1, 1]) {
        const edge = side < 0 ? e.left : e.right;
        const [dx, dz] = [u[i][0] * side, u[i][1] * side];
        let best = Infinity;
        for (let j = 0; j < divisions; j += 1) {
          if (Math.min(Math.abs(along[j] - along[i]), Math.abs(along[j + 1] - along[i])) < window) continue;
          for (const o of [0, 3]) {
            const [ax, az, bx, bz] = [p[j * 6 + o], p[j * 6 + o + 2], p[(j + 1) * 6 + o], p[(j + 1) * 6 + o + 2]];
            const [ex, ez] = [bx - ax, bz - az];
            const den = dx * ez - dz * ex;
            if (Math.abs(den) < 1e-12) continue;
            const [wx, wz] = [ax - c[i][0], az - c[i][1]];
            const t = (wx * ez - wz * ex) / den;
            const s = (wx * dz - wz * dx) / den;
            if (s >= 0 && s <= 1 && t > 0 && t <= edge + gap) best = Math.min(best, t);
          }
        }
        if (Number.isFinite(best) && best > edge) res[side < 0 ? 'left' : 'right'] = best + PARALLEL_LEG_OVERLAP_METRES;
      }
      out.push(res);
    }
    return out;
  };

  for (const [deg, mirror] of [[33, 1], [-120, 1], [71, -1]] as const) {
    it(`agrees at every station on a course turned ${deg}°${mirror < 0 ? ', mirrored' : ''}`, () => {
      const curve = skewed(deg, mirror);
      const divisions = 220;
      const { edgesForProgress, bridged } = bridgeParallelLegs(curve, lopsided, { divisions });
      const want = oracle(curve, divisions);
      let widened = 0;
      want.forEach((w, i) => {
        const got = edgesForProgress(i / divisions);
        expect(got.left, `left at station ${i}`).toBeCloseTo(w.left, 4);
        expect(got.right, `right at station ${i}`).toBeCloseTo(w.right, 4);
        const base = lopsided(i / divisions);
        widened += Number(w.left !== base.left) + Number(w.right !== base.right);
      });
      expect(bridged).toBe(widened);
      expect(widened).toBeGreaterThan(50);
    });
  }

  it('interpolates between stations', () => {
    const curve = skewed(33);
    const divisions = 220;
    const { edgesForProgress } = bridgeParallelLegs(curve, lopsided, { divisions });
    const i = 40;
    const a = edgesForProgress(i / divisions);
    const b = edgesForProgress((i + 1) / divisions);
    const mid = edgesForProgress((i + 0.25) / divisions);
    expect(mid.right).toBeCloseTo(a.right + (b.right - a.right) * 0.25, 6);
    expect(mid.left).toBeCloseTo(a.left + (b.left - a.left) * 0.25, 6);
    expect(edgesForProgress(-1)).toEqual(edgesForProgress(0));
    expect(edgesForProgress(2)).toEqual(edgesForProgress(1));
  });

  it('honours a narrower gap', () => {
    const curve = skewed(0);
    const { edgesForProgress } = bridgeParallelLegs(curve, lopsided, { gap: 20, divisions: 220 });
    // Along the straights the shores are 30-70 m apart: nothing within 20 m.
    for (let i = 0; i <= 220; i += 11) {
      if (i > 80 && i < 140) continue; // the turn
      expect(edgesForProgress(i / 220)).toEqual(lopsided(i / 220));
    }
  });
});

describe('bridgeParallelLegs land checks', () => {
  it('keeps a gap with land only where the far shore begins', () => {
    // Land in a 2 m strip at x 48..50, right against the return leg's shore.
    const land = (x: number) => x >= 48.5 && x <= 50.5;
    const { edgesForProgress } = bridgeParallelLegs(outAndBack(60), narrow, { isLand: land });
    expect(edgesForProgress(0.25).right).toBeCloseTo(10, 5);
  });

  it('keeps a gap with land only beside the near shore', () => {
    const land = (x: number) => x >= 10 && x <= 11;
    const { edgesForProgress } = bridgeParallelLegs(outAndBack(60), narrow, { isLand: land });
    expect(edgesForProgress(0.25).right).toBeCloseTo(10, 5);
  });

  it('does not look for land beyond the far shore', () => {
    const land = (x: number) => x > 52;
    const { edgesForProgress } = bridgeParallelLegs(outAndBack(60), narrow, { isLand: land });
    expect(edgesForProgress(0.25).right).toBeCloseTo(50 + PARALLEL_LEG_OVERLAP_METRES, 1);
  });

  it('returns the input for a curve of one point', () => {
    const { edgesForProgress, bridged, selfParallel } = bridgeParallelLegs(new RouteCurve([vec3(0, 0, 0)], false), narrow);
    expect(bridged).toBe(0);
    expect(selfParallel).toEqual([]);
    expect(edgesForProgress(0.5)).toEqual({ left: 10, right: 10 });
  });
});

describe('islandLand edge cases', () => {
  const tri = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 10 }];
  it('tests every island ring, and ignores rings of fewer than three points', () => {
    const land = islandLand([
      { holes: [[{ x: 100, z: 100 }, { x: 101, z: 101 }]] },
      { holes: [tri, [{ x: 50, z: 50 }, { x: 60, z: 50 }, { x: 60, z: 60 }, { x: 50, z: 60 }]] },
    ])!;
    expect(land(2, 2)).toBe(true);
    expect(land(8, 8)).toBe(false); // across the triangle's hypotenuse
    expect(land(55, 55)).toBe(true);
    expect(land(100.5, 100.2)).toBe(false);
    expect(land(-1, 5)).toBe(false);
    expect(land(5, -1)).toBe(false);
    expect(land(4, 6.1)).toBe(false);
    expect(land(4, 5.9)).toBe(true);
  });

  it('is undefined when every ring is too short to enclose anything', () => {
    expect(islandLand([{ holes: [[{ x: 0, z: 0 }, { x: 1, z: 1 }]] }])).toBeUndefined();
  });
});
