/**
 * #762 VP-34 — the landscape around a route, out to the far plane: terrain
 * heights, land cover and built form, from open data. Data only; the scene
 * places kit models from it (#763 hills, #764 treelines, #765 buildings).
 *
 * `load` never rejects and never holds up a row: each layer is fetched on its
 * own (FR6), carries where it came from (FR1), and lands in the IndexedDB
 * cache (FR7) so a second row on the same water asks the network nothing.
 *
 *   elevation  Open-Meteo's elevation API (Copernicus GLO-90), the source
 *              route enrichment moved to in #741 because it sends CORS
 *              headers. Asked one call at a time on a shared lattice (FR3).
 *   landCover  one Overpass query: woods, hedges, fields, towns, beaches.
 *   built      one Overpass query: footprints within 600 m, and beyond that
 *              only places and tall landmarks (FR5).
 */
import type { Coordinate } from '../types/index';
import { latLngToMeters } from '../utils/geoUtils';
import { simplifyCoordinates } from '../utils/coordinateUtils';
import { joinIntoRings } from '../utils/osmWaterMask';
import {
  ELEVATION_API_URL,
  ELEVATION_BATCH_LIMIT,
  OVERPASS_API_URL,
  OVERPASS_MIRROR_URL,
  buildingsFromElements,
  corridorPolyline,
  type OverpassElement,
} from './routeEnrichmentService';
import {
  LANDSCAPE_REACH_M,
  distanceToCourse,
  latticeLat,
  latticeLng,
  latticeSceneXZ,
  planElevationLattice,
  routeFrame,
  type ElevationLattice,
  type RouteFrame,
} from './landscapeArea';
import { LandscapeCache, createLandscapeCache, type CachedElevation, type LandscapeRecord } from './landscapeCache';

/** FR5 — building footprints are kept only this close to the course. */
export const BUILT_FOOTPRINT_REACH_M = 600;
/** FR6 — each layer gives up after this long. */
export const LANDSCAPE_LAYER_BUDGET_MS = 45_000;
/** FR6 — tries per request on a 429 / 502 / 503 / 504 or a dropped connection. */
export const LANDSCAPE_MAX_ATTEMPTS = 3;
/** FR3b — at most one elevation call per second. */
export const ELEVATION_REQUEST_GAP_MS = 1000;
/** FR4 — land-cover outlines are simplified at this tolerance. */
export const LAND_COVER_TOLERANCE_M = 20;
/** FR5 — a feature tagged taller than this counts as a landmark. */
export const LANDMARK_MIN_HEIGHT_M = 30;
/** FR3 — grid points this close to the course are the water itself: height 0. */
export const WATER_FLAT_M = 30;
/** Course points the water level is read at. */
const WATER_SAMPLES_MAX = 200;
const WATER_SAMPLE_STEP_M = 100;
const RETRYABLE = new Set([429, 502, 503, 504]);

export type LandscapeSource = 'network' | 'cache' | 'unavailable';

export interface LandscapeLayer<T> {
  source: LandscapeSource;
  /** Time spent on this layer, ms (0 from the cache). */
  ms: number;
  /** Grid points with a height, features, or footprints + places + landmarks. */
  count: number;
  data: T | null;
}

/**
 * FR3 — heights in metres above the water at the nearest course point, on a
 * regular grid in scene XZ (the frame `routeCurvePoints` uses). Point
 * (col, row) is at `x = originX + col * stepX`, `z = originZ + row * stepZ`;
 * rows run south to north, so `stepZ` is negative. NaN outside the 2 km
 * buffer, and where a partly fetched grid has no answer yet.
 */
export interface ElevationGrid {
  originX: number;
  originZ: number;
  stepX: number;
  stepZ: number;
  spacingM: number;
  cols: number;
  rows: number;
  heights: Float32Array;
  /** False while some points inside the buffer are still unfetched (FR3d). */
  complete: boolean;
}

export type LandCoverKind =
  | 'wood'
  | 'forest'
  | 'tree_row'
  | 'hedge'
  | 'farmland'
  | 'meadow'
  | 'orchard'
  | 'vineyard'
  | 'residential'
  | 'industrial'
  | 'commercial'
  | 'retail'
  | 'scrub'
  | 'heath'
  | 'wetland'
  | 'bare_rock'
  | 'beach'
  | 'sand'
  | 'coastline';

