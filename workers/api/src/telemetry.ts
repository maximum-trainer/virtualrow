// #421: anonymous telemetry + problem-report ingest. No auth and no user ids:
// a run is the client's random per-page-load id. Bodies are capped, validated,
// scrubbed of anything that looks like personal data or a credential, and
// rate-limited per client IP (the IP itself is never stored).

export const MAX_TELEMETRY_BYTES = 64 * 1024;
export const MAX_EVENTS_PER_BATCH = 300;
export const RATE_LIMIT_PER_MINUTE = 60;
export const EVENT_RETENTION_DAYS = 90;
export const REPORT_RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;

const RUN_ID = /^[A-Za-z0-9-]{8,64}$/;
const KIND = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

interface EventIn {
  at: number;
  kind: string;
  detail?: Record<string, unknown>;
}

// ── Scrubbing ───────────────────────────────────────────────────────────────

const SCRUBBERS: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]'],
  [/([?&](?:access_token|token|code|code_verifier|key|api_key|password|secret)=)[^&#\s]*/gi, '$1[redacted]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[hex]'],
];
const SECRET_KEY = /token|secret|password|authorization|cookie|email|api[-_]?key/i;

export function scrubString(value: string): string {
  let out = value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out;
}

export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value).slice(0, 50)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return null;
}

// ── Rate limiting (per isolate; good enough to blunt a runaway client) ──────

export function createRateLimiter(now: () => number, perMinute = RATE_LIMIT_PER_MINUTE) {
  const windows = new Map<string, { start: number; count: number }>();
  return function allow(key: string): boolean {
    const t = now();
    const w = windows.get(key);
    if (!w || t - w.start >= 60_000) {
      if (windows.size > 10_000) windows.clear();
      windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= perMinute;
  };
}

// ── Parsing ─────────────────────────────────────────────────────────────────

type Parsed<T> = { ok: true; body: T } | { ok: false; response: Response };

async function readJson(request: Request): Promise<Parsed<Record<string, unknown>>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_TELEMETRY_BYTES) {
    return { ok: false, response: Response.json({ error: 'too-large' }, { status: 413 }) };
  }
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === 'object' && !Array.isArray(body)) return { ok: true, body: body as Record<string, unknown> };
  } catch {
    // fall through
  }
  return { ok: false, response: Response.json({ error: 'invalid-json' }, { status: 400 }) };
}

const bad = (error: string) => Response.json({ error }, { status: 400 });
const shortString = (v: unknown, max: number) => (typeof v === 'string' ? scrubString(v).slice(0, max) : null);

function parseEvents(raw: unknown, required: boolean): EventIn[] | string {
  if (raw == null && !required) return [];
  if (!Array.isArray(raw) || (required && raw.length === 0)) return 'expected a non-empty events array';
  if (raw.length > MAX_EVENTS_PER_BATCH) return `at most ${MAX_EVENTS_PER_BATCH} events per batch`;
  const events: EventIn[] = [];
  for (const e of raw as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object') return 'invalid event';
    if (typeof e.at !== 'number' || !Number.isFinite(e.at) || typeof e.kind !== 'string' || !KIND.test(e.kind)) {
      return 'each event needs a numeric at and a kind';
    }
    const detail = e.detail != null && typeof e.detail === 'object' && !Array.isArray(e.detail)
      ? (scrub(e.detail) as Record<string, unknown>)
      : undefined;
    events.push({ at: Math.round(e.at), kind: e.kind, ...(detail ? { detail } : {}) });
  }
  return events;
}

async function upsertRun(db: D1Database, request: Request, body: Record<string, unknown>, runId: string, now: number) {
  const ua = shortString(request.headers.get('User-Agent'), 256);
  await db
    .prepare(
      `INSERT INTO telemetry_runs (id, build, user_agent, tier, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen`,
    )
    .bind(runId, shortString(body.build, 64), ua, shortString(body.tier, 32), now, now)
    .run();
}

function insertEvents(db: D1Database, runId: string, events: EventIn[], now: number): D1PreparedStatement[] {
  const stmt = db.prepare('INSERT INTO telemetry_events (run_id, at_ms, kind, detail, received_at) VALUES (?, ?, ?, ?, ?)');
  return events.map((e) => stmt.bind(runId, e.at, e.kind, e.detail ? JSON.stringify(e.detail) : null, now));
}

// ── Routes ──────────────────────────────────────────────────────────────────

export async function ingestTelemetry(db: D1Database, request: Request, now: number): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;
  if (body.schemaVersion !== 1) return bad('unsupported schemaVersion');
  if (typeof body.runId !== 'string' || !RUN_ID.test(body.runId)) return bad('invalid runId');
  const events = parseEvents(body.events, true);
  if (typeof events === 'string') return bad(events);

  await upsertRun(db, request, body, body.runId, now);
  await db.batch(insertEvents(db, body.runId, events, now));
  return Response.json({ accepted: events.length }, { status: 202 });
}

export async function ingestProblemReport(db: D1Database, request: Request, now: number): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;
  if (body.schemaVersion !== 1) return bad('unsupported schemaVersion');
  if (typeof body.runId !== 'string' || !RUN_ID.test(body.runId)) return bad('invalid runId');
  if (typeof body.description !== 'string' || !body.description.trim()) return bad('description is required');
  const events = parseEvents(body.events, false);
  if (typeof events === 'string') return bad(events);

  const id = crypto.randomUUID();
  await upsertRun(db, request, body, body.runId, now);
  await db.batch([
    ...insertEvents(db, body.runId, events, now),
    db
      .prepare('INSERT INTO problem_reports (id, run_id, description, received_at) VALUES (?, ?, ?, ?)')
      .bind(id, body.runId, scrubString(body.description.trim()).slice(0, 4000), now),
  ]);
  return Response.json({ id }, { status: 201 });
}

/**
 * Daily retention (cron). Events go after 90 days unless their run has a
 * problem report; reports go after 365 days; runs go once nothing refers to
 * them and they are past the event window.
 */
export async function runRetention(db: D1Database, now: number): Promise<void> {
  const eventCutoff = now - EVENT_RETENTION_DAYS * DAY_MS;
  const reportCutoff = now - REPORT_RETENTION_DAYS * DAY_MS;
  await db.batch([
    db.prepare('DELETE FROM problem_reports WHERE received_at < ?').bind(reportCutoff),
    db
      .prepare(
        `DELETE FROM telemetry_events WHERE received_at < ?
         AND run_id NOT IN (SELECT run_id FROM problem_reports WHERE run_id IS NOT NULL)`,
      )
      .bind(eventCutoff),
    db
      .prepare(
        `DELETE FROM telemetry_runs WHERE last_seen < ?
         AND id NOT IN (SELECT run_id FROM problem_reports WHERE run_id IS NOT NULL)
         AND id NOT IN (SELECT run_id FROM telemetry_events)`,
      )
      .bind(eventCutoff),
  ]);
}
