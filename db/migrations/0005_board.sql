-- 0005_board.sql — Retire projects/goals; introduce the personal Kanban board.
-- The board is the fork's task tracker: cards move across To Do / In Progress / Done.
-- Convention (see migrate.ts): every statement ;-terminated + idempotent; no ; inside string literals.

CREATE TABLE IF NOT EXISTS cards (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  notes      TEXT,
  status     TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done')),
  position   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status, position);

-- Generic demo seed — the recipient edits, moves, or deletes freely. No personal data.
INSERT OR IGNORE INTO cards (id, title, notes, status, position) VALUES
  ('demo-card-1', 'Make this dashboard my own', 'Rename it and pick your pages in Settings.', 'todo', 1000),
  ('demo-card-2', 'Add a few real tasks', 'Type what you need to do, then drag cards across as they move.', 'todo', 2000),
  ('demo-card-3', 'Try the Assistant', 'Ask it to add a card or move one to Done for you.', 'in_progress', 1000),
  ('demo-card-4', 'Explore the Tools page', 'Generate an image, transcribe audio, or read text with OCR.', 'done', 1000);

-- Refresh the starter KB copy so nothing references the retired projects/goals.
UPDATE kb_docs SET blocks = '{"blocks":[{"type":"hero","title":"Welcome to your dashboard","subtitle":"A quick tour of what you can do here."},{"type":"paragraph","text":"This dashboard is yours. Your data lives in your own database, isolated from everyone else."},{"type":"callout","variant":"info","title":"Tip","text":"Open Settings to rename the dashboard, switch theme, and choose which pages appear."},{"type":"list","items":["Organize what you need to do on the Board","Use the built-in tools — image, speech, and OCR","Keep notes here in the knowledge base"]},{"type":"steps","items":[{"title":"Make it yours","text":"Set a display name and theme in Settings."},{"title":"Add real tasks","text":"Replace the demo cards on the Board with your own, and drag them across as they move."}]}]}' WHERE slug = 'welcome';

UPDATE kb_docs SET blocks = replace(blocks, '["Projects","The things you are building"]', '["Board","Your to-do, in-progress, and done tasks"]') WHERE slug = 'blocks-reference';

-- Retire the projects/goals model — replaced by the board. Data-only removal;
-- KB docs + gallery media live in separate stores and are untouched.
DROP TABLE IF EXISTS goals;
DROP TABLE IF EXISTS projects;
