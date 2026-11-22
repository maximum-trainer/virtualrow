import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { UPSTREAM_BASE, handle, type Deps, type PointStore } from '../src/proxy';
import { d1PointStore, type D1Like } from '../src/store';

const ORIGIN = 'https://maximum-trainer.github.io';
const get = (locations: string) =>
  new Request(`https://geo.example.workers.dev/v1/srtm30m?locations=${encodeURIComponent(locations)}`, {
    headers: { Origin: ORIGIN },
  });

/** Upstream fake: elevation = lat * 100 + lng, or null where lat is 0. */
const elevationOf = (lat: number, lng: number): number | null => (lat === 0 ? null : lat * 100 + lng);
const makeUpstream = () =>
  vi.fn(async (url: string) => {
    const locations = decodeURIComponent(url.split('locations=')[1]!);
    return Response.json({
      status: 'OK',
      results: locations.split('|').map((p) => {
        const [lat, lng] = p.split(',').map(Number) as [number, number];
        return { elevation: elevationOf(lat, lng), location: { lat, lng }, dataset: 'srtm30m' };
      }),
    });
  });

const memoryStore = () => {
  const rows = new Map<string, number | null>();
  const store: PointStore = {
    get: vi.fn(async (points) => {
      const out = new Map<string, number | null>();
      for (const p of points) if (rows.has(p)) out.set(p, rows.get(p)!);
      return out;
    }),
    put: vi.fn(async (entries) => { for (const [p, e] of entries) rows.set(p, e); }),
  };
  return { store, rows };
};

const makeDeps = (store: PointStore | undefined, fetchImpl = makeUpstream()) => {
  const edge = new Map<string, Response>();
  const deps: Deps = {
    fetch: fetchImpl as unknown as Deps['fetch'],
    cache: {
      match: async (key) => edge.get(key)?.clone(),
      put: async (key, res) => { edge.set(key, res.clone()); },
    },
    store,
  };
  return { deps, fetchImpl, edge };
};

const elevations = async (res: Response) =>
  ((await res.json()) as { results: { elevation: number | null }[] }).results.map((r) => r.elevation);

describe('geo-proxy: per-point store', () => {
  it('remembers each point, so a different request for known points makes no upstream call', async () => {
    const { store } = memoryStore();
    const first = makeDeps(store);
    await handle(get('52.1,0.1|52.2,0.2|52.3,0.3'), first.deps);
    expect(first.fetchImpl).toHaveBeenCalledTimes(1);

    // A fresh edge (another data centre), different grouping and order.
    const second = makeDeps(store);
    const res = await handle(get('52.3,0.3|52.1,0.1'), second.deps);
    expect(second.fetchImpl).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Geo-Proxy-Cache')).toBe('STORE');
    expect(await elevations(res)).toEqual([5230.3, 5210.1]);
  });

  it('asks upstream only for the points it does not have', async () => {
    const { store } = memoryStore();
    await handle(get('52.1,0.1|52.2,0.2'), makeDeps(store).deps);

    const next = makeDeps(store);
    const res = await handle(get('52.1,0.1|52.9,0.9|52.2,0.2|52.8,0.8'), next.deps);
    expect(next.fetchImpl).toHaveBeenCalledTimes(1);
    expect(next.fetchImpl.mock.calls[0]![0]).toBe(
      `${UPSTREAM_BASE}/v1/srtm30m?locations=${encodeURIComponent('52.9,0.9|52.8,0.8')}`,
    );
    expect(res.headers.get('X-Geo-Proxy-Cache')).toBe('PARTIAL');
    // Answer is in the order asked, whatever came from where.
    expect(await elevations(res)).toEqual([5210.1, 5290.9, 5220.2, 5280.8]);
  });

  it('asks upstream once for a point repeated in the request', async () => {
    const { deps, fetchImpl } = makeDeps(memoryStore().store);
    const res = await handle(get('52.1,0.1|52.1,0.1|52.2,0.2'), deps);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      `${UPSTREAM_BASE}/v1/srtm30m?locations=${encodeURIComponent('52.1,0.1|52.2,0.2')}`,
    );
    expect(await elevations(res)).toEqual([5210.1, 5210.1, 5220.2]);
  });

  it('remembers "no data here" as well, so the sea is not asked for again', async () => {
    const { store, rows } = memoryStore();
    await handle(get('0,10'), makeDeps(store).deps);
    expect(rows.get('0,10')).toBeNull();
    const again = makeDeps(store);
    const res = await handle(get('0,10'), again.deps);
    expect(again.fetchImpl).not.toHaveBeenCalled();
    expect(await elevations(res)).toEqual([null]);
  });

  it('answers in OpenTopoData’s shape whichever layer served it', async () => {
    const { store } = memoryStore();
    const miss = await (await handle(get('52.1,0.1'), makeDeps(store).deps)).json();
    const hit = await (await handle(get('52.1,0.1'), makeDeps(store).deps)).json();
    const expected = {
      status: 'OK',
      results: [{ elevation: 5210.1, location: { lat: 52.1, lng: 0.1 }, dataset: 'srtm30m' }],
    };
    expect(miss).toEqual(expected);
    expect(hit).toEqual(expected);
  });

  it('stores nothing when upstream fails', async () => {
    const { store, rows } = memoryStore();
    const failing = vi.fn(async () => new Response('no', { status: 500 }));
    const res = await handle(get('52.1,0.1'), makeDeps(store, failing as never).deps);
    expect(res.status).toBe(502);
    expect(rows.size).toBe(0);
  });

  it('refuses an upstream answer with the wrong number of results', async () => {
    const { store, rows } = memoryStore();
    const short = vi.fn(async () => Response.json({ status: 'OK', results: [{ elevation: 1 }] }));
    const res = await handle(get('52.1,0.1|52.2,0.2'), makeDeps(store, short as never).deps);
    expect(res.status).toBe(502);
    expect(rows.size).toBe(0);
  });

  it('still answers when the store is broken', async () => {
    const broken: PointStore = {
      get: async () => { throw new Error('D1 down'); },
      put: async () => { throw new Error('D1 down'); },
    };
    const { deps, fetchImpl } = makeDeps(broken);
    const res = await handle(get('52.1,0.1'), deps);
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await elevations(res)).toEqual([5210.1]);
  });

  it('checks the edge cache first and does not touch the store on a hit', async () => {
    const { store } = memoryStore();
    const { deps } = makeDeps(store);
    await handle(get('52.1,0.1'), deps);
    (store.get as ReturnType<typeof vi.fn>).mockClear();
    const res = await handle(get('52.1,0.1'), deps);
    expect(res.headers.get('X-Geo-Proxy-Cache')).toBe('HIT');
    expect(store.get).not.toHaveBeenCalled();
  });
});