/** Scene XZ, metres. */
export type ScenePoint = [x: number, z: number];

export interface LandCoverFeature {
  kind: LandCoverKind;
  /** A polygon's ring is closed (first point repeated last). */
  shape: 'polygon' | 'line';
  points: ScenePoint[];
}

export interface BuiltFootprint {
  kind: string;
  heightM?: number;
  points: ScenePoint[];
}

export type PlaceKind = 'city' | 'town' | 'village' | 'hamlet';

export interface Place {
  kind: PlaceKind;
  name?: string;
  population?: number;
  x: number;
  z: number;
}

export type LandmarkKind =
  | 'tower'
  | 'chimney'
  | 'mast'
  | 'lighthouse'
  | 'water_tower'
  | 'church'
  | 'cathedral'
  | 'power_tower'
  | 'wind_turbine'
  | 'tall';

export interface Landmark {
  kind: LandmarkKind;
  name?: string;
  heightM?: number;
  x: number;
  z: number;
}

export interface BuiltForm {
  footprints: BuiltFootprint[];
  places: Place[];
  landmarks: Landmark[];
}

export interface Landscape {
  /** The route's first coordinate: scene XZ (0, 0). */
  origin: Coordinate | null;
  /** The cache key: a hash of the simplified course. */
  key: string;
  elevation: LandscapeLayer<ElevationGrid>;
  landCover: LandscapeLayer<LandCoverFeature[]>;
  built: LandscapeLayer<BuiltForm>;
}

/** FR9 — what `window.__ROWER3D_LANDSCAPE` carries. */
export interface LandscapeTelemetry {
  elevation: { source: LandscapeSource; ms: number; count: number };
  landCover: { source: LandscapeSource; ms: number; count: number };
  built: { source: LandscapeSource; ms: number; count: number };
}

const unavailable = <T>(ms = 0): LandscapeLayer<T> => ({ source: 'unavailable', ms, count: 0, data: null });

/** FNV-1a over the simplified course, to 5 decimals (about a metre). */
export const landscapeKey = (frame: RouteFrame | null): string => {
  if (!frame) return 'landscape:none';
  let hash = 0x811c9dc5;
  const text = frame.simplified.map((c) => `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`).join(';');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `landscape:v1:${hash.toString(16).padStart(8, '0')}:${frame.simplified.length}`;
};

// ── land cover (FR4) ──────────────────────────────────────────────────────

const NATURAL_COVER = new Set<LandCoverKind>([
  'wood',
  'tree_row',
  'scrub',
  'heath',
  'wetland',
  'bare_rock',
  'beach',
  'sand',
  'coastline',
]);
const LANDUSE_COVER = new Set<LandCoverKind>([
  'forest',
  'farmland',
  'meadow',
  'orchard',
  'vineyard',
  'residential',
  'industrial',
  'commercial',
  'retail',
]);
const LINE_COVER = new Set<LandCoverKind>(['tree_row', 'hedge', 'coastline']);

/** FR4 — the land-cover kind an element's tags give, or null. */
export const landCoverKindOf = (tags: Record<string, string> | undefined): LandCoverKind | null => {
  if (!tags) return null;
  const natural = tags.natural as LandCoverKind | undefined;
  if (natural && NATURAL_COVER.has(natural)) return natural;
  const landuse = tags.landuse as LandCoverKind | undefined;
  if (landuse && LANDUSE_COVER.has(landuse)) return landuse;
  if (tags.barrier === 'hedge') return 'hedge';
  return null;
};

const NATURAL_PATTERN = [...NATURAL_COVER].join('|');
const LANDUSE_PATTERN = [...LANDUSE_COVER].join('|');

/** FR4 — one Overpass query for the land cover within `LANDSCAPE_REACH_M`. */
export const buildLandCoverQuery = (coordinates: Coordinate[]): string => {
  const around = `around:${LANDSCAPE_REACH_M},${corridorPolyline(coordinates)}`;
  return `
[out:json][timeout:40];
(
  way["natural"~"^(${NATURAL_PATTERN})$"](${around});
  relation["natural"~"^(${NATURAL_PATTERN})$"](${around});
  way["landuse"~"^(${LANDUSE_PATTERN})$"](${around});
  relation["landuse"~"^(${LANDUSE_PATTERN})$"](${around});
  way["barrier"="hedge"](${around});
);
out geom qt;
`;
};

