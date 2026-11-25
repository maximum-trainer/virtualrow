/**
 * #885 FR1: a landscape dense enough to exceed every real-map layer budget, so
 * the budget checks prove a cap rather than an empty map. Woods, hedges, a
 * coastline, hills, a town, buildings and landmarks, laid out along whatever
 * course it is given. Pure and deterministic: no network, no randomness.
 */
import type { Coordinate } from '../types';
import { routeFrame, distanceToCourse } from './landscapeArea';
import type {
  BuiltFootprint,
  BuiltForm,
  ElevationGrid,
  Landmark,
  LandscapeLayer,
  LandCoverFeature,
  Landscape,
  Place,
  ScenePoint,
} from './landscapeService';

/** Spacing of everything laid along the course, metres. */
const STEP_M = 25;
/** How far the elevation grid reaches beyond the course (matches `LANDSCAPE_REACH_M`). */
const REACH_M = 2000;
const GRID_SPACING_M = 90;
/** Keep the grid bounded on a long course; spacing grows instead. */
const MAX_GRID_POINTS = 60_000;
/** Water level: the terrain stays flat this close to the course (#762 AC). */
const FLAT_NEAR_COURSE_M = 120;

const LANDMARK_KINDS: Landmark['kind'][] = ['tower', 'chimney', 'church', 'mast', 'lighthouse', 'wind_turbine'];

interface Station {
  x: number;
  z: number;
  /** Unit normal pointing to the course's left, scene XZ. */
  nx: number;
  nz: number;
}

/** Points every `STEP_M` along the course in scene XZ, with their left normals. */
const stationsAlong = (points: ScenePoint[]): Station[] => {
  const stations: Station[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const len = Math.hypot(bx - ax, bz - az);
    if (len === 0) continue;
    const tx = (bx - ax) / len;
    const tz = (bz - az) / len;
    for (let d = 0; d < len; d += STEP_M) {
      stations.push({ x: ax + tx * d, z: az + tz * d, nx: -tz, nz: tx });
    }
  }
  return stations;
};

const offset = (s: Station, side: 1 | -1, metres: number): ScenePoint => [
  s.x + s.nx * side * metres,
  s.z + s.nz * side * metres,
];

/** A rectangle `along` x `across` metres, its near edge `from` metres off the course. */
const block = (s: Station, side: 1 | -1, from: number, across: number, along: number): ScenePoint[] => {
  const tx = s.nz;
  const tz = -s.nx;
  const [nearX, nearZ] = offset(s, side, from);
  const [farX, farZ] = offset(s, side, from + across);
  const half = along / 2;
  const ring: ScenePoint[] = [
    [nearX - tx * half, nearZ - tz * half],
    [nearX + tx * half, nearZ + tz * half],
    [farX + tx * half, farZ + tz * half],
    [farX - tx * half, farZ - tz * half],
  ];
  return [...ring, ring[0]];
};

const layer = <T>(data: T, count: number): LandscapeLayer<T> => ({ source: 'cache', ms: 0, count, data });

const landCoverAlong = (stations: Station[]): LandCoverFeature[] => {
  const features: LandCoverFeature[] = [];
  stations.forEach((s, i) => {
    for (const side of [1, -1] as const) {
      if (i % 2 === 0) {
        features.push({
          kind: i % 4 === 0 ? 'wood' : 'forest',
          shape: 'polygon',
          points: block(s, side, 70, 400, 45),
          leafType: (['broadleaved', 'needleleaved', 'mixed'] as const)[(i / 2) % 3],
        });
      } else {
        features.push({ kind: i % 4 === 1 ? 'hedge' : 'tree_row', shape: 'line', points: [offset(s, side, 40), offset(s, side, 60)] });
      }
      // Built-up land past the near band, where skylines stand (#765 FR3).
      features.push({
        kind: i % 3 === 0 ? 'farmland' : 'residential',
        shape: 'polygon',
        points: block(s, side, 650 + (i % 4) * 250, 200, 25),
      });
    }
  });
  const first = stations[0];
  const last = stations[stations.length - 1];
  if (first && last) {
    // Far out on the right only, so the course still has land on both banks near it.
    features.push({ kind: 'coastline', shape: 'line', points: [offset(last, -1, 1800), offset(first, -1, 1800)] });
  }
  return features;
};

