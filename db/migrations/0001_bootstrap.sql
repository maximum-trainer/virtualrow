-- #670 Phase 2: initial migration that proves the migrations tool is wired up.
-- Records the schema version so later migrations can inspect it. Future
-- feature schemas (#37 workouts, #421 telemetry, #417 push state, #477
-- appearance, #650 colour customisation) land in their own numbered files.
CREATE TABLE IF NOT EXISTS _meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO _meta (key, value) VALUES ('schema_version', '1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
