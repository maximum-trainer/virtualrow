import { describe, it, expect, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = join(__dirname, '../../../db/migrations');

function migrate(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return db;
}

describe('db/migrations', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = migrate();
  });

  it('records the latest schema version', () => {
    const row = db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string };
    expect(row.value).toBe('2');
  });

  it('creates the #37 tables and indexes', () => {
    const names = (type: string) =>
      (db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[]).map((r) => r.name);
    expect(names('table')).toEqual(
      expect.arrayContaining(['users', 'user_profile', 'routes', 'user_routes', 'workout_sessions', 'splits']),
    );
    expect(names('index')).toEqual(
      expect.arrayContaining(['idx_routes_user', 'idx_sessions_user_start', 'idx_splits_session']),
    );
  });

  it('cascades a user delete to profile, sessions and splits', () => {
    db.exec(`
      INSERT INTO users (id, intervals_icu_id, created_at, updated_at) VALUES ('u1', 'i1', 0, 0);
      INSERT INTO user_profile (user_id, appearance, updated_at) VALUES ('u1', '{"top":"red"}', 0);
      INSERT INTO workout_sessions (id, user_id, start_time, created_at) VALUES ('s1', 'u1', 0, 0);
      INSERT INTO splits (id, session_id) VALUES ('p1', 's1');
      DELETE FROM users WHERE id = 'u1';
    `);
    for (const table of ['user_profile', 'workout_sessions', 'splits']) {
      expect((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });

  it('rejects a session for an unknown user', () => {
    expect(() =>
      db.exec("INSERT INTO workout_sessions (id, user_id, start_time, created_at) VALUES ('s1', 'nobody', 0, 0)"),
    ).toThrow(/FOREIGN KEY/);
  });

  it('rejects malformed JSON in profile columns', () => {
    db.exec("INSERT INTO users (id, intervals_icu_id, created_at, updated_at) VALUES ('u1', 'i1', 0, 0)");
    expect(() =>
      db.exec("INSERT INTO user_profile (user_id, appearance, updated_at) VALUES ('u1', '{not json', 0)"),
    ).toThrow(/CHECK/);
  });

  it('keeps intervals.icu IDs unique', () => {
    db.exec("INSERT INTO users (id, intervals_icu_id, created_at, updated_at) VALUES ('u1', 'i1', 0, 0)");
    expect(() =>
      db.exec("INSERT INTO users (id, intervals_icu_id, created_at, updated_at) VALUES ('u2', 'i1', 0, 0)"),
    ).toThrow(/UNIQUE/);
  });
});
