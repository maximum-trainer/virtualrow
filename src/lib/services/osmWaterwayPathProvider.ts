/**
 * Derive a course path from OpenStreetMap waterway centrelines (issue #194 R-12).
 *
 * Fetches every river/canal/stream/tidal-channel/fairway way around a course's
 * gates from Overpass, builds an undirected graph of their vertices, snaps each
 * gate centroid to the nearest vertex, and walks the shortest path from gate to
 * gate in order.
 *
 * ## Spike result: NO-GO — not enabled by default
 *
 * Measured against the AC-12 course set on 2026-08-30 (live Overpass):
 *
 * | course | gates snapped ≤ 150 m | path | derived length |
 * | ------ | --------------------- | ---- | -------------- |
 * | 179 Castle to Crane | Start 48 m, **Finish 215 m** | no  | (21.69 km when forced) |
 * | 261 Isle of Ely Head | Start 27 m, **Finish 151 m** | no  | — |
 * | 14 Prague Primatorky | 49 m, 46 m                   | yes | 0.88 km vs 0.886 declared |
 * | 61 HOCR Rev C        | all 19 within 48 m           | yes | 4.84 km vs 4.703 declared |
 * | 233 HOTS Stake race  | **green #13 228 m**          | no  | — |
 * | 1, 12, 13 (lakes)    | 1 snapped, 12/13 did not     | —   | fell through cleanly |
 *
 * Snap coverage passes (28 of 31 river/canal gates, 90 %) and both derived
 * lengths land within 10 %, but a path was found for only 2 of the 5
 * river/canal courses against the "≥ 4 of 5" bar. The failures are all the same
 * shape: a finish gate placed mid-estuary, hundreds of metres from the mapped
 * centreline, on exactly the wide water where the straight-line problem hurts
 * most. So the provider ships unused — `resolveCourseGeometry` is only given
 * one when a caller passes it — and the user-attached track (R-8) is the
 * supported answer. Widening the snap radius is the obvious next experiment;
 * it needs a way to reject a snap onto the wrong waterway first.
 *
 * ## Revisited in #743: enabled
 *
 * The failures above were not about the radius. Three things changed:
 *
 *  1. Gates snap to the nearest point ON A SEGMENT, not the nearest vertex. A
 *     long straight reach is mapped with a vertex every few hundred metres, so
 *     a gate sitting on the river could be "200 m from the waterway".
 *  2. The snap limit scales with the gate: a 200 m finish line across an
 *     estuary is allowed to be further from the centreline than a 20 m gate on
 *     a canal ({@link snapLimitFor}).
 *  3. The wrong-waterway check the spike asked for: a leg whose walk is far
 *     longer than the straight line between its gates, or a whole path far
 *     longer than the gate chain, is refused ({@link MAX_LEG_DETOUR_RATIO},
 *     {@link MAX_TOTAL_DETOUR_RATIO}).
 *
 * A gate well off the centreline is joined by a diagonal run-in: the walk is
 * trimmed back by the gate's offset and the gate centre added, so the line
 * leaves the centreline toward the gate instead of spiking out and back.
 *
 * Not done: riverbank polygons (`natural=water`) where no `waterway` way is
 * mapped. Those courses still fall through to the gate chain.
 */

import type { Coordinate } from '../types/index';
import { distanceBetweenMeters, polylineLengthMeters } from '../utils/coordinateUtils';
import { slicePolyline } from '../utils/polylineGeometry';
import type { WaterwayPathOptions, WaterwayPathProvider } from './rownativeGeometry';
import { deriveAreaCentreline, parseWaterAreas } from './waterAreaCentreline';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Waterway classes a rowing course can plausibly follow. */
const WATERWAY_FILTER = '^(river|canal|stream|tidal_channel|fairway)$';
/** #751 FR1: water mapped as an area (`water=river|canal|dock` are `natural=water`). */
const WATER_AREA_SELECTORS = [
  'way["natural"="water"]',
  'relation["natural"="water"]',
  'way["waterway"="riverbank"]',
  'relation["waterway"="riverbank"]',
];

