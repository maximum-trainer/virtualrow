// Durable per-point elevation store on Cloudflare D1 (#762).
//
// The edge cache (`caches.default`) remembers whole requests, per data
// centre, and may evict at any time. This remembers every *point* ever
// fetched, globally and for good, so a later request that groups or orders
// the same points differently, or overlaps another route on the same water,
// costs nothing upstream. That matters because the public upstream allows
// 1,000 calls a day in total.

import type { PointStore } from './proxy';

/** The slice of D1's API used here; `D1Database` satisfies it. */
export interface D1Like {
  prepare(sql: string): { bind(...values: unknown[]): D1Statement };
  batch(statements: D1Statement[]): Promise<unknown>;
}
interface D1Statement {
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}

const DATASET = 'srtm30m';
/** D1 allows at most 100 bound parameters per statement. */
const MAX_PARAMS = 100;

const keyOf = (point: string): string => `${DATASET}:${point}`;

export const d1PointStore = (
  db: D1Like,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): PointStore => ({
  async get(points) {
    const out = new Map<string, number | null>();
    for (let i = 0; i < points.length; i += MAX_PARAMS) {
      const chunk = points.slice(i, i + MAX_PARAMS);
      const marks = chunk.map(() => '?').join(',');
      const { results } = await db
        .prepare(`SELECT k, elevation FROM elevation WHERE k IN (${marks})`)
        .bind(...chunk.map(keyOf))
        .all<{ k: string; elevation: number | null }>();
      for (const row of results ?? []) out.set(row.k.slice(DATASET.length + 1), row.elevation);
    }
    return out;
  },

  async put(entries) {
    if (entries.length === 0) return;
    const now = nowSeconds();
    const insert = db.prepare(
      'INSERT INTO elevation (k, elevation, fetched_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(k) DO UPDATE SET elevation = excluded.elevation, fetched_at = excluded.fetched_at',
    );
    // One batch = one round trip and one transaction.
    await db.batch(entries.map(([point, elevation]) => insert.bind(keyOf(point), elevation, now)));
  },
});
