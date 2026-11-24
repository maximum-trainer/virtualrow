/**
 * #762 VP-34 FR7 — the landscape cache: one record per simplified course, in
 * IndexedDB, kept 30 days and capped at 20 MB, least recently used out
 * first. A second row on the same water asks the network nothing; a partly
 * fetched elevation grid is stored as it stands and resumed (FR3d).
 */
import type { BuiltForm, LandCoverFeature } from './landscapeService';

export const LANDSCAPE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LANDSCAPE_CACHE_MAX_BYTES = 20 * 1024 * 1024;
const DB_NAME = 'virtualrow-landscape';
const STORE = 'landscapes';

/** Absolute DEM heights on the lattice (NaN = not fetched), and at the water samples. */
export interface CachedElevation {
  spacingM: number;
  lat0Index: number;
  lng0Index: number;
  heights: Float32Array;
  water: Float32Array;
}

export interface LandscapeRecord {
  key: string;
  savedAt: number;
  usedAt?: number;
  bytes?: number;
  elevation?: CachedElevation;
  landCover?: LandCoverFeature[];
  built?: BuiltForm;
}

/** The storage the cache sits on: IndexedDB in the browser, a Map in tests. */
export interface LandscapeStore {
  get(key: string): Promise<LandscapeRecord | undefined>;
  put(record: LandscapeRecord): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Promise<LandscapeRecord[]>;
}

/** Approximate stored size: the height arrays' bytes plus the rest as JSON. */
export const recordBytes = (record: LandscapeRecord): number => {
  const { elevation, ...rest } = record;
  const arrays = elevation ? elevation.heights.byteLength + elevation.water.byteLength + 64 : 0;
  return arrays + JSON.stringify({ ...rest, bytes: 0, usedAt: 0 }).length * 2;
};

export class LandscapeCache {
  private readonly store: LandscapeStore;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;

  constructor(
    store: LandscapeStore,
    now: () => number = () => Date.now(),
    ttlMs = LANDSCAPE_CACHE_TTL_MS,
    maxBytes = LANDSCAPE_CACHE_MAX_BYTES,
  ) {
    this.store = store;
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
  }

  /** The record, or undefined when absent or older than 30 days (then dropped). */
  async get(key: string): Promise<LandscapeRecord | undefined> {
    const record = await this.store.get(key);
    if (!record) return undefined;
    if (this.now() - record.savedAt > this.ttlMs) {
      await this.store.delete(key);
      return undefined;
    }
    record.usedAt = this.now();
    await this.store.put(record);
    return record;
  }

  /** Stores the record (stamped now), then evicts the least recently used past the cap. */
  async put(record: LandscapeRecord): Promise<void> {
    const bytes = recordBytes(record);
    if (bytes > this.maxBytes) return;
    const now = this.now();
    await this.store.put({ ...record, bytes, savedAt: now, usedAt: now });
    const all = await this.store.all();
    let total = all.reduce((sum, r) => sum + (r.bytes ?? recordBytes(r)), 0);
    const oldestFirst = all
      .filter((r) => r.key !== record.key)
      .sort((a, b) => (a.usedAt ?? a.savedAt) - (b.usedAt ?? b.savedAt));
    for (const victim of oldestFirst) {
      if (total <= this.maxBytes) break;
      await this.store.delete(victim.key);
      total -= victim.bytes ?? recordBytes(victim);
    }
  }
}

export const memoryLandscapeStore = (): LandscapeStore => {
  const map = new Map<string, LandscapeRecord>();
  return {
    get: async (key) => map.get(key),
    put: async (record) => {
      map.set(record.key, record);
    },
    delete: async (key) => {
      map.delete(key);
    },
    all: async () => [...map.values()],
  };
};

const settle = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** IndexedDB, opened on first use; null where the browser has none. */
export const indexedDbLandscapeStore = (factory: IDBFactory | undefined = globalThis.indexedDB): LandscapeStore | null => {
  if (!factory) return null;
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return db;
  };
  const run = async <T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const database = await open();
    return settle(act(database.transaction(STORE, mode).objectStore(STORE)));
  };
  return {
    get: (key) => run('readonly', (s) => s.get(key) as IDBRequest<LandscapeRecord | undefined>),
    put: async (record) => {
      await run('readwrite', (s) => s.put(record));
    },
    delete: async (key) => {
      await run('readwrite', (s) => s.delete(key));
    },
    all: () => run('readonly', (s) => s.getAll() as IDBRequest<LandscapeRecord[]>),
  };
};

/** The app's cache, or null where there is no IndexedDB (SSR, old browsers). */
export const createLandscapeCache = (): LandscapeCache | null => {
  const store = indexedDbLandscapeStore();
  return store ? new LandscapeCache(store) : null;
};
