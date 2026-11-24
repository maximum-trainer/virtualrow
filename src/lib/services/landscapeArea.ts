/**
 * #762 VP-34 — the area a route's landscape is fetched for, and the elevation
 * lattice laid over it.
 *
 * FR2: the area is the course line buffered by `LANDSCAPE_REACH_M`, not its
 * bounding box, so a long diagonal course does not fetch a huge square.
 *
 * FR3 / FR3a / FR3c: heights are asked for on a lattice in degrees whose
 * spacing comes from a fixed ladder (90 m, then x√2 each rung) and whose
 * points are whole multiples of that spacing. Two routes on the same water so
 * pick the same points, and an elevation cache shared between them hits.
 * The rung is the finest one that keeps the points inside the buffer under
 * `LANDSCAPE_GRID_MAX_POINTS`.
 *
 * Because the scene projection (`latLngToMeters`, equirectangular about the
 * route's first point) is linear in latitude and longitude, a lattice in
 * degrees is an exactly regular grid in scene XZ: that is the frame the grid
 * is published in, the same one `routeCurvePoints` uses.
 */
import type { Coordinate } from '../types/index';
import { latLngToMeters } from '../utils/geoUtils';
import { simplifyCoordinates } from '../utils/coordinateUtils';
import { CAMERA_FAR_M } from '../renderer/engine/cameraRange';

/** FR2 — how far from the course line the landscape reaches: the far plane. */
export const LANDSCAPE_REACH_M = CAMERA_FAR_M;
/** FR3a — the most elevation points one route asks for (20 calls of 100). */
export const LANDSCAPE_GRID_MAX_POINTS = 2000;
/** FR3 — the finest grid spacing. Copernicus GLO-90 is no finer. */
export const LANDSCAPE_GRID_MIN_SPACING_M = 90;
/** Course points simplified at this tolerance before any distance is measured. */
export const LANDSCAPE_ROUTE_TOLERANCE_M = 20;

const EARTH_RADIUS_M = 6378137;
const DEG = Math.PI / 180;
/** Metres per degree of latitude on the sphere `latLngToMeters` uses. */
const METRES_PER_DEGREE = EARTH_RADIUS_M * DEG;

/** The spacing on rung `k` of the ladder: 90 m x √2^k, to the centimetre. */
export const latticeSpacingForRung = (rung: number): number =>
  Math.round(LANDSCAPE_GRID_MIN_SPACING_M * Math.SQRT2 ** rung * 100) / 100;

/** The course in local metres (x east, y north) about its first point. */
export interface RouteFrame {
  origin: Coordinate;
  /** The course simplified at `LANDSCAPE_ROUTE_TOLERANCE_M`. */
  simplified: Coordinate[];
  /** Those vertices in local metres. */
  points: Array<{ x: number; y: number }>;
}

export const routeFrame = (coordinates: Coordinate[]): RouteFrame | null => {
  const usable = coordinates.filter((c) => Number.isFinite(c?.lat) && Number.isFinite(c?.lng));
  if (usable.length === 0) return null;
  const origin = usable[0];
  const simplified = simplifyCoordinates(usable, LANDSCAPE_ROUTE_TOLERANCE_M);
  return {
    origin,
    simplified,
    points: simplified.map((c) => latLngToMeters(c.lat, c.lng, origin.lat, origin.lng)),
  };
};

/** Shortest distance (m) from local point (x, y) to the course polyline. */
export const distanceToCourse = (frame: RouteFrame, x: number, y: number): number => {
  const pts = frame.points;
  if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
};

/**
 * A lattice in degrees: point (col, row) is at
 * `lat = (lat0Index + row) * dLat`, `lng = (lng0Index + col) * dLng`.
 * The indices are integers, so the points are the same for every route.
 */
export interface ElevationLattice {
  spacingM: number;
  dLat: number;
  dLng: number;
  lat0Index: number;
  lng0Index: number;
  cols: number;
  rows: number;
  /** Row-major (row = south to north): true where the point is inside the buffer. */
  inside: Uint8Array;
  /** Points inside the buffer. */
  count: number;
}

export const latticeLat = (lattice: ElevationLattice, row: number): number =>
  Number(((lattice.lat0Index + row) * lattice.dLat).toFixed(6));
