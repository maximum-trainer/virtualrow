/**
 * #752 FR3 — one Overpass water query per area.
 *
 * Importing a rownative course walks its waterways (`osmWaterwayPathProvider`)
 * and rowing it enriches the route (`routeEnrichmentService`). Each used to
 * send its own water query for the same few square kilometres, about 30 s
 * apiece on the public server. Both now send the same query, the enrichment's
 * water query (#741 FR4a), which holds everything either reads, and keep the
 * answer here by the box it was asked for. A later lookup inside a box already
 * fetched reads from here instead.
 *
 * In memory only: the import and the first row of a course happen in one
 * visit, and both services keep their own results in storage for longer.
 */

/** A latitude/longitude box, in degrees. */
export interface WaterBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

/** Natural values that are water, or land inside it: what shore detection reads. */
export const WATER_NATURAL_VALUES = '^(water|bay|strait|coastline|bare_rock|shoal)$';

/** Island relations with more members than this are landmasses, left to the coastline (#493). */
export const ISLAND_RELATION_MAX_MEMBERS = 500;

const bboxString = (box: WaterBox) => `${box.minLat},${box.minLng},${box.maxLat},${box.maxLng}`;

/**
 * #741 FR4 (a) — the water query: water areas, waterways, the coast, islands
 * and piers. A superset of what the waterway walk asks for (waterway lines,
 * `natural=water` and `waterway=riverbank` areas), which filters it back down.
 */
export const buildWaterQueryForBox = (box: WaterBox, timeoutSeconds = 15): string => {
  const wide = bboxString(box);
  return `
[out:json][timeout:${timeoutSeconds}];
(
  way["natural"~"${WATER_NATURAL_VALUES}"](${wide});
  relation["natural"~"${WATER_NATURAL_VALUES}"](${wide});
  way["waterway"](${wide});
  relation["waterway"](${wide});
  // Reservoirs, islands and piers for the water/land mask (#493).
  way["landuse"~"^(reservoir|basin)$"](${wide});
  way["place"~"^(island|islet)$"](${wide});
  // Capped by size: on a coast the landmass itself (Great Britain: 5,727 members) is a
  // place=island relation, and the coastline already says where its land is.
  relation["place"~"^(island|islet)$"](${wide})(if:count_members() < ${ISLAND_RELATION_MAX_MEMBERS});
  // Islets mapped only as a point, drawn as a disc (D17 c).
  node["place"~"^(island|islet)$"](${wide});
  way["man_made"~"^(pier|breakwater|groyne)$"](${wide});
);
out geom qt;
`;
};

/** Whether `outer` holds all of `inner`. */
export const boxContains = (outer: WaterBox, inner: WaterBox): boolean =>
  outer.minLat <= inner.minLat
  && outer.minLng <= inner.minLng
  && outer.maxLat >= inner.maxLat
  && outer.maxLng >= inner.maxLng;

/** How many areas are kept: a session imports a handful of courses at most. */
const DEFAULT_CAPACITY = 6;

export class OverpassWaterCache {
  readonly #capacity: number;
  #entries: { box: WaterBox; elements: readonly unknown[] }[] = [];

  constructor(capacity = DEFAULT_CAPACITY) {
    this.#capacity = capacity;
  }

  /** The water elements of a fetched box holding all of `box`, or null. */
  covering(box: WaterBox): readonly unknown[] | null {
    return this.#entries.find((entry) => boxContains(entry.box, box))?.elements ?? null;
  }

  /** Keep one answer of the water query, for the box it was asked for. */
  store(box: WaterBox, elements: readonly unknown[]): void {
    this.#entries = [{ box, elements }, ...this.#entries].slice(0, this.#capacity);
  }
}

/** The cache the app's own services share. Tests build their own. */
export const overpassWaterCache = new OverpassWaterCache();