/** Margin added around the gate bounding box, in metres. */
const BBOX_MARGIN_M = 1000;

/** A small gate further than this from any mapped waterway is not on it. */
export const MAX_SNAP_DISTANCE_M = 150;
/** However wide the gate, never reach further than this for a waterway. */
export const MAX_SNAP_DISTANCE_CEILING_M = 400;
/** A gate may sit this many of its own widths from the centreline. */
export const SNAP_GATE_EXTENT_FACTOR = 1.5;

/** A gate nearer the centreline than this is treated as being on it. */
export const ON_CENTRELINE_M = 25;
/** A run-in to an off-centreline gate takes at most this share of its leg. */
const RUN_IN_MAX_LEG_SHARE = 0.4;

/**
 * A leg may be this many times its straight-line length, plus the slack
 * below, before it is taken for a walk along the wrong waterway. Real rivers
 * between consecutive gates rarely exceed 2x; an oxbow can.
 */
export const MAX_LEG_DETOUR_RATIO = 3;
export const LEG_DETOUR_SLACK_M = 200;
/** The whole path against the gate chain. */
export const MAX_TOTAL_DETOUR_RATIO = 2.2;
export const MIN_TOTAL_DETOUR_RATIO = 0.95;

/** How far a gate of this extent may be from the waterway it is on. */
export const snapLimitFor = (gateExtentMeters: number | undefined): number => {
  const extent = Number.isFinite(gateExtentMeters) ? (gateExtentMeters as number) : 0;
  return Math.min(
    MAX_SNAP_DISTANCE_CEILING_M,
    Math.max(MAX_SNAP_DISTANCE_M, extent * SNAP_GATE_EXTENT_FACTOR),
  );
};

/**
 * Total time one lookup may take, retries included, before the caller falls
 * through to the gate chain.
 *
 * It was 8 s. Measured from a browser on 2026-11-22, the public Overpass
 * server took 26-36 s for every waterway query, small or large (16 KB for the
 * Isle of Ely, 552 KB for Castle to Crane), so 8 s meant the lookup never
 * returned and every river course stayed a straight line.
 */
export const LOOKUP_BUDGET_MS = 40_000;
/** Wait this long, then twice this, before asking a busy server again. */
export const RETRY_DELAY_MS = 3000;
const MAX_ATTEMPTS = 3;
/** "At capacity" / rate-limited answers, which a later attempt can change. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export interface OsmWaterwayPathProviderOptions {
  budgetMs?: number;
  retryDelayMs?: number;
}

const METERS_PER_DEGREE_LAT = 111_320;

interface OverpassWay {
  type?: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

/** #751: a water area (bank outline), not a line to walk. */
const isWaterArea = (element: OverpassWay): boolean =>
  element?.type === 'relation'
  || element?.tags?.natural === 'water'
  || element?.tags?.waterway === 'riverbank';

interface OverpassResponse {
  elements?: OverpassWay[];
}