const builtAlong = (stations: Station[]): BuiltForm => {
  const footprints: BuiltFootprint[] = [];
  const landmarks: Landmark[] = [];
  stations.forEach((s, i) => {
    for (const side of [1, -1] as const) {
      // Rows of houses from 30 m to 590 m off the bank: far more than any tier keeps per km.
      for (let from = 30; from < 600; from += 20) {
        footprints.push({ kind: (from / 20) % 3 === 0 ? 'house' : 'residential', heightM: 6 + (from % 7), points: block(s, side, from, 10, 12) });
      }
      if (i % 3 === 0) {
        const [x, z] = offset(s, side, 700 + (i % 5) * 200);
        landmarks.push({ kind: LANDMARK_KINDS[i % LANDMARK_KINDS.length], heightM: 35 + (i % 4) * 10, x, z });
      }
    }
  });
  const places: Place[] = stations
    .filter((_, i) => i % 40 === 0)
    .map((s, i) => {
      const [x, z] = offset(s, i % 2 === 0 ? 1 : -1, 900);
      return { kind: i % 3 === 0 ? 'town' : 'village', name: `Fixture ${i}`, population: 5000 + i * 1000, x, z };
    });
  return { footprints, places, landmarks };
};

const hillsAround = (frame: NonNullable<ReturnType<typeof routeFrame>>, points: ScenePoint[]): ElevationGrid => {
  const xs = points.map(([x]) => x);
  const zs = points.map(([, z]) => z);
  const minX = Math.min(...xs) - REACH_M;
  const maxX = Math.max(...xs) + REACH_M;
  const minZ = Math.min(...zs) - REACH_M;
  const maxZ = Math.max(...zs) + REACH_M;
  let spacing = GRID_SPACING_M;
  while (((maxX - minX) / spacing + 1) * ((maxZ - minZ) / spacing + 1) > MAX_GRID_POINTS) spacing *= Math.SQRT2;
  const cols = Math.floor((maxX - minX) / spacing) + 1;
  const rows = Math.floor((maxZ - minZ) / spacing) + 1;
  const heights = new Float32Array(cols * rows);
  // Rows run south to north, so the grid starts at the southern (largest z) edge.
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = minX + col * spacing;
      const z = maxZ - row * spacing;
      const fromCourse = distanceToCourse(frame, x, -z);
      const rise = Math.min(1, Math.max(0, (fromCourse - FLAT_NEAR_COURSE_M) / 600));
      const ridge = Math.sin(x / 450) ** 2 * Math.cos(z / 520) ** 2;
      heights[row * cols + col] = Math.round(rise * (40 + 180 * ridge) * 10) / 10;
    }
  }
  return { originX: minX, originZ: maxZ, stepX: spacing, stepZ: -spacing, spacingM: spacing, cols, rows, heights, complete: true };
};

export const denseLandscapeFixture = (routeCoordinates: Coordinate[], key = 'fixture:dense'): Landscape | null => {
  const frame = routeFrame(routeCoordinates);
  if (!frame || frame.points.length < 2) return null;
  const points: ScenePoint[] = frame.points.map(({ x, y }) => [x, -y]);
  const stations = stationsAlong(points);
  const landCover = landCoverAlong(stations);
  const built = builtAlong(stations);
  const elevation = hillsAround(frame, points);
  return {
    origin: frame.origin,
    key,
    elevation: layer(elevation, elevation.heights.length),
    landCover: layer(landCover, landCover.length),
    built: layer(built, built.footprints.length + built.places.length + built.landmarks.length),
  };
};
