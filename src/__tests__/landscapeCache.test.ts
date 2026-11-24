import { describe, expect, it } from 'vitest';
import {
  LANDSCAPE_CACHE_TTL_MS,
  LandscapeCache,
  createLandscapeCache,
  indexedDbLandscapeStore,
  memoryLandscapeStore,
  recordBytes,
  type LandscapeRecord,
} from '../lib/services/landscapeCache';

const record = (key: string, heights = 10): LandscapeRecord => ({
  key,
  savedAt: 0,
  elevation: {
    spacingM: 90,
    lat0Index: 1,
    lng0Index: 2,
    heights: new Float32Array(heights),
    water: new Float32Array(4),
  },
  landCover: [{ kind: 'wood', shape: 'polygon', points: [[0, 0], [1, 0], [1, 1], [0, 0]] }],
});

describe('LandscapeCache (FR7)', () => {
  it('returns what was stored, stamped with when it was saved and used', async () => {
    let t = 1000;
    const store = memoryLandscapeStore();
    const cache = new LandscapeCache(store, () => t);
    await cache.put(record('a'));
    t = 5000;
    const got = await cache.get('a');
    expect(got?.savedAt).toBe(1000);
    expect(got?.usedAt).toBe(5000);
    expect(got?.bytes).toBe(recordBytes(record('a')));
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('drops a record older than 30 days', async () => {
    let t = 0;
    const store = memoryLandscapeStore();
    const cache = new LandscapeCache(store, () => t);
    await cache.put(record('a'));
    t = LANDSCAPE_CACHE_TTL_MS + 1;
    expect(await cache.get('a')).toBeUndefined();
    expect(await store.all()).toHaveLength(0);
  });

  it('evicts the least recently used records past the size cap', async () => {
    let t = 0;
    const one = recordBytes(record('a', 1000));
    const cache = new LandscapeCache(memoryLandscapeStore(), () => t, LANDSCAPE_CACHE_TTL_MS, one * 2.5);
    await cache.put(record('a', 1000));
    t = 1;
    await cache.put(record('b', 1000));
    t = 2;
    await cache.get('a'); // a is now the more recent
    t = 3;
    await cache.put(record('c', 1000));
    expect(await cache.get('a')).toBeDefined();
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('c')).toBeDefined();
  });

  it('does not store a record larger than the whole cap', async () => {
    const store = memoryLandscapeStore();
    const cache = new LandscapeCache(store, () => 0, LANDSCAPE_CACHE_TTL_MS, 100);
    await cache.put(record('big', 1000));
    expect(await store.all()).toHaveLength(0);
  });

  it('counts a record without an elevation layer by its JSON alone', () => {
    const rest: LandscapeRecord = { ...record('x'), elevation: undefined };
    expect(recordBytes(rest)).toBeGreaterThan(0);
    expect(recordBytes(record('x', 1000))).toBeGreaterThan(recordBytes(rest) + 4000);
  });
});

/** Just enough of IndexedDB for the adapter: one store, keyPath 'key'. */
const fakeIndexedDb = (failOpen = false) => {
  const rows = new Map<string, unknown>();
  let created = false;
  const request = <T>(produce: () => T) => {
    const req: { result?: T; onsuccess?: () => void } = {};
    queueMicrotask(() => {
      req.result = produce();
      req.onsuccess?.();
    });
    return req;
  };
  const objectStore = {
    get: (key: string) => request(() => rows.get(key)),
    put: (value: { key: string }) => request(() => rows.set(value.key, value) && value.key),
    delete: (key: string) => request(() => rows.delete(key) && undefined),
    getAll: () => request(() => [...rows.values()]),
  };
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore: () => {
      created = true;
    },
    transaction: () => ({ objectStore: () => objectStore }),
  };
  let opens = 0;
  const factory = {
    open: () => {
      opens += 1;
      const req: { result?: unknown; error?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => {
        if (failOpen) {
          req.error = new Error('denied');
          req.onerror?.();
          return;
        }
        req.result = db;
        req.onupgradeneeded?.();
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory: factory as unknown as IDBFactory, rows, opens: () => opens };
};

describe('indexedDbLandscapeStore', () => {
  it('is null where the browser has no IndexedDB, as in jsdom', () => {
    expect(indexedDbLandscapeStore(undefined)).toBeNull();
    expect(createLandscapeCache()).toBeNull();
  });

  it('puts, gets, lists and deletes records, opening the database once', async () => {
    const fake = fakeIndexedDb();
    const store = indexedDbLandscapeStore(fake.factory)!;
    await store.put(record('a'));
    await store.put(record('b'));
    expect((await store.get('a'))?.key).toBe('a');
    expect((await store.all()).map((r) => r.key)).toEqual(['a', 'b']);
    await store.delete('a');
    expect(await store.get('a')).toBeUndefined();
    expect(fake.opens()).toBe(1);
  });

  it('rejects when the database cannot be opened, which the service treats as no cache', async () => {
    const store = indexedDbLandscapeStore(fakeIndexedDb(true).factory)!;
    await expect(store.get('a')).rejects.toThrow('denied');
  });

  it('rejects a failed request', async () => {
    const settleFail = indexedDbLandscapeStore({
      open: () => {
        const req: { result?: unknown; onsuccess?: () => void; onupgradeneeded?: () => void } = {};
        queueMicrotask(() => {
          req.result = {
            objectStoreNames: { contains: () => true },
            transaction: () => ({
              objectStore: () => ({
                get: () => {
                  const r: { error?: unknown; onerror?: () => void } = {};
                  queueMicrotask(() => {
                    r.error = new Error('read failed');
                    r.onerror?.();
                  });
                  return r;
                },
              }),
            }),
          };
          req.onsuccess?.();
        });
        return req;
      },
    } as unknown as IDBFactory)!;
    await expect(settleFail.get('a')).rejects.toThrow('read failed');
  });
});
