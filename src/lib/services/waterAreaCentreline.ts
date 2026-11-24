/**
 * #751 VP-28 FR1/FR2 — a centreline for water mapped only as an area.
 *
 * Wide rivers, estuaries and docks are often in OpenStreetMap as
 * `natural=water` / `waterway=riverbank` polygons with no `waterway=*` way
 * through them, so the waterway walk has nothing to follow. Here the line
 * between two gates is found from the banks themselves: at a station every
 * {@link CENTRELINE_STATION_M} along the gate-to-gate direction, a cross-section
 * is cut perpendicular to it, and the midpoint of the stretch of water nearest
 * the straight line is a centreline point.
 *
 * FR2: the line is only used if every point is inside the water and at least
 * {@link MIN_BANK_CLEARANCE_SHARE} of the local half-width from the nearest
 * bank, and every step between points stays on the water. Otherwise `null`,
 * and the course falls through as before.
 */
import type { Coordinate } from '../types/index';

export const CENTRELINE_STATION_M = 25;
/** A centreline point keeps at least this share of the half-width to any bank. */
export const MIN_BANK_CLEARANCE_SHARE = 0.5;

const METERS_PER_DEGREE_LAT = 111_320;

/** A water polygon's outer ring (first point not repeated at the end). */
export type WaterRing = Coordinate[];

interface OverpassGeometryPoint {
  lat: number;
  lon: number;
}

interface OverpassAreaElement {
  type?: string;
  geometry?: OverpassGeometryPoint[];
  members?: { role?: string; geometry?: OverpassGeometryPoint[] }[];
}

const toCoordinates = (points: OverpassGeometryPoint[] | undefined): Coordinate[] =>
  (points ?? [])
    .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
    .map((p) => ({ lat: p.lat, lng: p.lon }));

const same = (a: Coordinate, b: Coordinate): boolean =>
  Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;

const closeRing = (points: Coordinate[]): WaterRing | null => {
  if (points.length < 4 || !same(points[0], points[points.length - 1])) return null;
  return points.slice(0, -1);
};

