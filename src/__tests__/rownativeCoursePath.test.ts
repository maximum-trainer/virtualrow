import { describe, expect, it } from 'vitest';
import course277 from './fixtures/rownative/277-path.json';
import type { Coordinate } from '../lib/types/index';
import { bearingRadians, polylineLengthMeters } from '../lib/utils/coordinateUtils';
import {
  GATE_TOLERANCE_M,
  RownativeGeometryUnavailableError,
  UPSTREAM_PATH_TOLERANCE_M,
  resolveCourseGeometry,
  type RownativeCourseGeometryInput,
  type RownativeCoursePolygonPoint,
} from '../lib/services/rownativeGeometry';
import { RownativeService } from '../lib/services/rownativeService';
import { RouteService } from '../lib/services/routeService';
import {
  geometryProvenanceBadge,
  geometryWarningNote,
  normalizeGeometrySource,
} from '../lib/utils/geometryProvenance';

// #747: the course file's own traced `path` (rownative/courses#23) is held to
// upstream's rule — within 250 m of each gate, or the gate's own extent — not
// the 40 m rule that guards a rower-attached track.
// Fixture: rownative/courses courses/277.json as published, with `path`.

const M_PER_DEG_LAT = 111_320;
const TRACED_LENGTH_M = 9_173;

const base = course277 as unknown as RownativeCourseGeometryInput & { path: RownativeCoursePolygonPoint[] };

/** The path moved `metres` to the left of its start→finish direction. */
function shiftedPath(metres: number): RownativeCoursePolygonPoint[] {
  const first = base.path[0];
  const last = base.path[base.path.length - 1];
  const heading = bearingRadians({ lat: first.lat, lng: first.lon }, { lat: last.lat, lng: last.lon });
  const left = heading - Math.PI / 2;
  const dNorth = Math.cos(left) * metres;
  const dEast = Math.sin(left) * metres;
  return base.path.map((point) => ({
    lat: point.lat + dNorth / M_PER_DEG_LAT,
    lon: point.lon + dEast / (M_PER_DEG_LAT * Math.cos((point.lat * Math.PI) / 180)),
  }));
}

const withPath = (path: RownativeCoursePolygonPoint[]): RownativeCourseGeometryInput => ({ ...base, path });
const asCoordinates = (points: RownativeCoursePolygonPoint[]): Coordinate[] =>
  points.map((point) => ({ lat: point.lat, lng: point.lon }));

describe('upstream course path (#747)', () => {
  it('uses upstream tolerance of 250 m', () => {
    expect(UPSTREAM_PATH_TOLERANCE_M).toBe(250);
    expect(GATE_TOLERANCE_M).toBe(40);
  });

  it.each([0, 30, 120, 240])('rows a path shifted %i m sideways as source "path"', async (offset) => {
    const resolved = await resolveCourseGeometry(withPath(shiftedPath(offset)));

    expect(resolved.source).toBe('path');
    expect(Math.abs(polylineLengthMeters(resolved.coordinates) - TRACED_LENGTH_M) / TRACED_LENGTH_M)
      .toBeLessThan(0.02);
    expect(resolved.warnings).toEqual([]);
  });

  it('rows the whole path in both sideways directions, without trimming it at the gates', async () => {
    for (const offset of [-240, 240]) {
      const resolved = await resolveCourseGeometry(withPath(shiftedPath(offset)));
      expect(resolved.coordinates).toHaveLength(base.path.length);
    }
  });

  it('orients a path drawn finish to start', async () => {
    const resolved = await resolveCourseGeometry(withPath([...base.path].reverse()));

    expect(resolved.source).toBe('path');
    expect(resolved.coordinates[0]).toEqual({ lat: base.path[0].lat, lng: base.path[0].lon });
  });

  it('refuses a path 400 m off, says "Course path ignored" and names the Finish gate', async () => {
    const resolved = await resolveCourseGeometry(withPath(shiftedPath(400)));

    expect(resolved.source).toBe('gate-chain');
    const warning = resolved.warnings.find((w) => w.startsWith('Course path ignored'));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/"(Finish|Start)" gate/);
    expect(warning).toContain('250 m allowed');
    expect(resolved.warnings.some((w) => w.startsWith('Attached track'))).toBe(false);
  });

  it('keeps the rower-attached track strict, and falls back to the course path', async () => {
    const attached = asCoordinates(shiftedPath(60));

    const resolved = await resolveCourseGeometry(base, { attachedTrack: attached });

    expect(resolved.source).toBe('path');
    const warning = resolved.warnings.find((w) => w.startsWith('Attached track ignored'));
    expect(warning).toBeDefined();
    expect(warning).toContain(`${GATE_TOLERANCE_M} m allowed`);
  });

  it('still lets an attached track that fits outrank the course path', async () => {
    const resolved = await resolveCourseGeometry(base, { attachedTrack: asCoordinates(base.path) });
    expect(resolved.source).toBe('track');
  });

  it('tells the rower a degenerate course imports once upstream adds a path', () => {
    const error = new RownativeGeometryUnavailableError('150', 'Loop');
    expect(error.message).toContain('once rownative adds a traced path');
  });
});

describe('path provenance (#747 FR2)', () => {
  it('shows no badge for the course path, like a track', () => {
    expect(geometryProvenanceBadge('path')).toBeNull();
  });

  it('reads a legacy rownative "track" with no attached track as "path"', () => {
    const legacy = { source: 'rownative' as const, geometrySource: 'track' as const, externalId: '277' };
    expect(normalizeGeometrySource(legacy, () => false)).toBe('path');
    expect(normalizeGeometrySource(legacy, (id) => id === '277')).toBe('track');
    expect(normalizeGeometrySource({ ...legacy, source: 'manual' as const }, () => false)).toBe('track');
    expect(normalizeGeometrySource({ ...legacy, geometrySource: 'gate-chain' as const }, () => false))
      .toBe('gate-chain');
  });
});

describe('route card warning (#747 FR3)', () => {
  const fetchFor = (courseFile: unknown) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('overpass')) return { ok: false, json: async () => ({}) } as Response;
      const text = JSON.stringify(courseFile);
      return { ok: true, status: 200, json: async () => courseFile, text: async () => text } as unknown as Response;
    }) as unknown as typeof fetch;

  it('stores the refusal on the imported route and shows it as the card note', async () => {
    const routes = new RouteService();
    const service = new RownativeService(
      fetchFor(withPath(shiftedPath(400))),
      (data) => routes.importRouteFromRownative(data),
    );

    const imported = await service.importCourseById('277');

    expect(imported.geometrySource).toBe('gate-chain');
    expect(imported.geometryWarnings?.[0]).toMatch(/^Course path ignored: .*gate/);
    expect(geometryWarningNote(imported)).toBe(imported.geometryWarnings?.[0]);
  });

  it('stores no warning when the course path is used', async () => {
    const routes = new RouteService();
    const service = new RownativeService(fetchFor(base), (data) => routes.importRouteFromRownative(data));

    const imported = await service.importCourseById('277');

    expect(imported.geometrySource).toBe('path');
    expect(imported.geometryWarnings).toBeUndefined();
    expect(geometryWarningNote(imported)).toBeNull();
  });
});
