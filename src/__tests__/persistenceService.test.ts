import { describe, it, expect } from 'vitest';
import { PersistenceService } from '../lib/services/persistenceService';

/**
 * #670 FR7 — PersistenceService is a shape today, not a real adapter.
 * Follow-up issues (#37, #477, #650) replace these stubs with concrete
 * Cloudflare-D1 / Worker-backed implementations. Until then every method
 * must throw, loudly, if a caller forgets to swap the stub in a test or in
 * services DI — a silent `undefined` would be far worse.
 */
describe('PersistenceService (default stub)', () => {
  const svc = new PersistenceService();

  it('healthcheck throws "not implemented"', async () => {
    await expect(svc.healthcheck()).rejects.toThrow(/not implemented/);
  });

  it('get throws "not implemented"', async () => {
    await expect(svc.get('ns', 'k')).rejects.toThrow(/not implemented/);
  });

  it('set throws "not implemented"', async () => {
    await expect(svc.set('ns', 'k', 1)).rejects.toThrow(/not implemented/);
  });

  it('delete throws "not implemented"', async () => {
    await expect(svc.delete('ns', 'k')).rejects.toThrow(/not implemented/);
  });
});
