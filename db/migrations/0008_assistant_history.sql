-- 0008: Assistant conversation history.
-- Persists the built-in Assistant chat so it survives closing the tab.
-- Single-owner per fork (all rows belong to the CF-Access owner — no owner_id).
-- conversation_id groups a thread; the UI ships single-thread (resume latest +
-- New chat) but the column makes multi-thread a later addition, not a rebuild.
CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_conv ON assistant_messages (conversation_id, created_at);
