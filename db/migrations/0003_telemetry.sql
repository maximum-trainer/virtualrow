-- #421: anonymous game telemetry and problem reports, ported to SQLite / D1.
-- No user ids: a run is a client-generated random id per page load. Times are
-- INTEGER epoch ms. Retention is a Worker cron DELETE (no partitions in SQLite).

CREATE TABLE telemetry_runs (
  id TEXT PRIMARY KEY,
  build TEXT,
  user_agent TEXT,
  tier TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX idx_runs_last_seen ON telemetry_runs(last_seen);

CREATE TABLE telemetry_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES telemetry_runs(id) ON DELETE CASCADE,
  at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT CHECK (detail IS NULL OR json_valid(detail)),
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_events_received ON telemetry_events(received_at);
CREATE INDEX idx_events_kind_received ON telemetry_events(kind, received_at);
CREATE INDEX idx_events_run ON telemetry_events(run_id);

CREATE TABLE problem_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES telemetry_runs(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_reports_received ON problem_reports(received_at);
CREATE INDEX idx_reports_run ON problem_reports(run_id);

-- Triage: error groups over the last 7 days, by kind + message.
CREATE VIEW v_error_groups_7d AS
SELECT
  kind,
  json_extract(detail, '$.message') AS message,
  COUNT(*) AS events,
  COUNT(DISTINCT run_id) AS runs,
  MAX(received_at) AS last_seen
FROM telemetry_events
WHERE kind IN ('error', 'unhandled-rejection', 'device-lost', 'shader-error', 'crash')
  AND received_at >= (CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 7 * 86400000)
GROUP BY kind, message
ORDER BY events DESC;

INSERT INTO _meta (key, value) VALUES ('schema_version', '3')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
