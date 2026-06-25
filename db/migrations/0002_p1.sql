-- 0002_p1.sql — P1 easy pages: projects + goals tables, a generic demo seed
-- (never-blank first run), and the default per-fork settings row.
-- Convention (see migrate.ts): every statement ;-terminated + idempotent; no ; inside string literals.

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  mission    TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  project_id  TEXT,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done','archived')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project_id);

-- Generic demo seed — the recipient edits or deletes freely. No personal data.
INSERT OR IGNORE INTO projects (id, slug, name, mission, status) VALUES
  ('demo-proj-1', 'launch-dashboard', 'Launch my dashboard', 'Get this dashboard set up and make it my own.', 'active'),
  ('demo-proj-2', 'personal-os', 'Build my personal OS', 'Bring goals, projects, and notes into one place.', 'active');

INSERT OR IGNORE INTO goals (id, slug, project_id, title, description, status) VALUES
  ('demo-goal-1', 'customize-pages', 'demo-proj-1', 'Customize my pages', 'Pick the pages I want in Settings, then reorder them.', 'active'),
  ('demo-goal-2', 'add-first-project', 'demo-proj-2', 'Add my first real project', 'Replace the demo content with something real.', 'active'),
  ('demo-goal-3', 'connect-portfolio', 'demo-proj-2', 'Connect my portfolio', 'Wire up holdings when I am ready.', 'paused');

-- Default per-fork config: single settings row. config is JSON TEXT validated +
-- default-filled by the Zod ConfigSchema (migrateConfig) at read time.
INSERT OR IGNORE INTO settings (id, display_name, config, updated_at)
VALUES (1, 'My Dashboard', '{"schemaVersion":1}', strftime('%Y-%m-%dT%H:%M:%SZ','now'));
