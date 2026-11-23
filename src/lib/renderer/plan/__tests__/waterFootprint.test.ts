// #742 VP-22 FR1 — the route's water footprint.
import { describe, expect, it } from 'vitest';
import { RouteCurve } from '../../math/curve';
import { vec3 } from '../../math/vec3';
import { buildWaterStrip } from '../waterStrip';
import { poolsOffWater, routeWaterFootprint } from '../waterFootprint';

describe('routeWaterFootprint', () => {
  const straight = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -200)], false);
  const water = buildWaterStrip(straight, { divisions: 20, edgesForProgress: () => ({ left: 10, right: 10 }) });
  const footprint = routeWaterFootprint(water);

  it('has one quad per pair of stations', () => {
    expect(footprint.quads).toBe(20);
  });

  it('contains the channel and not the land beside it', () => {
    expect(footprint.contains(0, -100)).toBe(true);
    expect(footprint.contains(9, -100)).toBe(true);
    expect(footprint.contains(12, -100)).toBe(false);
    expect(footprint.contains(0, 50)).toBe(false);
  });

  it('keeps the shoreline itself out, by the margin', () => {
    expect(footprint.contains(10, -100)).toBe(false);
    expect(footprint.contains(9.7, -100)).toBe(false);
    expect(footprint.contains(9.7, -100, 0.1)).toBe(true);
  });

  it('does not treat the seams between stations as shore', () => {
    // Station 10 is at z = −100: a point on that cross seam is still water.
    expect(footprint.contains(0, -100)).toBe(true);
    expect(footprint.contains(5, -110)).toBe(true);
  });

  it('is empty for a strip with one station', () => {
    const none = routeWaterFootprint({ positions: new Float32Array(6) });
    expect(none.quads).toBe(0);
    expect(none.contains(0, 0)).toBe(false);
  });
});

// #742 FR3 — scenery placed on any part of the route's water is taken out.
describe('poolsOffWater', () => {
  const straight = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -200)], false);
  const footprint = routeWaterFootprint(buildWaterStrip(straight, { divisions: 20, edgesForProgress: () => ({ left: 10, right: 10 }) }));

  it('drops the instances on water, keeping each kept instance\'s metadata', () => {
    const pool = {
      kind: 'foliage',
      positions: new Float32Array([20, 0, -50, 0, 0, -50, -20, 0, -60, 5, 0, -70]),
      metadata: new Uint32Array([1, 2, 3, 4]),
    };
    const { pools, rejected } = poolsOffWater([pool], footprint);
    expect(rejected).toBe(2);
    expect(Array.from(pools[0].positions)).toEqual([20, 0, -50, -20, 0, -60]);
    expect(Array.from(pools[0].metadata!)).toEqual([1, 3]);
    expect(pools[0].kind).toBe('foliage');
  });

  it('returns an untouched pool as it was and drops a pool with nothing left', () => {
    const dry = { positions: new Float32Array([30, 0, -10]) };
    const wet = { positions: new Float32Array([0, 0, -10]) };
    const { pools, rejected } = poolsOffWater([dry, wet], footprint);
    expect(pools).toEqual([dry]);
    expect(pools[0]).toBe(dry);
    expect(rejected).toBe(1);
  });

  it('keeps a pool without metadata free of it', () => {
    const pool: { positions: Float32Array; metadata?: Uint32Array } = { positions: new Float32Array([30, 0, -10, 0, 0, -10]) };
    const { pools } = poolsOffWater([pool], footprint);
    expect(pools[0].metadata).toBeUndefined();
  });
});