const toCoordinates = (geometry: Array<{ lat: number; lon: number }> | undefined): Coordinate[] =>
  (geometry ?? [])
    .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
    .map((p) => ({ lat: p.lat, lng: p.lon }));

const toScene = (coordinates: Coordinate[], origin: Coordinate): ScenePoint[] =>
  coordinates.map((c) => {
    const m = latLngToMeters(c.lat, c.lng, origin.lat, origin.lng);
    return [m.x, -m.y];
  });

const isClosedRing = (ring: Coordinate[]) =>
  ring.length >= 4 && ring[0].lat === ring[ring.length - 1].lat && ring[0].lng === ring[ring.length - 1].lng;

/** FR4 — typed polygons and lines in scene XZ, simplified to 20 m. */
export const landCoverFromElements = (elements: OverpassElement[], origin: Coordinate): LandCoverFeature[] => {
  const out: LandCoverFeature[] = [];
  const push = (kind: LandCoverKind, shape: 'polygon' | 'line', coordinates: Coordinate[]) => {
    const simplified = simplifyCoordinates(coordinates, LAND_COVER_TOLERANCE_M);
    if (shape === 'polygon' && simplified.length < 4) return;
    if (shape === 'line' && simplified.length < 2) return;
    out.push({ kind, shape, points: toScene(simplified, origin) });
  };
  for (const element of elements) {
    const kind = landCoverKindOf(element.tags);
    if (!kind) continue;
    if (element.type === 'way') {
      const coordinates = toCoordinates(element.geometry);
      if (LINE_COVER.has(kind)) push(kind, 'line', coordinates);
      else if (isClosedRing(coordinates)) push(kind, 'polygon', coordinates);
    } else if (element.type === 'relation') {
      const outers = (element.members ?? []).filter((m) => m.role === 'outer').map((m) => toCoordinates(m.geometry));
      for (const ring of joinIntoRings(outers)) push(kind, LINE_COVER.has(kind) ? 'line' : 'polygon', ring);
    }
  }
  return out;
};

// ── built form (FR5) ──────────────────────────────────────────────────────

const PLACE_KINDS = new Set<PlaceKind>(['city', 'town', 'village', 'hamlet']);
const MAN_MADE_LANDMARKS = new Set<LandmarkKind>(['tower', 'chimney', 'mast', 'lighthouse', 'water_tower']);

const parseMetres = (raw: string | undefined): number | undefined => {
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** FR5 — the landmark an element's tags make, or null. */
export const landmarkKindOf = (tags: Record<string, string> | undefined): LandmarkKind | null => {
  if (!tags) return null;
  const manMade = tags.man_made as LandmarkKind | undefined;
  if (manMade && MAN_MADE_LANDMARKS.has(manMade)) return manMade;
  if (tags.building === 'church' || tags.building === 'cathedral') return tags.building;
  if (tags.power === 'tower') return 'power_tower';
  if (tags['generator:source'] === 'wind' || tags['generator:method'] === 'wind_turbine') return 'wind_turbine';
  const height = parseMetres(tags.height);
  if (height !== undefined && height > LANDMARK_MIN_HEIGHT_M) return 'tall';
  return null;
};

/** FR5 — footprints within 600 m; places and landmarks out to the far plane. */
export const buildBuiltFormQuery = (coordinates: Coordinate[]): string => {
  const polyline = corridorPolyline(coordinates);
  const near = `around:${BUILT_FOOTPRINT_REACH_M},${polyline}`;
  const far = `around:${LANDSCAPE_REACH_M},${polyline}`;
  return `
[out:json][timeout:40];
(
  way["building"](${near});
  relation["building"](${near});
  node["place"~"^(city|town|village|hamlet)$"](${far});
  nwr["man_made"~"^(tower|chimney|mast|lighthouse|water_tower)$"](${far});
  nwr["building"~"^(church|cathedral)$"](${far});
  nwr["power"="tower"](${far});
  nwr["generator:source"="wind"](${far});
  nwr["height"](if: number(t["height"]) > ${LANDMARK_MIN_HEIGHT_M})(${far});
);
out geom qt;
`;
};

const centreOf = (element: OverpassElement): Coordinate | null => {
  if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) return { lat: element.lat!, lng: element.lon! };
  const points = [
    ...toCoordinates(element.geometry),
    ...(element.members ?? []).flatMap((m) => toCoordinates(m.geometry)),
  ];
  if (points.length === 0) {
    const b = element.bounds;
    return b ? { lat: (b.minlat + b.maxlat) / 2, lng: (b.minlon + b.maxlon) / 2 } : null;
  }
  return {
    lat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
    lng: points.reduce((sum, p) => sum + p.lng, 0) / points.length,
  };
};

