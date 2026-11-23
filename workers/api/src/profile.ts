import type { Athlete } from './auth';

export const PROFILE_FIELDS = ['appearance', 'colours'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
const MAX_BODY_BYTES = 16 * 1024;

export function isProfileField(name: string): name is ProfileField {
  return (PROFILE_FIELDS as readonly string[]).includes(name);
}

export async function upsertUser(db: D1Database, athlete: Athlete, now: number): Promise<string> {
  const existing = await db
    .prepare('SELECT id FROM users WHERE intervals_icu_id = ?')
    .bind(athlete.id)
    .first<string>('id');
  if (existing) {
    await db
      .prepare('UPDATE users SET display_name = ?, email = ?, updated_at = ? WHERE id = ?')
      .bind(athlete.name, athlete.email, now, existing)
      .run();
    return existing;
  }
  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO users (id, intervals_icu_id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, athlete.id, athlete.name, athlete.email, now, now)
    .run();
  return id;
}

interface Stored {
  value: unknown;
  updatedAt: number | null;
}

async function read(db: D1Database, userId: string, field: ProfileField): Promise<Stored> {
  // Field names come from PROFILE_FIELDS only, so interpolating them is safe.
  const row = await db
    .prepare(`SELECT ${field} AS value, ${field}_updated_at AS updated_at FROM user_profile WHERE user_id = ?`)
    .bind(userId)
    .first<{ value: string | null; updated_at: number | null }>();
  if (!row || row.value == null) return { value: null, updatedAt: null };
  return { value: JSON.parse(row.value), updatedAt: row.updated_at };
}

export async function getField(db: D1Database, userId: string, field: ProfileField): Promise<Response> {
  return Response.json(await read(db, userId, field));
}

export async function putField(
  db: D1Database,
  userId: string,
  field: ProfileField,
  request: Request,
  now: number,
): Promise<Response> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: 'too-large' }, { status: 413 });
  }
  let body: { value?: unknown; updatedAt?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: 'invalid-json' }, { status: 400 });
  }
  if (!('value' in body) || typeof body.updatedAt !== 'number' || !Number.isFinite(body.updatedAt)) {
    return Response.json({ error: 'expected { value, updatedAt }' }, { status: 400 });
  }

  const current = await read(db, userId, field);
  if (current.updatedAt != null && body.updatedAt < current.updatedAt) {
    return Response.json(current, { status: 409 });
  }

  await db
    .prepare(
      `INSERT INTO user_profile (user_id, ${field}, ${field}_updated_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET ${field} = excluded.${field},
         ${field}_updated_at = excluded.${field}_updated_at, updated_at = excluded.updated_at`,
    )
    .bind(userId, JSON.stringify(body.value), body.updatedAt, now)
    .run();
  return Response.json({ value: body.value, updatedAt: body.updatedAt });
}