export const latticeLng = (lattice: ElevationLattice, col: number): number =>
  Number(((lattice.lng0Index + col) * lattice.dLng).toFixed(6));

/**
 * The lattice at one spacing. Longitude steps use the cosine of the origin's
 * whole degree of latitude, so neighbouring routes share them too.
 */
export const latticeAt = (frame: RouteFrame, spacingM: number, reachM = LANDSCAPE_REACH_M): ElevationLattice => {
  const { origin } = frame;
  const dLat = spacingM / METRES_PER_DEGREE;
  const band = Math.cos(Math.round(origin.lat) * DEG);
  const dLng = spacingM / (METRES_PER_DEGREE * Math.max(band, 0.05));
  const cosOrigin = Math.cos(origin.lat * DEG);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of frame.points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const latOf = (y: number) => origin.lat + y / METRES_PER_DEGREE;
  const lngOf = (x: number) => origin.lng + x / (METRES_PER_DEGREE * cosOrigin);
  const lat0Index = Math.floor(latOf(minY - reachM) / dLat);
  const lat1Index = Math.ceil(latOf(maxY + reachM) / dLat);
  const lng0Index = Math.floor(lngOf(minX - reachM) / dLng);
  const lng1Index = Math.ceil(lngOf(maxX + reachM) / dLng);
  const rows = lat1Index - lat0Index + 1;
  const cols = lng1Index - lng0Index + 1;

  const lattice: ElevationLattice = {
    spacingM,
    dLat,
    dLng,
    lat0Index,
    lng0Index,
    cols,
    rows,
    inside: new Uint8Array(cols * rows),
    count: 0,
  };
  for (let row = 0; row < rows; row += 1) {
    const lat = (lat0Index + row) * dLat;
    for (let col = 0; col < cols; col += 1) {
      const lng = (lng0Index + col) * dLng;
      const m = latLngToMeters(lat, lng, origin.lat, origin.lng);
      if (distanceToCourse(frame, m.x, m.y) <= reachM) {
        lattice.inside[row * cols + col] = 1;
        lattice.count += 1;
      }
    }
  }
  return lattice;
};

/** FR3a — the finest rung whose buffer holds at most `maxPoints` points. */
export const planElevationLattice = (
  frame: RouteFrame,
  maxPoints = LANDSCAPE_GRID_MAX_POINTS,
  reachM = LANDSCAPE_REACH_M,
): ElevationLattice => {
  // Estimate the rung from the buffer's area, then step up until it fits.
  let length = 0;
  for (let i = 1; i < frame.points.length; i += 1) {
    length += Math.hypot(frame.points[i].x - frame.points[i - 1].x, frame.points[i].y - frame.points[i - 1].y);
  }
  const area = 2 * reachM * length + Math.PI * reachM * reachM;
  let rung = Math.max(0, Math.floor(Math.log(area / (maxPoints * LANDSCAPE_GRID_MIN_SPACING_M ** 2)) / Math.log(2)));
  for (;;) {
    const lattice = latticeAt(frame, latticeSpacingForRung(rung), reachM);
    if (lattice.count <= maxPoints) {
      if (rung === 0) return lattice;
      const finer = latticeAt(frame, latticeSpacingForRung(rung - 1), reachM);
      if (finer.count > maxPoints) return lattice;
      rung -= 1;
      continue;
    }
    rung += 1;
  }
};

/** Scene XZ of lattice point (col, row), against the route's origin. */
export const latticeSceneXZ = (
  lattice: ElevationLattice,
  origin: Coordinate,
): { originX: number; originZ: number; stepX: number; stepZ: number } => {
  // Unrounded: the 6-decimal request coordinates would put a step out by up
  // to 0.1 m, which grows across a grid.
  const lat0 = lattice.lat0Index * lattice.dLat;
  const lng0 = lattice.lng0Index * lattice.dLng;
  const corner = latLngToMeters(lat0, lng0, origin.lat, origin.lng);
  const next = latLngToMeters(lat0 + lattice.dLat, lng0 + lattice.dLng, origin.lat, origin.lng);
  return {
    originX: corner.x,
    originZ: -corner.y,
    stepX: next.x - corner.x,
    stepZ: -(next.y - corner.y),
  };
};