export const builtFormFromElements = (elements: OverpassElement[], frame: RouteFrame): BuiltForm => {
  const { origin } = frame;
  const nearCourse = (c: Coordinate) => {
    const m = latLngToMeters(c.lat, c.lng, origin.lat, origin.lng);
    return distanceToCourse(frame, m.x, m.y) <= BUILT_FOOTPRINT_REACH_M;
  };
  const footprints: BuiltFootprint[] = buildingsFromElements(elements)
    .filter((b) => b.footprint.some(nearCourse))
    .map((b) => ({
      kind: b.kind ?? 'yes',
      ...(b.heightMeters !== undefined ? { heightM: b.heightMeters } : {}),
      points: toScene(b.footprint, origin),
    }));

  const places: Place[] = [];
  const landmarks: Landmark[] = [];
  const seen = new Set<string>();
  for (const element of elements) {
    const tags = element.tags;
    const id = `${element.type}/${element.id ?? ''}`;
    if (element.id !== undefined && seen.has(id)) continue;
    seen.add(id);
    const place = tags?.place as PlaceKind | undefined;
    if (element.type === 'node' && place && PLACE_KINDS.has(place)) {
      const at = centreOf(element);
      if (!at) continue;
      const [x, z] = toScene([at], origin)[0];
      const population = tags?.population ? Number.parseInt(tags.population.replace(/[ ,]/g, ''), 10) : NaN;
      places.push({
        kind: place,
        ...(tags?.name ? { name: tags.name } : {}),
        ...(Number.isFinite(population) ? { population } : {}),
        x,
        z,
      });
      continue;
    }
    const kind = landmarkKindOf(tags);
    if (!kind) continue;
    const at = centreOf(element);
    if (!at) continue;
    const [x, z] = toScene([at], origin)[0];
    const heightM = parseMetres(tags?.height);
    landmarks.push({
      kind,
      ...(tags?.name ? { name: tags.name } : {}),
      ...(heightM !== undefined ? { heightM } : {}),
      x,
      z,
    });
  }
  return { footprints, places, landmarks };
};

// ── elevation (FR3) ───────────────────────────────────────────────────────

/** Course points the water level is read at: every 100 m, at most 200. */
export const waterSamplesFor = (frame: RouteFrame): Coordinate[] => {
  const pts = frame.points;
  let length = 0;
  for (let i = 1; i < pts.length; i += 1) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  const step = Math.max(WATER_SAMPLE_STEP_M, length / (WATER_SAMPLES_MAX - 1));
  const { origin } = frame;
  const cosOrigin = Math.cos((origin.lat * Math.PI) / 180);
  const toLatLng = (x: number, y: number): Coordinate => ({
    lat: Number((origin.lat + (y / 6378137) * (180 / Math.PI)).toFixed(6)),
    lng: Number((origin.lng + (x / (6378137 * cosOrigin)) * (180 / Math.PI)).toFixed(6)),
  });
  const out: Coordinate[] = [toLatLng(pts[0].x, pts[0].y)];
  let carried = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    let at = step - carried;
    while (at <= seg && out.length < WATER_SAMPLES_MAX) {
      const t = at / seg;
      out.push(toLatLng(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
      at += step;
    }
    carried = seg - (at - step);
  }
  const end = pts[pts.length - 1];
  if (out.length < WATER_SAMPLES_MAX && carried > 1) out.push(toLatLng(end.x, end.y));
  return out;
};

/** The median of each sample and its two neighbours either side, NaN skipped. */
const smoothWaterLevels = (levels: Float32Array): Float32Array => {
  const out = new Float32Array(levels.length);
  for (let i = 0; i < levels.length; i += 1) {
    const window: number[] = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(levels.length - 1, i + 2); j += 1) {
      if (Number.isFinite(levels[j])) window.push(levels[j]);
    }
    window.sort((a, b) => a - b);
    out[i] = window.length > 0 ? window[Math.floor(window.length / 2)] : NaN;
  }
  return out;
};

