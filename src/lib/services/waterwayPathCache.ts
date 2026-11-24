/**
 * #750 VP-27 FR6 — the waterway path found for a rownative course, kept per
 * course id for the same seven days as a route's enrichment and in the same
 * storage. A re-import or a "Refresh geometry" on a course already traced
 * then answers from here and makes no Overpass request.
 *
 * What is kept is the provider's own answer, before the resolver judges it, so
 * a cached path still has to pass the gates exactly as a fresh one does.
 */
import type { Coordinate } from '../types/index';
import type { WaterwayPathOptions, WaterwayPathProvider } from './rownativeGeometry';
import { ROUTE_ENRICHMENT_CACHE_TTL_MS } from './routeEnrichmentService';

const KEY_PREFIX = 'virtualrow:waterway-path:v1:';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

const defaultStorage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
};

const isCoordinate = (c: unknown): c is Coordinate =>
  !!c && Number.isFinite((c as Coordinate).lat) && Number.isFinite((c as Coordinate).lng);

export class WaterwayPathCache {
  readonly #storage: () => Storage | null;
  readonly #now: () => number;

  constructor(storage: () => Storage | null = defaultStorage, now: () => number = Date.now) {
    this.#storage = storage;
    this.#now = now;
  }

  /** The path stored for `courseId`, or null when absent, expired or unreadable. */
  get(courseId: string): Coordinate[] | null {
    try {
      const raw = this.#storage()?.getItem(KEY_PREFIX + courseId);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { savedAt?: number; coordinates?: unknown[] };
      if (typeof parsed.savedAt !== 'number' || this.#now() - parsed.savedAt > ROUTE_ENRICHMENT_CACHE_TTL_MS) return null;
      const coordinates = parsed.coordinates?.filter(isCoordinate) ?? [];
      return coordinates.length >= 2 ? coordinates : null;
    } catch {
      return null;
    }
  }

  set(courseId: string, coordinates: Coordinate[]): void {
    try {
      this.#storage()?.setItem(
        KEY_PREFIX + courseId,
        JSON.stringify({ savedAt: this.#now(), coordinates: coordinates.map(({ lat, lng }) => ({ lat, lng })) }),
      );
    } catch {
      // A full or blocked store only costs the next lookup its shortcut.
    }
  }
}

export const waterwayPathCache = new WaterwayPathCache();

/** `inner`, answering from the cache for `courseId` and filling it on a find. */
export const cachedWaterwayProvider = (
  inner: WaterwayPathProvider,
  courseId: string,
  cache: WaterwayPathCache,
): WaterwayPathProvider => ({
  async findPath(gates: Coordinate[], options?: WaterwayPathOptions) {
    const hit = cache.get(courseId);
    if (hit) return hit;
    const found = await inner.findPath(gates, options);
    if (found && found.length >= 2) cache.set(courseId, found);
    return found;
  },
});
