import { describe, it, expect, vi } from 'vitest';
import worker, { type Env } from '../src/worker';

function makeEnv(first: () => Promise<unknown>): Env {
  const prepare = vi.fn(() => ({ first })) as unknown as D1PreparedStatement['bind'];
  const db = {
    prepare: (_sql: string) => ({ first }),
  } as unknown as D1Database;
  void prepare;
  return { DB: db };
}

describe('virtualrow-api worker', () => {
  it('GET /health/db returns { ok: true } when SELECT 1 succeeds', async () => {
    const env = makeEnv(async () => ({ ok: 1 }));
    const res = await worker.fetch(new Request('https://worker/health/db'), env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('GET /health/db returns ok:false when the DB throws', async () => {
    const env = makeEnv(async () => {
      throw new Error('bad things');
    });
    const res = await worker.fetch(new Request('https://worker/health/db'), env);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'bad things' });
  });

  it('GET /health/db returns ok:false when the result is unexpected', async () => {
    const env = makeEnv(async () => ({ ok: 0 }));
    const res = await worker.fetch(new Request('https://worker/health/db'), env);
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'unexpected-result' });
  });

  it('unknown routes return 404', async () => {
    const env = makeEnv(async () => ({ ok: 1 }));
    const res = await worker.fetch(new Request('https://worker/unknown'), env);
    expect(res.status).toBe(404);
  });

  it('non-GET on /health/db returns 404', async () => {
    const env = makeEnv(async () => ({ ok: 1 }));
    const res = await worker.fetch(
      new Request('https://worker/health/db', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(404);
  });
});
