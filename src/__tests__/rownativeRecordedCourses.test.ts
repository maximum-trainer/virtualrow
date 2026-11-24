import { describe, expect, it, vi } from 'vitest';
import type { Coordinate } from '../lib/types/index';
import { resolveCourseGeometry, type RownativeCourseGeometryInput } from '../lib/services/rownativeGeometry';
import { OsmWaterwayPathProvider } from '../lib/services/osmWaterwayPathProvider';
import { distanceBetweenMeters, polylineLengthMeters } from '../lib/utils/coordinateUtils';
import { cumulativeLengths, interpolateAlong, projectPointOntoPolyline } from '../lib/utils/polylineGeometry';
import { stakeTurns } from '../lib/utils/courseCorners';
import { parseWaterAreas, localFrame, straightOnWater } from '../lib/services/waterAreaCentreline';
import course171 from './fixtures/overpass/course-171.json';
import course233 from './fixtures/overpass/course-233.json';
import course104 from './fixtures/overpass/course-104.json';
import overpass171 from './fixtures/overpass/overpass-171.json';
import overpass233 from './fixtures/overpass/overpass-233.json';
import course261 from './fixtures/overpass/course-261.json';
import overpass261 from './fixtures/overpass/overpass-261.json';

// #751 FR6 / #753: rownative courses resolved against Overpass answers
// recorded from the live server (2026-11-24) and trimmed to the corridor:
// the waterways and water areas the provider asks for in its one query.

const resolve = async (course: unknown, answer: unknown) => {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => answer }));
  const osmProvider = new OsmWaterwayPathProvider(fetchMock as unknown as typeof fetch);
  return resolveCourseGeometry(course as RownativeCourseGeometryInput, { osmProvider });
};

/** Points every `step` metres along a line. */
const sample = (line: Coordinate[], step = 10): { point: Coordinate; along: number }[] => {
  const total = cumulativeLengths(line).at(-1) ?? 0;
  const out: { point: Coordinate; along: number }[] = [];
  for (let d = 0; d <= total; d += step) out.push({ point: interpolateAlong(line, d), along: d });
  return out;
};

describe('Head of the Cam (rownative 171)', () => {
  it('follows the Cam: map-derived, 2.6 to 2.8 km (#753 FR3)', async () => {
    const result = await resolve(course171, overpass171);
    expect(result.source).toBe('osm-derived');
    const km = polylineLengthMeters(result.coordinates) / 1000;
    expect(km).toBeGreaterThan(2.6);
    expect(km).toBeLessThan(2.8);
  });

  it('bends with the river: heading changes by more than 60 degrees (#753 acceptance)', async () => {
    const result = await resolve(course171, overpass171);
    const { toLocal } = localFrame(result.coordinates[0]);
    const headings = sample(result.coordinates, 5).map((s) => toLocal(s.point));
    let min = Infinity;
    let max = -Infinity;
    let unwrapped = 0;
    let previous: number | null = null;
    for (let i = 1; i < headings.length; i++) {
      const h = Math.atan2(headings[i].y - headings[i - 1].y, headings[i].x - headings[i - 1].x);
      if (previous !== null) {
        let d = h - previous;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        // FR4: never more than 20 degrees between points 5 m apart.
        expect(Math.abs((d * 180) / Math.PI)).toBeLessThanOrEqual(20);
        unwrapped += d;
      }
      previous = h;
      min = Math.min(min, unwrapped);
      max = Math.max(max, unwrapped);
    }
    expect(((max - min) * 180) / Math.PI).toBeGreaterThan(60);
  });

  it('keeps every vertex on the Cam', async () => {
    const result = await resolve(course171, overpass171);
    const river = (overpass171.elements[0].geometry as { lat: number; lon: number }[]).map((p) => ({ lat: p.lat, lng: p.lon }));
    for (const p of result.coordinates) expect(projectPointOntoPolyline(p, river).offsetMeters).toBeLessThan(60);
  });
});

describe.each([
  ['HOTS Stake race (rownative 233)', course233],
  ['Seekonk North Stake Race (rownative 104)', course104],
])('%s on the Seekonk (#751 FR6)', (_name, course) => {
  it('resolves map-derived', async () => {
    const result = await resolve(course, overpass233);
    expect(result.source).toBe('osm-derived');
  });

  it('keeps the outbound and return legs at least 8 m apart except at the stake', async () => {
    const result = await resolve(course, overpass233);
    const [stake] = stakeTurns(result.gates);
    expect(stake).toBeDefined();
    // Split the line where it passes closest to the stake.
    const at = projectPointOntoPolyline(stake.centre, result.coordinates).alongMeters;
    const samples = sample(result.coordinates);
    const outbound = samples.filter((s) => s.along <= at).map((s) => s.point);
    const back = samples.filter((s) => s.along > at).map((s) => s.point);
    // Where both legs share the water: the return within 150 m of the outbound.
    const shared = back.filter(
      (p) => distanceBetweenMeters(p, stake.centre) > 80 && projectPointOntoPolyline(p, outbound).offsetMeters < 150,
    );
    expect(shared.length).toBeGreaterThan(20);
    const tooClose = shared.filter((p) => projectPointOntoPolyline(p, outbound).offsetMeters < 8);
    expect(tooClose.length / shared.length).toBeLessThan(0.05);
  });

  it('stays on the Seekonk', async () => {
    const result = await resolve(course, overpass233);
    const rings = parseWaterAreas(overpass233.elements as unknown[]);
    const { toLocal } = localFrame(result.coordinates[0]);
    const seekonk = rings.reduce((a, b) => (a.length > b.length ? a : b)).map(toLocal);
    const inside = (p: { x: number; y: number }) => {
      let r = false;
      for (let i = 0, j = seekonk.length - 1; i < seekonk.length; j = i++) {
        const a = seekonk[i];
        const b = seekonk[j];
        if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r;
      }
      return r;
    };
    const off = result.coordinates.filter((c) => !inside(toLocal(c)));
    expect(off.length / result.coordinates.length).toBeLessThan(0.02);
  });
});

describe('Isle of Ely Head (rownative 261): a river mapped only as water area', () => {
  it('finds a path whose every vertex is inside the water (#751 FR6)', async () => {
    const result = await resolve(course261, overpass261);
    expect(result.source).toBe('osm-derived');
    const rings = parseWaterAreas(overpass261.elements as unknown[]);
    // The river is drawn as several touching polygons, so test each vertex
    // against all of them.
    const off = result.coordinates.filter((c) => !straightOnWater(c, c, rings));
    expect(off).toEqual([]);
    const km = polylineLengthMeters(result.coordinates) / 1000;
    expect(km).toBeGreaterThan(4.8);
    expect(km).toBeLessThan(5.6);
  });
});
