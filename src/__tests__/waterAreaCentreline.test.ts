import { describe, expect, it } from 'vitest';
import {
  CENTRELINE_STATION_M,
  deriveAreaCentreline,
  localFrame,
  parseWaterAreas,
  type WaterRing,
} from '../lib/services/waterAreaCentreline';
import type { Coordinate } from '../lib/types/index';

const origin: Coordinate = { lat: 52.2, lng: 0.12 };
const { toCoordinate, toLocal } = localFrame(origin);
const at = (x: number, y: number): Coordinate => toCoordinate({ x, y });
const ring = (pts: [number, number][]): WaterRing => pts.map(([x, y]) => at(x, y));

/** A straight reach 1000 m long, 80 m wide (y from -40 to 40). */
const reach = ring([
  [-50, -40],
  [1050, -40],
  [1050, 40],
  [-50, 40],
]);

/** An L-shaped river: east along y∈[-40,40] to x=600, then north along x∈[520,600]. */
const bend = ring([
  [-50, -40],
  [600, -40],
  [600, 800],
  [520, 800],
  [520, 40],
  [-50, 40],
]);

describe('deriveAreaCentreline', () => {
  it('follows the middle of a straight reach even when the gates sit off-centre', () => {
    const line = deriveAreaCentreline(at(0, 10), at(1000, 10), [reach]);
    expect(line).not.toBeNull();
    const pts = line!.coordinates.map(toLocal);
    // Interior points are on the middle line, y = 0.
    for (const p of pts.slice(1, -1)) expect(Math.abs(p.y)).toBeLessThan(0.5);
    expect(pts.length).toBeGreaterThan(1000 / CENTRELINE_STATION_M - 2);
    for (const h of line!.halfWidths) expect(h).toBeCloseTo(40, 0);
  });

  it('returns null when a gate is outside the water', () => {
    expect(deriveAreaCentreline(at(0, 0), at(1000, 100), [reach])).toBeNull();
  });

  it('follows a right-angle bend round the corner instead of across the land', () => {
    const line = deriveAreaCentreline(at(0, 0), at(560, 780), [bend]);
    expect(line).not.toBeNull();
    const pts = line!.coordinates.map(toLocal);
    // Down the east arm on y = 0, then up the north arm on x = 560.
    expect(pts.some((p) => p.x > 400 && p.x < 500 && Math.abs(p.y) < 1)).toBe(true);
    expect(pts.some((p) => p.y > 300 && Math.abs(p.x - 560) < 1)).toBe(true);
  });

  it('returns null when the cross-sections jump between two arms of a hairpin (FR2)', () => {
    // Two arms running north, joined at y = 600; gates at the foot of each arm.
    const hairpin = ring([
      [-40, 0],
      [40, 0],
      [40, 520],
      [160, 520],
      [160, 0],
      [240, 0],
      [240, 600],
      [-40, 600],
    ]);
    expect(deriveAreaCentreline(at(0, 20), at(200, 20), [hairpin])).toBeNull();
  });

  it('picks the ring that holds both gates', () => {
    const other = ring([
      [5000, 5000],
      [5100, 5000],
      [5100, 5100],
    ]);
    expect(deriveAreaCentreline(at(0, 0), at(1000, 0), [other, reach])).not.toBeNull();
  });

  it('returns null for coincident gates', () => {
    expect(deriveAreaCentreline(at(0, 0), at(0, 0), [reach])).toBeNull();
  });
});

describe('parseWaterAreas', () => {
  const geom = (r: WaterRing) => [...r, r[0]].map((c) => ({ lat: c.lat, lon: c.lng }));

  it('reads closed ways as rings and drops open ones', () => {
    const rings = parseWaterAreas([
      { type: 'way', geometry: geom(reach) },
      { type: 'way', geometry: geom(reach).slice(0, -1) },
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });

  it('joins a relation’s outer members end to end and leaves inner rings out', () => {
    const closed = geom(reach);
    const first = closed.slice(0, 3);
    const second = closed.slice(2).reverse(); // reversed piece still joins
    const rings = parseWaterAreas([
      {
        type: 'relation',
        members: [
          { role: 'outer', geometry: first },
          { role: 'inner', geometry: geom(ring([[0, 0], [10, 0], [10, 10]])) },
          { role: 'outer', geometry: second },
        ],
      },
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
  });

  it('ignores malformed elements', () => {
    expect(parseWaterAreas([null, { type: 'node' }, { type: 'way' }])).toEqual([]);
  });
});
