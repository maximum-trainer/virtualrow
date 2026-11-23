// #742 VP-22 FR1 — the route's water footprint.
import { describe, expect, it } from 'vitest';
import { RouteCurve } from '../../math/curve';
import { vec3 } from '../../math/vec3';
import { buildWaterStrip } from '../waterStrip';
import { lakeWater, poolsOffWater, routeWaterFootprint, surfaceAt, withLakes } from '../waterFootprint';

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

// #742 FR6 — the surface under the boat.
describe('surfaceAt', () => {
  const straight = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -200)], false);
  const footprint = routeWaterFootprint(buildWaterStrip(straight, { divisions: 20, edgesForProgress: () => ({ left: 10, right: 10 }) }));
  const ring = (x0: number, z0: number, x1: number, z1: number) => [
    { x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 },
  ];
  const lake = { outer: ring(50, -50, 150, -150), holes: [ring(90, -90, 110, -110)] };

  it('is water on the ribbon, up to its shore', () => {
    expect(surfaceAt(footprint, undefined, 0, -100)).toBe('water');
    expect(surfaceAt(footprint, undefined, 9.9, -100)).toBe('water');
  });

  it('is water at the ribbon\'s own end, where the boat waits on the start line', () => {
    expect(surfaceAt(footprint, undefined, 0, 0)).toBe('water');
    expect(surfaceAt(footprint, undefined, 0, 2)).toBe('land');
  });

  it('is land off the ribbon with no lake there', () => {
    expect(surfaceAt(footprint, undefined, 30, -100)).toBe('land');
    expect(surfaceAt(footprint, lakeWater([lake]), 30, -100)).toBe('land');
  });

  it('is water on a lake and land on its island', () => {
    expect(surfaceAt(footprint, lakeWater([lake]), 70, -70)).toBe('water');
    expect(surfaceAt(footprint, lakeWater([lake]), 100, -100)).toBe('land');
  });
});

// #742 FR5 — the bank gives way to a drawn lake.
describe('withLakes', () => {
  const straight = new RouteCurve([vec3(0, 0, 0), vec3(0, 0, -200)], false);
  const footprint = routeWaterFootprint(buildWaterStrip(straight, { divisions: 20, edgesForProgress: () => ({ left: 10, right: 10 }) }));
  const ring = (x0: number, z0: number, x1: number, z1: number) => [
    { x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 },
  ];
  const lake = { outer: ring(-100, -20, 100, -180), holes: [ring(40, -90, 60, -110)] };

  it('is the route\'s water plus the lake, less its islands', () => {
    const water = withLakes(footprint, [lake]);
    expect(water.contains(0, -100)).toBe(true);
    expect(water.contains(80, -50)).toBe(true);
    expect(water.contains(50, -100)).toBe(false);
    expect(water.contains(80, -190)).toBe(false);
    expect(water.quads).toBe(footprint.quads);
  });

  it('is the route\'s own footprint when there are no lakes', () => {
    expect(withLakes(footprint, [])).toBe(footprint);
  });

  it('agrees with a plain even-odd test on a many-sided lake', () => {
    const n = 2000;
    const outer = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * 2 * Math.PI;
      const r = 300 + 40 * Math.sin(9 * a);
      return { x: r * Math.cos(a), z: r * Math.sin(a) };
    });
    const inLake = lakeWater([{ outer, holes: [] }])!;
    const plain = (x: number, z: number) => {
      let hit = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = outer[i];
        const b = outer[j];
        if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
      }
      return hit;
    };
    for (let x = -360; x <= 360; x += 23) {
      for (let z = -360; z <= 360; z += 17) expect(inLake(x, z), `(${x}, ${z})`).toBe(plain(x, z));
    }
  });

  it('has no lake test without lakes', () => {
    expect(lakeWater([])).toBeUndefined();
  });
});