/**
 * FR3 — the published grid: each fetched height less the water level at the
 * nearest course sample, and 0 within `WATER_FLAT_M` of the course, where the
 * DEM over open water is noise. Null when no water level is known.
 */
export const elevationGridFrom = (
  cached: CachedElevation,
  lattice: ElevationLattice,
  frame: RouteFrame,
  samples: Coordinate[],
): ElevationGrid | null => {
  const levels = smoothWaterLevels(cached.water);
  const known = samples
    .map((c, i) => ({ m: latLngToMeters(c.lat, c.lng, frame.origin.lat, frame.origin.lng), level: levels[i] }))
    .filter((s) => Number.isFinite(s.level));
  if (known.length === 0) return null;
  const { originX, originZ, stepX, stepZ } = latticeSceneXZ(lattice, frame.origin);
  const heights = new Float32Array(lattice.cols * lattice.rows).fill(NaN);
  let complete = true;
  for (let row = 0; row < lattice.rows; row += 1) {
    for (let col = 0; col < lattice.cols; col += 1) {
      const index = row * lattice.cols + col;
      if (!lattice.inside[index]) continue;
      const absolute = cached.heights[index];
      if (!Number.isFinite(absolute)) {
        complete = false;
        continue;
      }
      const x = originX + col * stepX;
      const y = -(originZ + row * stepZ);
      if (distanceToCourse(frame, x, y) <= WATER_FLAT_M) {
        heights[index] = 0;
        continue;
      }
      let nearest = known[0];
      let best = Infinity;
      for (const s of known) {
        const d = (s.m.x - x) ** 2 + (s.m.y - y) ** 2;
        if (d < best) {
          best = d;
          nearest = s;
        }
      }
      heights[index] = absolute - nearest.level;
    }
  }
  return {
    originX,
    originZ,
    stepX,
    stepZ,
    spacingM: lattice.spacingM,
    cols: lattice.cols,
    rows: lattice.rows,
    heights,
    complete: complete && Array.from(cached.water).every((v) => Number.isFinite(v)),
  };
};

// ── transport (FR6) ───────────────────────────────────────────────────────

class RetryableError extends Error {
  readonly retryAfterMs: number | null;

  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

export interface LandscapeServiceOptions {
  fetchImpl?: typeof fetch;
  /** Null: no cache (tests, and browsers without IndexedDB). */
  cache?: LandscapeCache | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  requestGapMs?: number;
  layerBudgetMs?: number;
  /** FR9 — publish `window.__ROWER3D_LANDSCAPE`. */
  publish?: boolean;
  overpassUrls?: string[];
}

export class LandscapeService {
  private readonly fetchImpl: typeof fetch;
  private readonly cache: LandscapeCache | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly requestGapMs: number;
  private readonly layerBudgetMs: number;
  private readonly publish: boolean;
  private readonly overpassUrls: string[];

  constructor(options: LandscapeServiceOptions = {}) {
    // Through an arrow: a bare `fetch` called with the service as receiver
    // throws "Illegal invocation" in browsers (#493 AC8).
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.cache = options.cache === undefined ? createLandscapeCache() : options.cache;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.requestGapMs = options.requestGapMs ?? ELEVATION_REQUEST_GAP_MS;
    this.layerBudgetMs = options.layerBudgetMs ?? LANDSCAPE_LAYER_BUDGET_MS;
    this.publish = options.publish ?? true;
    this.overpassUrls = options.overpassUrls ?? [OVERPASS_API_URL, OVERPASS_MIRROR_URL];
  }

