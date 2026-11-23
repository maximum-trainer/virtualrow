import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHandler, type Env } from '../src/worker';
import { migratedDb } from './helpers/sqliteD1';
import type { DatabaseSync } from 'node:sqlite';

const ORIGIN = 'https://maximum-trainer.github.io';
const TOKENS: Record<string, { id: string; name: string; email: string }> = {
  'tok-a': { id: '111', name: 'Ada', email: 'ada@example.test' },
  'tok-b': { id: '222', name: 'Bo', email: 'bo@example.test' },
};

let env: Env;
let raw: DatabaseSync;
let fetchAthlete: ReturnType<typeof vi.fn>;
let handler: ReturnType<typeof createHandler>;

function call(path: string, init: RequestInit & { token?: string; origin?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('Origin', init.origin ?? ORIGIN);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  return handler.fetch(new Request(`https://api.test${path}`, { ...init, headers }), env);
}

function put(path: string, token: string, body: unknown) {
  return call(path, {
    method: 'PUT',
    token,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  const db = migratedDb();
  raw = db.raw;
  env = { DB: db.d1, ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173` };
  fetchAthlete = vi.fn(async (token: string) => TOKENS[token] ?? null);
  handler = createHandler({ fetchAthlete, now: () => 1_000 });
});

describe('CORS', () => {
  it('answers a preflight from an allowed origin', async () => {
    const res = await call('/api/profile/appearance', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Headers')).toMatch(/Authorization/);
    expect(res.headers.get('Access-Control-Allow-Methods')).toMatch(/PUT/);
  });

  it('refuses a preflight from any other origin', async () => {
    const res = await call('/api/profile/appearance', { method: 'OPTIONS', origin: 'https://evil.test' });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('adds CORS headers to real responses for allowed origins only', async () => {
    const ok = await call('/api/profile/appearance', { token: 'tok-a' });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const other = await call('/api/profile/appearance', { token: 'tok-a', origin: 'https://evil.test' });
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('auth', () => {
  it('rejects a request with no bearer token', async () => {
    const res = await call('/api/profile/appearance');
    expect(res.status).toBe(401);
  });

  it('rejects a token intervals.icu does not recognise', async () => {
    const res = await call('/api/profile/appearance', { token: 'nope' });
    expect(res.status).toBe(401);
  });

  it('verifies a token once and caches the athlete', async () => {
    await call('/api/profile/appearance', { token: 'tok-a' });
    await call('/api/profile/colours', { token: 'tok-a' });
    expect(fetchAthlete).toHaveBeenCalledTimes(1);
  });

  it('creates the user row on first verified call', async () => {
    await call('/api/profile/appearance', { token: 'tok-a' });
    const row = raw.prepare('SELECT intervals_icu_id, display_name FROM users').get() as Record<string, string>;
    expect(row).toEqual({ intervals_icu_id: '111', display_name: 'Ada' });
  });
});

describe('profile fields', () => {
  it('returns null before anything is stored', async () => {
    const res = await call('/api/profile/appearance', { token: 'tok-a' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ value: null, updatedAt: null });
  });

  it('stores and reads back a value', async () => {
    const value = { top: 'red', hair: 'short' };
    const saved = await put('/api/profile/appearance', 'tok-a', { value, updatedAt: 500 });
    expect(saved.status).toBe(200);
    const res = await call('/api/profile/appearance', { token: 'tok-a' });
    await expect(res.json()).resolves.toEqual({ value, updatedAt: 500 });
  });

  it('keeps appearance and colours independent', async () => {
    await put('/api/profile/appearance', 'tok-a', { value: { top: 'red' }, updatedAt: 1 });
    await put('/api/profile/colours', 'tok-a', { value: { hull: '#fff' }, updatedAt: 2 });
    const a = await (await call('/api/profile/appearance', { token: 'tok-a' })).json();
    const c = await (await call('/api/profile/colours', { token: 'tok-a' })).json();
    expect(a).toEqual({ value: { top: 'red' }, updatedAt: 1 });
    expect(c).toEqual({ value: { hull: '#fff' }, updatedAt: 2 });
  });

  it('rejects an older write and returns the newer stored copy', async () => {
    await put('/api/profile/appearance', 'tok-a', { value: { top: 'new' }, updatedAt: 900 });
    const res = await put('/api/profile/appearance', 'tok-a', { value: { top: 'old' }, updatedAt: 100 });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ value: { top: 'new' }, updatedAt: 900 });
  });

  it('keeps athletes apart', async () => {
    await put('/api/profile/appearance', 'tok-a', { value: { top: 'red' }, updatedAt: 1 });
    const res = await call('/api/profile/appearance', { token: 'tok-b' });
    await expect(res.json()).resolves.toEqual({ value: null, updatedAt: null });
  });

  it('404s an unknown field', async () => {
    const res = await put('/api/profile/password', 'tok-a', { value: 1, updatedAt: 1 });
    expect(res.status).toBe(404);
  });

  it('400s a malformed body', async () => {
    expect((await put('/api/profile/appearance', 'tok-a', '{oops')).status).toBe(400);
    expect((await put('/api/profile/appearance', 'tok-a', { value: 1 })).status).toBe(400);
  });

  it('413s a body over 16 KB', async () => {
    const res = await put('/api/profile/appearance', 'tok-a', { value: 'x'.repeat(17_000), updatedAt: 1 });
    expect(res.status).toBe(413);
  });
});