/** Join a relation's outer member ways end to end into closed rings. */
const joinMembers = (pieces: Coordinate[][]): WaterRing[] => {
  const open = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  const rings: WaterRing[] = [];
  while (open.length > 0) {
    let line = open.shift()!;
    let grew = true;
    while (!same(line[0], line[line.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const piece = open[i];
        const end = line[line.length - 1];
        if (same(piece[0], end)) line = line.concat(piece.slice(1));
        else if (same(piece[piece.length - 1], end)) line = line.concat([...piece].reverse().slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    const ring = closeRing(line);
    if (ring) rings.push(ring);
  }
  return rings;
};

/**
 * The outer rings of the water areas in an Overpass `out geom` answer: closed
 * ways, and multipolygon relations whose outer members join up. Inner rings
 * (islands) are left out; the bank-clearance check keeps a line off them only
 * where they are part of an outer ring's shape.
 */
export const parseWaterAreas = (elements: readonly unknown[]): WaterRing[] => {
  const rings: WaterRing[] = [];
  for (const raw of elements) {
    const element = raw as OverpassAreaElement;
    if (element?.type === 'way') {
      const ring = closeRing(toCoordinates(element.geometry));
      if (ring) rings.push(ring);
    } else if (element?.type === 'relation') {
      const outers = (element.members ?? [])
        .filter((m) => (m.role ?? 'outer') === 'outer')
        .map((m) => toCoordinates(m.geometry));
      rings.push(...joinMembers(outers));
    }
  }
  return rings;
};

export interface Vec {
  x: number;
  y: number;
}

/** A flat frame in metres about `origin` (x east, y north). */
export const localFrame = (origin: Coordinate) => {
  const lngScale = METERS_PER_DEGREE_LAT * Math.max(0.01, Math.cos((origin.lat * Math.PI) / 180));
  return {
    toLocal: (c: Coordinate): Vec => ({
      x: (c.lng - origin.lng) * lngScale,
      y: (c.lat - origin.lat) * METERS_PER_DEGREE_LAT,
    }),
    toCoordinate: (v: Vec): Coordinate => ({
      lat: origin.lat + v.y / METERS_PER_DEGREE_LAT,
      lng: origin.lng + v.x / lngScale,
    }),
  };
};

/** Even-odd test of `p` against a ring in the same local frame. */
export const insideRing = (p: Vec, ring: readonly Vec[]): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

const distanceToRing = (p: Vec, ring: readonly Vec[]): number => {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const span = dx * dx + dy * dy;
    const t = span > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / span)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
  }
  return best;
};

/** Where the line `p + n·t` crosses the ring, as sorted values of t. */
const crossings = (p: Vec, n: Vec, ring: readonly Vec[]): number[] => {
  const out: number[] = [];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = n.x * ey - n.y * ex;
    if (Math.abs(denom) < 1e-12) continue;
    // Solve p + n·t = a + e·s.
    const t = ((a.x - p.x) * ey - (a.y - p.y) * ex) / denom;
    const s = ((a.x - p.x) * n.y - (a.y - p.y) * n.x) / denom;
    if (s >= 0 && s < 1) out.push(t);
  }
  return out.sort((x, y) => x - y);
};

export interface AreaCentreline {
  coordinates: Coordinate[];
  /** The water's half-width at each interior station, metres. */
  halfWidths: number[];
}

/**
 * The centreline between two gates inside the same water area, or null when
 * they are not both in one ring or the line would leave the water or hug a
 * bank (FR2).
 */
export const deriveAreaCentreline = (
  from: Coordinate,
  to: Coordinate,
  rings: readonly WaterRing[],
): AreaCentreline | null => {
  const { toLocal, toCoordinate } = localFrame(from);
  const a = toLocal(from);
  const b = toLocal(to);
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length <= 0) return null;
  const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const n = { x: -u.y, y: u.x };

  for (const ring of rings) {
    const local = ring.map(toLocal);
    if (!insideRing(a, local) || !insideRing(b, local)) continue;

    const points: Vec[] = [a];
    const halfWidths: number[] = [];
    let ok = true;
    for (let s = CENTRELINE_STATION_M; s < length - CENTRELINE_STATION_M / 2; s += CENTRELINE_STATION_M) {
      const p = { x: a.x + u.x * s, y: a.y + u.y * s };
      const ts = crossings(p, n, local);
      // Water lies between the 1st and 2nd crossing, the 3rd and 4th, ...
      let best: [number, number] | null = null;
      for (let k = 0; k + 1 < ts.length; k += 2) {
        const mid = (ts[k] + ts[k + 1]) / 2;
        if (!best || Math.abs(mid) < Math.abs((best[0] + best[1]) / 2)) best = [ts[k], ts[k + 1]];
      }
      if (!best) {
        ok = false;
        break;
      }
      const half = (best[1] - best[0]) / 2;
      const t = (best[0] + best[1]) / 2;
      const mid = { x: p.x + n.x * t, y: p.y + n.y * t };
      if (!insideRing(mid, local) || distanceToRing(mid, local) < half * MIN_BANK_CLEARANCE_SHARE) {
        ok = false;
        break;
      }
      points.push(mid);
      halfWidths.push(half);
    }
    if (!ok) continue;
    points.push(b);

    // Every step between points stays on the water.
    for (let i = 0; i + 1 < points.length && ok; i++) {
      for (const f of [0.25, 0.5, 0.75]) {
        const q = { x: points[i].x + (points[i + 1].x - points[i].x) * f, y: points[i].y + (points[i + 1].y - points[i].y) * f };
        if (!insideRing(q, local)) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;
    return { coordinates: points.map(toCoordinate), halfWidths };
  }
  return null;
};

/** Sample spacing for {@link straightOnWater}. */
const ON_WATER_SAMPLE_M = 10;

/**
 * #751: is the straight line from `a` to `b` on the water of one area all the
 * way? A gate set out in wide water, further from the mapped centreline than
 * the snap limit allows, can still be reached by a run-in that never crosses
 * land.
 */
export const straightOnWater = (a: Coordinate, b: Coordinate, rings: readonly WaterRing[]): boolean => {
  const { toLocal } = localFrame(a);
  const p = toLocal(a);
  const q = toLocal(b);
  const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / ON_WATER_SAMPLE_M));
  return rings.some((ring) => {
    const local = ring.map(toLocal);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      if (!insideRing({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }, local)) return false;
    }
    return true;
  });
};
