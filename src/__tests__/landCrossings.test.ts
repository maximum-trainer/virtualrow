import { describe, it, expect } from 'vitest';

import { LAND_CROSSING_MIN_M, findLandCrossings, landCrossingNote } from '../lib/services/landCrossings';
import type { Coordinate } from '../lib/types/index';

// #752 FR1: a gate-chain leg tested against the water around it.

const ORIGIN = { lat: 52, lng: 0 };
const M_PER_DEG_LAT = 111_320;
const LNG_SCALE = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const at = (x: number, y: number): Coordinate => ({
  lat: ORIGIN.lat + y / M_PER_DEG_LAT,
  lng: ORIGIN.lng + x / LNG_SCALE,
});
const geom = (points: [number, number][]) =>
  points.map(([x, y]) => {
    const c = at(x, y);
    return { lat: c.lat, lon: c.lng };
  });
const area = (...points: [number, number][]) => ({
  type: 'way',
  tags: { natural: 'water', water: 'river' },
  geometry: geom([...points, points[0]]),
});

/**
 * A river 100 m wide running north 1 km, east 1 km past a peninsula, then
 * back north: a U round land. Polygon traced as one outline.
 */
const U_RIVER = area(
  [-50, 0], [50, 0], [50, 950], [1050, 950], [1050, 0], [1150, 0],
  [1150, 2000], [1050, 2000], [1050, 1050], [-50, 1050],
);

describe('findLandCrossings (#752 FR1)', () => {
  it('flags a leg whose straight line leaves the river for about 300 m', () => {
    // Two arms joined by water further north: from the west arm straight to
    // the east one, the line crosses the 300 m of land between them.
    const neck = area(
      [-50, 0], [50, 0], [50, 400], [350, 400], [350, 0], [450, 0],
      [450, 1000], [350, 1000], [350, 600], [50, 600], [50, 1000], [-50, 1000],
    );
    const crossings = findLandCrossings(
      [
        { name: 'Start', center: at(0, 300) },
        { name: 'Finish', center: at(400, 300) },
      ],
      [neck],
    );

    expect(crossings).toHaveLength(1);
    expect(crossings![0].fromGate).toBe('Start');
    expect(crossings![0].toGate).toBe('Finish');
    expect(crossings![0].metres).toBeGreaterThan(280);
    expect(crossings![0].metres).toBeLessThan(320);
    expect(crossings![0].from).toEqual(at(0, 300));
    expect(crossings![0].to).toEqual(at(400, 300));
  });

  it('leaves legs on the water alone, and a graze under the threshold', () => {
    const crossings = findLandCrossings(
      [
        { name: 'Start', center: at(0, 100) },
        { name: '500 m', center: at(0, 900) },
        // Cuts the inside corner by a few metres only.
        { name: 'Bend', center: at(100, 1000) },
      ],
      [U_RIVER],
    );
    expect(crossings).toEqual([]);
    expect(LAND_CROSSING_MIN_M).toBe(20);
  });

  it('counts a river mapped only as a centreline as water out to its half width', () => {
    const line = { type: 'way', tags: { waterway: 'river' }, geometry: geom([[0, 0], [0, 2000]]) };
    const onIt = findLandCrossings(
      [
        { name: 'Start', center: at(10, 100) },
        { name: 'Finish', center: at(-10, 1900) },
      ],
      [line],
    );
    expect(onIt).toEqual([]);

    const across = findLandCrossings(
      [
        { name: 'Start', center: at(0, 100) },
        { name: 'Finish', center: at(600, 100) },
      ],
      [line],
    );
    expect(across).toHaveLength(1);
    expect(across![0].metres).toBeGreaterThan(500);
  });

  it('judges nothing without water data', () => {
    expect(findLandCrossings([{ name: 'A', center: at(0, 0) }, { name: 'B', center: at(0, 500) }], [])).toBeNull();
    expect(
      findLandCrossings(
        [{ name: 'A', center: at(0, 0) }, { name: 'B', center: at(0, 500) }],
        [{ type: 'way', tags: { building: 'yes' }, geometry: geom([[0, 0], [1, 1]]) }],
      ),
    ).toBeNull();
  });
});

describe('landCrossingNote (#752 FR2)', () => {
  it('names the gates and the distance, to the nearest 10 m', () => {
    expect(
      landCrossingNote({ fromGate: 'Start', toGate: 'Finish', metres: 296.4, from: at(0, 0), to: at(1, 1) }),
    ).toBe('Crosses land between Start and Finish (300 m)');
  });
});
