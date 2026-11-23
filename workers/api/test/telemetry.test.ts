import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createHandler, type Env } from '../src/worker';
import { runRetention, scrub, scrubString } from '../src/telemetry';
import { migratedDb } from './helpers/sqliteD1';

const ORIGIN = 'https://maximum-trainer.github.io';
const DAY = 86_400_000;
const RUN = 'run-0123456789';

let env: Env;
let raw: DatabaseSync;
let clock: number;
let handler: ReturnType<typeof createHandler>;

function post(path: string, body: unknown, ip = '203.0.113.9') {
  return handler.fetch(
    new Request(`https://api.test${path}`, {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'text/plain', 'CF-Connecting-IP': ip, 'User-Agent': 'UA/1' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );
}

const batch = (events: unknown[] = [{ at: 12, kind: 'error', detail: { message: 'boom' } }]) => ({
  schemaVersion: 1,
  runId: RUN,
  build: 'abc123',
  tier: 'medium',
  events,
});

const count = (table: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  const db = migratedDb();
  raw = db.raw;
  env = { DB: db.d1, ALLOWED_ORIGINS: ORIGIN };
  clock = 100 * DAY;
  handler = createHandler({ fetchAthlete: vi.fn(async () => null), now: () => clock });
});

describe('POST /api/telemetry (#421)', () => {
  it('stores a batch anonymously, with no auth, and answers with CORS', async () => {
    const res = await post('/api/telemetry', batch());
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ accepted: 1 });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const run = raw.prepare('SELECT * FROM telemetry_runs').get() as Record<string, unknown>;
    expect(run).toMatchObject({ id: RUN, build: 'abc123', tier: 'medium', user_agent: 'UA/1' });
    const event = raw.prepare('SELECT at_ms, kind, detail FROM telemetry_events').get() as Record<string, unknown>;
    expect(event).toEqual({ at_ms: 12, kind: 'error', detail: '{"message":"boom"}' });
    expect(count('users')).toBe(0);
  });

  it('never stores the client IP', async () => {
    await post('/api/telemetry', batch());
    const dump = JSON.stringify(raw.prepare('SELECT * FROM telemetry_runs').all());
    expect(dump).not.toContain('203.0.113.9');
  });

  it('appends later batches to the same run', async () => {
    await post('/api/telemetry', batch());
    clock += 1_000;
    await post('/api/telemetry', batch([{ at: 50, kind: 'page-hide' }]));
    expect(count('telemetry_runs')).toBe(1);
    expect(count('telemetry_events')).toBe(2);
    expect((raw.prepare('SELECT last_seen FROM telemetry_runs').get() as { last_seen: number }).last_seen).toBe(clock);
  });

  it('scrubs personal data and credentials from event detail', async () => {
    await post('/api/telemetry', batch([
      {
        at: 1,
        kind: 'error',
        detail: { message: 'failed for ada@example.test with Bearer abc.def', url: '/cb?code=XYZ&x=1', accessToken: 'tok' },
      },
    ]));
    const detail = JSON.parse((raw.prepare('SELECT detail FROM telemetry_events').get() as { detail: string }).detail);
    expect(detail).toEqual({
      message: 'failed for [email] with Bearer [token]',
      url: '/cb?code=[redacted]&x=1',
      accessToken: '[redacted]',
    });
  });

  it('400s an invalid envelope', async () => {
    expect((await post('/api/telemetry', '{nope')).status).toBe(400);
    expect((await post('/api/telemetry', { ...batch(), schemaVersion: 2 })).status).toBe(400);
    expect((await post('/api/telemetry', { ...batch(), runId: 'x' })).status).toBe(400);
    expect((await post('/api/telemetry', batch([]))).status).toBe(400);
    expect((await post('/api/telemetry', batch([{ at: 'soon', kind: 'error' }]))).status).toBe(400);
    expect((await post('/api/telemetry', batch([{ at: 1, kind: 'DROP TABLE' }]))).status).toBe(400);
    expect(count('telemetry_events')).toBe(0);
  });

  it('413s a body over 64 KB', async () => {
    const res = await post('/api/telemetry', batch([{ at: 1, kind: 'error', detail: { blob: 'x'.repeat(70_000) } }]));
    expect(res.status).toBe(413);
  });

  it('400s more than 300 events in one batch', async () => {
    const events = Array.from({ length: 301 }, (_, i) => ({ at: i, kind: 'sample' }));
    expect((await post('/api/telemetry', batch(events))).status).toBe(400);
  });

  it('rate-limits one IP to 60 requests a minute without affecting another', async () => {
    for (let i = 0; i < 60; i++) expect((await post('/api/telemetry', batch())).status).toBe(202);
    expect((await post('/api/telemetry', batch())).status).toBe(429);
    expect((await post('/api/telemetry', batch(), '198.51.100.1')).status).toBe(202);
    clock += 60_000;
    expect((await post('/api/telemetry', batch())).status).toBe(202);
  });

  it('405s a GET', async () => {
    const res = await handler.fetch(new Request('https://api.test/api/telemetry'), env);
    expect(res.status).toBe(405);
  });
});