  /** FR1 — never rejects; each layer says where it came from. */
  async load(routeCoordinates: Coordinate[]): Promise<Landscape> {
    const frame = routeFrame(routeCoordinates ?? []);
    const key = landscapeKey(frame);
    const landscape: Landscape = {
      origin: frame?.origin ?? null,
      key,
      elevation: unavailable(),
      landCover: unavailable(),
      built: unavailable(),
    };
    if (!frame || frame.points.length < 2) {
      this.report(landscape);
      return landscape;
    }

    const record = await this.readCache(key);
    // `savedAt` is stamped by the cache when the record is written.
    const stored: LandscapeRecord = record ?? { key, savedAt: 0 };

    await Promise.all([
      this.elevationLayer(frame, stored).then((layer) => {
        landscape.elevation = layer;
        this.report(landscape);
      }),
      this.overpassLayer(
        stored.landCover,
        () => buildLandCoverQuery(frame.simplified),
        (elements) => landCoverFromElements(elements, frame.origin),
        (features) => features.length,
        (features) => {
          stored.landCover = features;
        },
      ).then((layer) => {
        landscape.landCover = layer;
        this.report(landscape);
      }),
      this.overpassLayer(
        stored.built,
        () => buildBuiltFormQuery(frame.simplified),
        (elements) => builtFormFromElements(elements, frame),
        (built) => built.footprints.length + built.places.length + built.landmarks.length,
        (built) => {
          stored.built = built;
        },
      ).then((layer) => {
        landscape.built = layer;
        this.report(landscape);
      }),
    ]);

    const fetched = [landscape.elevation, landscape.landCover, landscape.built].some((l) => l.source === 'network');
    if (this.cache && fetched) {
      await this.cache.put(stored).catch(() => undefined);
    }
    return landscape;
  }

  private async readCache(key: string): Promise<LandscapeRecord | undefined> {
    if (!this.cache) return undefined;
    try {
      return await this.cache.get(key);
    } catch {
      return undefined;
    }
  }

  private report(landscape: Landscape): void {
    if (!this.publish || typeof window === 'undefined') return;
    const pick = (l: LandscapeLayer<unknown>) => ({ source: l.source, ms: l.ms, count: l.count });
    const telemetry: LandscapeTelemetry = {
      elevation: pick(landscape.elevation),
      landCover: pick(landscape.landCover),
      built: pick(landscape.built),
    };
    (window as unknown as { __ROWER3D_LANDSCAPE?: LandscapeTelemetry }).__ROWER3D_LANDSCAPE = telemetry;
  }

  private async overpassLayer<T>(
    cached: T | undefined,
    query: () => string,
    parse: (elements: OverpassElement[]) => T,
    count: (data: T) => number,
    keep: (data: T) => void,
  ): Promise<LandscapeLayer<T>> {
    if (cached !== undefined) return { source: 'cache', ms: 0, count: count(cached), data: cached };
    const started = this.now();
    const deadline = started + this.layerBudgetMs;
    try {
      const elements = await this.postOverpass(query(), deadline);
      const data = parse(elements);
      keep(data);
      return { source: 'network', ms: this.now() - started, count: count(data), data };
    } catch {
      return unavailable(this.now() - started);
    }
  }

  /** FR6 — the endpoints in turn, up to three tries, inside the layer's budget. */
  private async postOverpass(query: string, deadline: number): Promise<OverpassElement[]> {
    let lastError: unknown = new Error('Overpass: no endpoint');
    for (let attempt = 0; attempt < LANDSCAPE_MAX_ATTEMPTS; attempt += 1) {
      const url = this.overpassUrls[attempt % this.overpassUrls.length];
      try {
        const response = await this.request(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: `data=${encodeURIComponent(query)}`,
          },
          deadline,
        );
        const payload = (await response.json()) as { elements?: OverpassElement[] };
        return payload.elements ?? [];
      } catch (error) {
        lastError = error;
        if (!(error instanceof RetryableError)) throw error;
        if (!(await this.backoff(error, attempt, deadline))) break;
      }
    }
    throw lastError;
  }

  /** Waits before the next try; false when the budget would run out first. */
  private async backoff(error: RetryableError, attempt: number, deadline: number): Promise<boolean> {
    if (attempt + 1 >= LANDSCAPE_MAX_ATTEMPTS) return false;
    const wait = error.retryAfterMs ?? 1000 * 2 ** attempt;
    if (this.now() + wait >= deadline) return false;
    await this.sleep(wait);
    return true;
  }

