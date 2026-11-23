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
