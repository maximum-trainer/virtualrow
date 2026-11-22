-- Per-point elevation store for workers/geo-proxy (#762).
-- One row per rounded coordinate. Terrain does not change, so rows never
-- expire; `fetched_at` is there for inspection only.
CREATE TABLE IF NOT EXISTS elevation (
  k TEXT PRIMARY KEY,          -- "srtm30m:<lat>,<lng>", coordinates rounded to 5 dp
  elevation REAL,              -- metres; NULL = the dataset has no value here
  fetched_at INTEGER NOT NULL  -- unix seconds
) WITHOUT ROWID;
