-- #37: core schema, ported from the PostgreSQL design to SQLite / D1.
-- IDs are app-generated UUID strings; timestamps are INTEGER epoch ms;
-- JSON columns are TEXT checked with json_valid(). D1 enforces foreign keys.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  intervals_icu_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per user for cross-device preferences (#477 appearance, #650 colours).
CREATE TABLE user_profile (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  appearance TEXT CHECK (appearance IS NULL OR json_valid(appearance)),
  colours TEXT CHECK (colours IS NULL OR json_valid(colours)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  location TEXT,
  distance_km REAL,
  difficulty TEXT,
  coordinates TEXT NOT NULL CHECK (json_valid(coordinates)),
  tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  source TEXT NOT NULL CHECK (source IN ('builtin', 'gpx', 'kml', 'rownative')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_routes_user ON routes(user_id);

CREATE TABLE user_routes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  is_favourite INTEGER NOT NULL DEFAULT 0 CHECK (is_favourite IN (0, 1)),
  personal_best_time_s REAL,
  personal_best_pace REAL,
  PRIMARY KEY (user_id, route_id)
);

CREATE TABLE workout_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route_id TEXT REFERENCES routes(id) ON DELETE SET NULL,
  route_name TEXT,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  duration_s REAL,
  distance_m REAL,
  avg_pace REAL,
  calories REAL,
  hr_avg REAL,
  hr_max REAL,
  structured_workout_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user_start ON workout_sessions(user_id, start_time DESC);

CREATE TABLE splits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
  distance_m REAL,
  time_s REAL,
  pace REAL,
  power_w REAL,
  heart_rate REAL,
  timestamp INTEGER
);
CREATE INDEX idx_splits_session ON splits(session_id);

INSERT INTO _meta (key, value) VALUES ('schema_version', '2')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