  /** One fetch, cut off at the deadline. Retryable statuses throw `RetryableError`. */
  private async request(url: string, init: RequestInit, deadline: number): Promise<Response> {
    const remaining = deadline - this.now();
    if (remaining <= 0) throw new Error('landscape layer budget spent');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error('landscape request timed out'));
      }, remaining);
    });
    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetchImpl(url, { ...init, ...(controller ? { signal: controller.signal } : {}) }),
          timeout,
        ]);
      } catch (error) {
        if (error instanceof Error && error.message === 'landscape request timed out') throw error;
        throw new RetryableError(String(error), null);
      }
      if (RETRYABLE.has(response.status)) {
        const header = Number.parseFloat(response.headers?.get?.('Retry-After') ?? '');
        throw new RetryableError(`HTTP ${response.status}`, Number.isFinite(header) ? header * 1000 : null);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /** FR3 / FR3b / FR3d — sequential calls, resumed from a partly cached grid. */
  private async elevationLayer(frame: RouteFrame, stored: LandscapeRecord): Promise<LandscapeLayer<ElevationGrid>> {
    const started = this.now();
    const deadline = started + this.layerBudgetMs;
    const lattice = planElevationLattice(frame);
    const samples = waterSamplesFor(frame);
    const reusable =
      stored.elevation &&
      stored.elevation.spacingM === lattice.spacingM &&
      stored.elevation.lat0Index === lattice.lat0Index &&
      stored.elevation.lng0Index === lattice.lng0Index &&
      stored.elevation.heights.length === lattice.cols * lattice.rows &&
      stored.elevation.water.length === samples.length;
    const cached: CachedElevation = reusable
      ? stored.elevation!
      : {
          spacingM: lattice.spacingM,
          lat0Index: lattice.lat0Index,
          lng0Index: lattice.lng0Index,
          heights: new Float32Array(lattice.cols * lattice.rows).fill(NaN),
          water: new Float32Array(samples.length).fill(NaN),
        };
    stored.elevation = cached;

    // Water levels first: without them no height can be made relative.
    const wanted: Array<{ at: Coordinate; set: (h: number) => void }> = [];
    samples.forEach((at, i) => {
      if (!Number.isFinite(cached.water[i])) wanted.push({ at, set: (h) => (cached.water[i] = h) });
    });
    for (let row = 0; row < lattice.rows; row += 1) {
      for (let col = 0; col < lattice.cols; col += 1) {
        const index = row * lattice.cols + col;
        if (!lattice.inside[index] || Number.isFinite(cached.heights[index])) continue;
        wanted.push({
          at: { lat: latticeLat(lattice, row), lng: latticeLng(lattice, col) },
          set: (h) => (cached.heights[index] = h),
        });
      }
    }

    let fetchedAny = false;
    for (let start = 0; start < wanted.length; start += ELEVATION_BATCH_LIMIT) {
      if (start > 0) {
        if (this.now() + this.requestGapMs >= deadline) break;
        await this.sleep(this.requestGapMs);
      }
      const batch = wanted.slice(start, start + ELEVATION_BATCH_LIMIT);
      const heights = await this.fetchElevationBatch(batch.map((w) => w.at), deadline);
      if (!heights) break;
      batch.forEach((w, i) => {
        const h = heights[i];
        if (typeof h === 'number' && Number.isFinite(h)) w.set(h);
      });
      fetchedAny = true;
    }

    const grid = elevationGridFrom(cached, lattice, frame, samples);
    if (!grid) return unavailable(this.now() - started);
    const count = grid.heights.reduce((n, h) => (Number.isFinite(h) ? n + 1 : n), 0);
    const source: LandscapeSource = wanted.length === 0 ? 'cache' : fetchedAny ? 'network' : 'cache';
    if (count === 0) return unavailable(this.now() - started);
    return { source, ms: source === 'cache' ? 0 : this.now() - started, count, data: grid };
  }

  private async fetchElevationBatch(points: Coordinate[], deadline: number): Promise<Array<number | null> | null> {
    const url = `${ELEVATION_API_URL}?latitude=${points.map((p) => p.lat).join(',')}&longitude=${points
      .map((p) => p.lng)
      .join(',')}`;
    for (let attempt = 0; attempt < LANDSCAPE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.request(url, {}, deadline);
        const payload = (await response.json()) as { elevation?: Array<number | null> };
        return payload.elevation ?? null;
      } catch (error) {
        if (!(error instanceof RetryableError)) return null;
        if (!(await this.backoff(error, attempt, deadline))) return null;
      }
    }
    return null;
  }
}

/** The app's instance: IndexedDB-cached, publishing telemetry. */
export const landscapeService = new LandscapeService();
