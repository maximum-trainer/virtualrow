import { describe, expect, it, vi } from 'vitest';
import type { Coordinate } from '../lib/types/index';
import { bearingRadians, polylineLengthMeters } from '../lib/utils/coordinateUtils';
import { projectPointOntoPolyline } from '../lib/utils/polylineGeometry';
import {
  GATE_TOLERANCE_M,
  resolveCourseGeometry,
  type RownativeCourseGeometryInput,
  type WaterwayPathProvider,
} from '../lib/services/rownativeGeometry';

// #743: what a gates-only course resolves to once the corners are rounded and
// the waterway provider is given what it needs.

const ORIGIN = { lat: 52, lng: 0 };
const M_PER_DEG_LAT = 111_320;
const LNG_SCALE = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const at = (x: number, y: number): Coordinate => ({
  lat: ORIGIN.lat + y / M_PER_DEG_LAT,
  lng: ORIGIN.lng + x / LNG_SCALE,
});
/** A gate polygon `width` metres across, centred on (x, y). */
const gate = (name: string, order: number, x: number, y: number, width = 30) => ({
  name,
  order,
  points: [
    [-width / 2, -5],
    [width / 2, -5],
    [width / 2, 5],
    [-width / 2, 5],
  ].map(([dx, dy]) => {
    const c = at(x + dx, y + dy);
    return { lat: c.lat, lon: c.lng };
  }),
});
const course = (...polygons: ReturnType<typeof gate>[]): RownativeCourseGeometryInput => ({
  id: 't',
  name: 'Test course',
  polygons,
});

const sharpestTurnDegrees = (line: Coordinate[]): number => {
  let worst = 0;
  for (let i = 1; i < line.length - 1; i += 1) {
    let d = bearingRadians(line[i], line[i + 1]) - bearingRadians(line[i - 1], line[i]);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    worst = Math.max(worst, Math.abs((d * 180) / Math.PI));
  }
  return worst;
};

describe('gate-chain courses', () => {
  it('rounds the turn at each gate and still passes every gate', async () => {
    const input = course(
      gate('Start', 0, 0, 0),
      gate('WP1', 1, 0, 800),
      gate('WP2', 2, 700, 1200),
      gate('Finish', 3, 700, 2000),
    );

    const resolved = await resolveCourseGeometry(input);

    expect(resolved.source).toBe('gate-chain');
    expect(sharpestTurnDegrees(resolved.coordinates)).toBeLessThanOrEqual(16);
    for (const centre of resolved.gates) {
      expect(projectPointOntoPolyline(centre, resolved.coordinates).offsetMeters).toBeLessThanOrEqual(GATE_TOLERANCE_M);
    }
    // Start and finish are the gate centres themselves.
    expect(resolved.coordinates[0]).toEqual(resolved.gates[0]);
    expect(resolved.coordinates[resolved.coordinates.length - 1]).toEqual(resolved.gates[3]);
  });

  it('keeps a two-gate course as the straight line it is', async () => {
    const resolved = await resolveCourseGeometry(course(gate('Start', 0, 0, 0), gate('Finish', 1, 0, 2000)));
    expect(resolved.coordinates).toHaveLength(2);
  });

  it('rows a stake race out, round the stake and back', async () => {
    const input = course(gate('Start', 0, 0, 0), gate('Stake', 1, 0, 1500), gate('Finish', 2, 30, 0));

    const resolved = await resolveCourseGeometry(input);

    expect(resolved.source).toBe('gate-chain');
    expect(sharpestTurnDegrees(resolved.coordinates)).toBeLessThanOrEqual(16);
    // Out and back is 3 km plus the turn; not a fillet that cuts the stake off.
    expect(polylineLengthMeters(resolved.coordinates)).toBeGreaterThan(3000);
    expect(projectPointOntoPolyline(resolved.gates[1], resolved.coordinates).offsetMeters).toBeLessThanOrEqual(20.5);
  });

  // #753 FR1: the stake is where a turn buoy goes.
  it('names the middle gate of a three-gate out-and-back course as its one stake', async () => {
    const input = course(gate('Start', 0, 0, 0), gate('Stake', 1, 0, 1500), gate('Finish', 2, 30, 0));
    const resolved = await resolveCourseGeometry(input);
    expect(resolved.stakeTurns).toEqual([resolved.gates[1]]);
  });

  it('names no stake on a course that only bends', async () => {
    const input = course(gate('Start', 0, 0, 0), gate('WP1', 1, 0, 800), gate('WP2', 2, 700, 1200), gate('Finish', 3, 700, 2000));
    expect((await resolveCourseGeometry(input)).stakeTurns).toEqual([]);
  });
});

describe('the waterway provider seam', () => {
  it('tells the provider how wide each gate is', async () => {
    const findPath = vi.fn<WaterwayPathProvider['findPath']>(async () => null);
    const input = course(gate('Start', 0, 0, 0, 24), gate('Finish', 1, 0, 2000, 180));

    await resolveCourseGeometry(input, { osmProvider: { findPath } });

    expect(findPath).toHaveBeenCalledTimes(1);
    const extents = findPath.mock.calls[0][1]?.gateExtentsMeters;
    expect(extents).toHaveLength(2);
    expect(extents![0]).toBeGreaterThan(20);
    expect(extents![0]).toBeLessThan(30);
    expect(extents![1]).toBeGreaterThan(175);
    expect(extents![1]).toBeLessThan(185);
  });

  it('uses a derived path and labels it', async () => {
    // A river that swings 300 m east between the gates.
    const river = Array.from({ length: 41 }, (_, i) => at(300 * Math.sin((i / 40) * Math.PI), i * 50));
    const findPath = vi.fn<WaterwayPathProvider['findPath']>(async () => river);

    const resolved = await resolveCourseGeometry(
      course(gate('Start', 0, 0, 0), gate('Finish', 1, 0, 2000)),
      { osmProvider: { findPath } },
    );

    expect(resolved.source).toBe('osm-derived');
    expect(polylineLengthMeters(resolved.coordinates)).toBeGreaterThan(2100);
    expect(projectPointOntoPolyline(at(300, 1000), resolved.coordinates).offsetMeters).toBeLessThan(5);
  });

  it('falls back to the rounded gate chain when the provider finds nothing', async () => {
    const resolved = await resolveCourseGeometry(
      course(gate('Start', 0, 0, 0), gate('WP1', 1, 0, 800), gate('Finish', 2, 800, 800)),
      { osmProvider: { findPath: async () => null } },
    );
    expect(resolved.source).toBe('gate-chain');
    expect(sharpestTurnDegrees(resolved.coordinates)).toBeLessThanOrEqual(16);
  });
});