describe('POST /api/problem-reports (#421)', () => {
  it('stores a report with its recent events', async () => {
    const res = await post('/api/problem-reports', {
      schemaVersion: 1,
      runId: RUN,
      description: 'The boat froze, email me at bo@example.test',
      events: [{ at: 3, kind: 'device-lost' }],
    });
    expect(res.status).toBe(201);
    const report = raw.prepare('SELECT run_id, description FROM problem_reports').get() as Record<string, unknown>;
    expect(report).toEqual({ run_id: RUN, description: 'The boat froze, email me at [email]' });
    expect(count('telemetry_events')).toBe(1);
  });

  it('400s a report with no description', async () => {
    const res = await post('/api/problem-reports', { schemaVersion: 1, runId: RUN, description: '  ' });
    expect(res.status).toBe(400);
  });
});

describe('retention (#421)', () => {
  async function seedAt(at: number, runId: string, withReport = false) {
    clock = at;
    await post('/api/telemetry', { ...batch(), runId }, `ip-${runId}`);
    if (withReport) {
      await post('/api/problem-reports', { schemaVersion: 1, runId, description: 'help' }, `ip-${runId}`);
    }
  }

  it('drops events after 90 days, keeps those of a reported run, and drops reports after 365', async () => {
    await seedAt(0, 'old-run-0001');
    await seedAt(0, 'reported-0001', true);
    await seedAt(300 * DAY, 'fresh-run-001');

    await runRetention(env.DB, 300 * DAY);
    const runs = (raw.prepare('SELECT id FROM telemetry_runs ORDER BY id').all() as { id: string }[]).map((r) => r.id);
    expect(runs).toEqual(['fresh-run-001', 'reported-0001']);
    expect(count('problem_reports')).toBe(1);

    await runRetention(env.DB, 400 * DAY);
    expect(count('problem_reports')).toBe(0);
    expect((raw.prepare('SELECT DISTINCT run_id FROM telemetry_events').all() as unknown[]).length).toBe(0);
  });

  it('runs from the scheduled handler', async () => {
    await seedAt(0, 'old-run-0001');
    clock = 200 * DAY;
    await handler.scheduled({} as ScheduledController, env);
    expect(count('telemetry_runs')).toBe(0);
  });
});

describe('scrub', () => {
  it('redacts JWTs, long hex keys and secret-named fields at any depth', () => {
    expect(scrubString('t=eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl')).toBe('t=[jwt]');
    expect(scrubString('key ' + 'a'.repeat(40))).toBe('key [hex]');
    expect(scrub({ a: { b: { password: 'p', ok: 1 } } })).toEqual({ a: { b: { password: '[redacted]', ok: 1 } } });
  });
});
