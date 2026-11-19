import { describe, it, expect } from 'vitest';
import type { PersistencePort } from '../index';

/**
 * #670 FR7 / AC7 — a plain-object stub must satisfy `PersistencePort` with no
 * `as unknown as` cast. If the port ever accidentally drifts back to
 * referencing `PersistenceService`'s class identity (private fields), this
 * test stops compiling.
 */
describe('PersistencePort', () => {
  it('is structurally satisfiable by a plain-object stub', async () => {
    const store = new Map<string, unknown>();
    const stub: PersistencePort = {
      async healthcheck() {
        return true;
      },
      async get<T>(namespace: string, key: string): Promise<T | null> {
        const v = store.get(`${namespace}:${key}`);
        return (v ?? null) as T | null;
      },
      async set<T>(namespace: string, key: string, value: T): Promise<void> {
        store.set(`${namespace}:${key}`, value);
      },
      async delete(namespace: string, key: string): Promise<void> {
        store.delete(`${namespace}:${key}`);
      },
    };

    await stub.set('sessions', 'u1', { id: 42 });
    await expect(stub.get<{ id: number }>('sessions', 'u1')).resolves.toEqual({ id: 42 });
    await expect(stub.healthcheck()).resolves.toBe(true);
    await stub.delete('sessions', 'u1');
    await expect(stub.get('sessions', 'u1')).resolves.toBeNull();
  });
});
