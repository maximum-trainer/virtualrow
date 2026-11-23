// #742 VP-22 FR1 — the route's water footprint.
import { describe, expect, it } from 'vitest';
import { RouteCurve } from '../../math/curve';
import { vec3 } from '../../math/vec3';
import { buildWaterStrip } from '../waterStrip';
import { routeWaterFootprint } from '../waterFootprint';

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
