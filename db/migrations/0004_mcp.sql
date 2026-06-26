-- 0004_mcp.sql — P3 Slice 1: MCP guarded-write audit log (ISC-43, ISC-46).
-- Convention (see migrate.ts): every statement ;-terminated + idempotent; no ; inside string literals.
-- One row is written here for EVERY successful MCP write-tool call (add_kb_doc / edit_kb_doc),
-- committed ATOMICALLY in the SAME D1 batch as the data change — so row-count == successful-writes
-- by construction (a failed/declined write inserts neither the doc change nor an audit row).

CREATE TABLE IF NOT EXISTS mcp_activity (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  tool    TEXT NOT NULL,
  target  TEXT,
  actor   TEXT NOT NULL DEFAULT 'mcp-bearer',
  summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_activity_ts ON mcp_activity (ts DESC);
