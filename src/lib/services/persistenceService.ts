/**
 * Server-side persistence service — shape, not yet implementation.
 *
 * #670 FR7. Adapters (localStorage today, Cloudflare D1 via the Worker in
 * `workers/api/` tomorrow) will implement this contract per store. Each
 * existing localStorage store (#37 workouts, #477 appearance, #650
 * customisation, …) ports over by swapping its concrete adapter without a
 * wider refactor, because the call-sites depend on `PersistencePort` in
 * `../ports` rather than on this class.
 *
 * Methods are intentionally namespaced: callers pass a logical store name
 * (`sessions`, `appearance`, …) plus a within-store key. The adapter decides
 * how that maps onto its backing storage — a localStorage key, a D1 row, a
 * KV entry.
 */
export class PersistenceService {
  /** Returns true when the backend is reachable. */
  async healthcheck(): Promise<boolean> {
    throw new Error('PersistenceService.healthcheck: not implemented');
  }

  /** Read a value by namespace + key, or null when absent. */
  async get<T>(_namespace: string, _key: string): Promise<T | null> {
    throw new Error('PersistenceService.get: not implemented');
  }

  /** Write (overwrite) a value by namespace + key. */
  async set<T>(_namespace: string, _key: string, _value: T): Promise<void> {
    throw new Error('PersistenceService.set: not implemented');
  }

  /** Delete a value by namespace + key. No-op when absent. */
  async delete(_namespace: string, _key: string): Promise<void> {
    throw new Error('PersistenceService.delete: not implemented');
  }
}