/** Vertices are keyed by rounded position so shared way endpoints join up. */
function vertexKey(point: Coordinate): string {
  return `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
}

interface WaterwayGraph {
  adjacency: Map<string, [string, number][]>;
  vertices: Map<string, Coordinate>;
  /** Every mapped segment, for snapping a gate onto the line between vertices. */
  edges: [Coordinate, Coordinate][];
  link(a: Coordinate, b: Coordinate): void;
}

function buildGraph(ways: OverpassWay[]): WaterwayGraph {
  const adjacency = new Map<string, [string, number][]>();
  const vertices = new Map<string, Coordinate>();

  const link = (a: Coordinate, b: Coordinate) => {
    const keyA = vertexKey(a);
    const keyB = vertexKey(b);
    if (keyA === keyB) return;
    vertices.set(keyA, a);
    vertices.set(keyB, b);
    const weight = distanceBetweenMeters(a, b);
    if (!adjacency.has(keyA)) adjacency.set(keyA, []);
    if (!adjacency.has(keyB)) adjacency.set(keyB, []);
    adjacency.get(keyA)!.push([keyB, weight]);
    adjacency.get(keyB)!.push([keyA, weight]);
  };
  const edges: [Coordinate, Coordinate][] = [];

  for (const way of ways) {
    const geometry = (way?.geometry ?? [])
      .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lon))
      .map((point) => ({ lat: point.lat, lng: point.lon }));
    for (let i = 0; i < geometry.length - 1; i++) {
      link(geometry[i], geometry[i + 1]);
      edges.push([geometry[i], geometry[i + 1]]);
    }
  }

  return { adjacency, vertices, edges, link };
}

interface Snap {
  key: string;
  point: Coordinate;
  distanceMeters: number;
}

/**
 * Snap a gate onto the nearest point of the nearest mapped segment, and add
 * that point to the graph so a walk can start or end there.
 *
 * Nearest VERTEX was the spike's mistake: a straight reach carries a vertex
 * every few hundred metres, so a gate on the water read as far from it.
 */
function snapToGraph(graph: WaterwayGraph, point: Coordinate): Snap | null {
  const lngScale = Math.max(0.01, Math.cos((point.lat * Math.PI) / 180));
  const px = point.lng * lngScale;
  const py = point.lat;
  let best: { a: Coordinate; b: Coordinate; t: number; d2: number; index: number } | null = null;
  for (const [index, [a, b]] of graph.edges.entries()) {
    const ax = a.lng * lngScale;
    const ay = a.lat;
    const dx = b.lng * lngScale - ax;
    const dy = b.lat - ay;
    const span = dx * dx + dy * dy;
    const t = span > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / span)) : 0;
    const qx = ax + dx * t - px;
    const qy = ay + dy * t - py;
    const d2 = qx * qx + qy * qy;
    if (!best || d2 < best.d2) best = { a, b, t, d2, index };
  }
  if (!best) return null;

  const { a, b, t } = best;
  const snapped: Coordinate =
    t <= 0 ? a : t >= 1 ? b : { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  if (t > 0 && t < 1) {
    graph.link(a, snapped);
    graph.link(snapped, b);
    // Split the segment in the edge list too, so a second gate on the same
    // reach snaps to a half that is joined to this one. Left whole, two gates
    // on one long segment could only reach each other via its far ends.
    graph.edges.splice(best.index, 1, [a, snapped], [snapped, b]);
  }
  return { key: vertexKey(snapped), point: snapped, distanceMeters: distanceBetweenMeters(point, snapped) };
}

/** Dijkstra over the waterway graph. Returns the vertex path, or `null`. */
function shortestPath(graph: WaterwayGraph, from: string, to: string): Coordinate[] | null {
  const best = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, string>();
  const frontier: [number, string][] = [[0, from]];

  while (frontier.length > 0) {
    // Small graphs (a few thousand vertices); a sorted array beats the code a
    // real heap would cost here.
    frontier.sort((a, b) => a[0] - b[0]);
    const [cost, key] = frontier.shift()!;
    if (key === to) break;
    if (cost > (best.get(key) ?? Infinity)) continue;

    for (const [neighbour, weight] of graph.adjacency.get(key) ?? []) {
      const next = cost + weight;
      if (next < (best.get(neighbour) ?? Infinity)) {
        best.set(neighbour, next);
        previous.set(neighbour, key);
        frontier.push([next, neighbour]);
      }
    }
  }

  if (!best.has(to)) return null;
  const path: Coordinate[] = [];
  let cursor: string | undefined = to;
  while (cursor !== undefined) {
    const vertex = graph.vertices.get(cursor);
    if (vertex) path.unshift(vertex);
    if (cursor === from) break;
    cursor = previous.get(cursor);
  }
  return path.length >= 2 ? path : null;
}

export class OsmWaterwayPathProvider implements WaterwayPathProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, Coordinate[] | null>();

  private readonly budgetMs: number;
  private readonly retryDelayMs: number;

  constructor(
    fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
    options: OsmWaterwayPathProviderOptions = {},
  ) {
    this.fetchImpl = fetchImpl;
    this.budgetMs = options.budgetMs ?? LOOKUP_BUDGET_MS;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  }

  /** Cache key mirrors the route-enrichment scheme: the query's bounding box. */
  private static cacheKey(bbox: string): string {
    return `osm-waterway:${bbox}`;
  }

  private static boundingBox(gates: Coordinate[]): string {
    const lats = gates.map((gate) => gate.lat);
    const lngs = gates.map((gate) => gate.lng);
    const latMargin = BBOX_MARGIN_M / METERS_PER_DEGREE_LAT;
    const meanLat = lats.reduce((sum, lat) => sum + lat, 0) / lats.length;
    const lngMargin = latMargin / Math.max(0.01, Math.cos((meanLat * Math.PI) / 180));
    return [
      Math.min(...lats) - latMargin,
      Math.min(...lngs) - lngMargin,
      Math.max(...lats) + latMargin,
      Math.max(...lngs) + lngMargin,
    ].map((value) => value.toFixed(5)).join(',');
  }

  /**
   * Walk the waterway network from gate to gate.
   *
   * Returns `null` — never throws — when Overpass is unreachable, returns
   * nonsense, a gate cannot be snapped, or no path connects two gates.
   */
  async findPath(gates: Coordinate[], options: WaterwayPathOptions = {}): Promise<Coordinate[] | null> {
    if (gates.length < 2) return null;

    const bbox = OsmWaterwayPathProvider.boundingBox(gates);
    const key = OsmWaterwayPathProvider.cacheKey(bbox);
    if (this.cache.has(key)) return this.cache.get(key) ?? null;

    const path = await this.derivePath(bbox, gates, options).catch(() => null);
    this.cache.set(key, path);
    return path;
  }

  /**
   * POST one Overpass query with the retry policy, inside one budget that
   * covers the request in flight and any wait between attempts. Resolves the
   * parsed `elements`, or null when the server never answered well.
   */
  private async overpassElements(query: string): Promise<unknown[] | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.budgetMs);
    const pause = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('lookup budget spent'));
        });
      });

    let response: Response | undefined;
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        response = await this.fetchImpl(OVERPASS_URL, {
          method: 'POST',
          body: `data=${encodeURIComponent(query)}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: controller.signal,
        });
        if (response?.ok || !RETRYABLE_STATUS.has(response?.status ?? 0) || attempt === MAX_ATTEMPTS) break;
        await pause(this.retryDelayMs * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
    if (!response?.ok) return null;
    const payload = await response.json() as OverpassResponse;
    return Array.isArray(payload?.elements) ? payload.elements : [];
  }

  /** The whole path is neither a long detour nor shorter than the gate chain (FR5). */
  private static withinTotalDetour(gates: Coordinate[], path: Coordinate[]): boolean {
    const chain = polylineLengthMeters(gates);
    const total = polylineLengthMeters(path);
    return !(chain > 0 && (total > chain * MAX_TOTAL_DETOUR_RATIO || total < chain * MIN_TOTAL_DETOUR_RATIO));
  }

  /**
   * #751 FR1: no `waterway` way near a gate, so walk the water area the gates
   * are in. Each leg is a centreline derived from the banks (FR2 checks live
   * in {@link deriveAreaCentreline}); any leg without one declines the lot.
   * The areas come back in the same answer as the waterways, so a course
   * still costs one Overpass request (#756 FR5).
   */
  private static deriveAreaPath(areas: readonly unknown[], gates: Coordinate[]): Coordinate[] | null {
    const rings = parseWaterAreas(areas);
    if (rings.length === 0) return null;

    let full: Coordinate[] = [];
    for (let i = 0; i < gates.length - 1; i++) {
      const leg = deriveAreaCentreline(gates[i], gates[i + 1], rings);
      if (!leg) return null;
      full = full.concat(full.length > 0 ? leg.coordinates.slice(1) : leg.coordinates);
    }
    return full.length >= 2 && OsmWaterwayPathProvider.withinTotalDetour(gates, full) ? full : null;
  }

  private async derivePath(
    bbox: string,
    gates: Coordinate[],
    options: WaterwayPathOptions,
  ): Promise<Coordinate[] | null> {
    const selectors = [`way["waterway"~"${WATERWAY_FILTER}"]`, ...WATER_AREA_SELECTORS];
    const elements = await this.overpassElements(
      `[out:json][timeout:25];(${selectors.map((sel) => `${sel}(${bbox});`).join('')});out geom;`,
    ) as OverpassWay[] | null;
    if (!elements) return null;
    const areas = elements.filter(isWaterArea);
    const graph = buildGraph(elements.filter((element) => !isWaterArea(element)));

    const snaps: Snap[] = [];
    for (const [index, gate] of gates.entries()) {
      const snap = graph.vertices.size > 0 ? snapToGraph(graph, gate) : null;
      if (!snap || snap.distanceMeters > snapLimitFor(options.gateExtentsMeters?.[index])) {
        return OsmWaterwayPathProvider.deriveAreaPath(areas, gates);
      }
      snaps.push(snap);
    }

    // Walk gate to gate. Each leg is checked on its own: a walk several times
    // longer than the straight line between two gates has left this water.
    const legs: Coordinate[][] = [];
    for (let i = 0; i < snaps.length - 1; i++) {
      const chord = distanceBetweenMeters(gates[i], gates[i + 1]);
      const leg = snaps[i].key === snaps[i + 1].key
        ? [snaps[i].point]
        : shortestPath(graph, snaps[i].key, snaps[i + 1].key);
      if (!leg) return null;
      const allowed =
        chord * MAX_LEG_DETOUR_RATIO
        + LEG_DETOUR_SLACK_M
        + snaps[i].distanceMeters
        + snaps[i + 1].distanceMeters;
      if (polylineLengthMeters(leg) > allowed) return null;
      legs.push(leg);
    }

    // Stitch the legs, sending the line out to any gate that sits well off the
    // centreline. The walk either side is trimmed back by the gate's offset so
    // the run-in is a diagonal, not a spike out and back along the same line.
    const offCentre = (index: number): boolean => snaps[index].distanceMeters > ON_CENTRELINE_M;
    let full: Coordinate[] = offCentre(0) ? [gates[0]] : [];
    for (let i = 0; i < legs.length; i++) {
      let leg = legs[i];
      const legLength = polylineLengthMeters(leg);
      const trimStart = offCentre(i)
        ? Math.min(snaps[i].distanceMeters, legLength * RUN_IN_MAX_LEG_SHARE)
        : 0;
      const trimEnd = offCentre(i + 1)
        ? Math.min(snaps[i + 1].distanceMeters, legLength * RUN_IN_MAX_LEG_SHARE)
        : 0;
      if (leg.length >= 2 && (trimStart > 0 || trimEnd > 0)) {
        leg = slicePolyline(leg, trimStart, legLength - trimEnd);
      }
      const last = full[full.length - 1];
      const fresh = last && leg[0] && vertexKey(last) === vertexKey(leg[0]) ? leg.slice(1) : leg;
      full = full.concat(fresh);
      if (offCentre(i + 1)) full.push(gates[i + 1]);
    }
    if (full.length < 2) return null;

    if (!OsmWaterwayPathProvider.withinTotalDetour(gates, full)) return null;

    return full.length >= 2 ? full : null;
  }
}
