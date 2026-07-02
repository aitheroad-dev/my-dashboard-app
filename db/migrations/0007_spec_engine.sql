-- 0007_spec_engine.sql — Spec Engine foundation tables.
-- Additive only: fixed sd_* storage for declared specs, records, projections, and saved plans.
-- Convention (see migrate.ts): every statement ;-terminated + idempotent; no ; inside string literals.

CREATE TABLE IF NOT EXISTS sd_entities (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  singular     TEXT NOT NULL,
  plural       TEXT NOT NULL,
  icon         TEXT,
  spec_version INTEGER NOT NULL,
  position     REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS sd_fields (
  id         TEXT PRIMARY KEY,
  entity_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  label      TEXT NOT NULL,
  type       TEXT NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  required   INTEGER NOT NULL DEFAULT 0,
  position   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(entity_id, key)
);

CREATE INDEX IF NOT EXISTS idx_sd_fields_entity_position ON sd_fields (entity_id, position);

CREATE TABLE IF NOT EXISTS sd_views (
  id        TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  kind      TEXT NOT NULL,
  name      TEXT NOT NULL,
  config    TEXT NOT NULL DEFAULT '{}',
  position  REAL NOT NULL DEFAULT 0,
  UNIQUE(entity_id, key)
);

CREATE INDEX IF NOT EXISTS idx_sd_views_entity_position ON sd_views (entity_id, position);

CREATE TABLE IF NOT EXISTS sd_pages (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  icon       TEXT,
  body       TEXT NOT NULL DEFAULT '[]',
  position   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS sd_records (
  id         TEXT PRIMARY KEY,
  entity_id  TEXT NOT NULL,
  data       TEXT NOT NULL,
  position   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_sd_records_entity_position ON sd_records (entity_id, position);

CREATE TABLE IF NOT EXISTS sd_record_values (
  entity_id  TEXT NOT NULL,
  field_id   TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  value_text TEXT,
  value_num  REAL,
  type       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sd_record_values_text ON sd_record_values (entity_id, field_id, value_text);
CREATE INDEX IF NOT EXISTS idx_sd_record_values_num ON sd_record_values (entity_id, field_id, value_num);
CREATE INDEX IF NOT EXISTS idx_sd_record_values_record ON sd_record_values (record_id);

-- Field-level uniqueness is configured per sd_fields.config JSON. SQLite cannot express
-- that dynamic per-field flag as one clean idempotent filtered UNIQUE index on this shared
-- projection table, so the service enforces unique fields before writing each record.

CREATE TABLE IF NOT EXISTS sd_pending_plans (
  id              TEXT PRIMARY KEY,
  plan_json       TEXT NOT NULL,
  schema_hash     TEXT NOT NULL,
  impact_json     TEXT NOT NULL,
  actor           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at      TEXT NOT NULL,
  applied_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sd_pending_plans_idempotency_key ON sd_pending_plans (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_sd_pending_plans_status ON sd_pending_plans (status);