/**
 * The D1 adapter, run against real SQLite (what D1 is) with the real
 * migration, through a thin stand-in for D1's prepare / bind / all / batch.
 */
describe('d1PointStore', () => {
  const makeDb = () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/0001_elevation.sql', import.meta.url).pathname, 'utf8'));
    const statements: { sql: string; params: number }[] = [];
    let batches = 0;
    const prepare = (sql: string) => {
      const bound = (args: unknown[]) => ({
        sql,
        args,
        all: async () => {
          statements.push({ sql, params: args.length });
          return { results: sqlite.prepare(sql).all(...(args as never[])) };
        },
        run: async () => {
          statements.push({ sql, params: args.length });
          sqlite.prepare(sql).run(...(args as never[]));
          return {};
        },
      });
      return { bind: (...args: unknown[]) => bound(args) };
    };
    const db: D1Like = {
      prepare: prepare as never,
      batch: async (stmts) => {
        batches++;
        for (const s of stmts) await (s as unknown as { run: () => Promise<unknown> }).run();
        return [];
      },
    };
    return { db, sqlite, statements, batches: () => batches };
  };

  it('round-trips values, including null and zero', async () => {
    const { db } = makeDb();
    const store = d1PointStore(db, () => 1_800_000_000);
    await store.put([['52.1,0.1', 12.5], ['0,10', null], ['51,0', 0]]);
    const got = await store.get(['52.1,0.1', '0,10', '51,0', '9,9']);
    expect(got.get('52.1,0.1')).toBe(12.5);
    expect(got.has('0,10')).toBe(true);
    expect(got.get('0,10')).toBeNull();
    expect(got.get('51,0')).toBe(0);
    expect(got.has('9,9')).toBe(false);
  });

  it('keeps every statement within D1’s 100 bound parameters', async () => {
    const { db, statements } = makeDb();
    const store = d1PointStore(db, () => 1);
    const points = Array.from({ length: 100 }, (_, i) => `52.${String(i).padStart(3, '0')},0.1`);
    await store.put(points.map((p, i) => [p, i]));
    const got = await store.get(points);
    expect(got.size).toBe(100);
    for (const s of statements) expect(s.params).toBeLessThanOrEqual(100);
  });

  it('writes a whole request in one batch', async () => {
    const { db, batches } = makeDb();
    const store = d1PointStore(db, () => 1);
    await store.put(Array.from({ length: 100 }, (_, i) => [`1.${i},2`, i] as [string, number]));
    expect(batches()).toBe(1);
  });

  it('overwrites rather than fails on a point it already has', async () => {
    const { db, sqlite } = makeDb();
    const store = d1PointStore(db, () => 1);
    await store.put([['52.1,0.1', 1]]);
    await store.put([['52.1,0.1', 2]]);
    expect((await store.get(['52.1,0.1'])).get('52.1,0.1')).toBe(2);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM elevation').get()).toEqual({ n: 1 });
  });

  it('does nothing for an empty request', async () => {
    const { db, statements } = makeDb();
    const store = d1PointStore(db, () => 1);
    expect((await store.get([])).size).toBe(0);
    await store.put([]);
    expect(statements.length).toBe(0);
  });
});
