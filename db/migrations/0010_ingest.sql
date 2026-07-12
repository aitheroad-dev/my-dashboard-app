-- 0010: W3 ingest spine. Streams are DECLARED per fork and bound to a spec entity —
-- the spec engine IS the schema registry. Per-stream secrets stored as SHA-256 hashes.
-- ingest_events is the replay-safe idempotency ledger AND the per-event audit trail.
-- Dead letters make bad payloads visible instead of silently dropped.

CREATE TABLE IF NOT EXISTS ingest_streams (
  key TEXT PRIMARY KEY,
  entity_key TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_event_at TEXT
);

CREATE TABLE IF NOT EXISTS ingest_events (
  stream_key TEXT NOT NULL,
  event_uid TEXT NOT NULL,
  record_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (stream_key, event_uid)
);

CREATE TABLE IF NOT EXISTS ingest_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_key TEXT NOT NULL,
  event_uid TEXT,
  payload TEXT NOT NULL,
  error TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingest_dlq_stream ON ingest_dead_letters (stream_key, received_at DESC);
