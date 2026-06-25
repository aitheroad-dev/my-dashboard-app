import type { AppEnv } from "../lib/env";
import { getDb } from "../lib/db";
import {
  migrateConfig,
  mergeConfig,
  resolvePages,
  type Config,
} from "../lib/config";

/**
 * Shared service layer (ISC-45). The single home for all data access — both the
 * Hono `/api/*` HTTP handlers and the MCP tools call THESE functions, never each
 * other over internal HTTP. One query path, one set of invariants.
 */

export function clampLimit(raw: string | null, max = 1000): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(n, max);
}

// ---- Projects ----

export type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  mission: string | null;
  status: string;
  goal_count: number;
  created_at: string;
  updated_at: string;
};

export async function listProjects(env: AppEnv, limit = 500): Promise<ProjectRow[]> {
  const sql = getDb(env);
  return sql<ProjectRow>`
    SELECT
      p.id, p.slug, p.name, p.mission, p.status,
      (SELECT COUNT(*) FROM goals g WHERE g.project_id = p.id) AS goal_count,
      p.created_at, p.updated_at
    FROM projects p
    ORDER BY p.created_at DESC
    LIMIT ${limit}
  `;
}

// ---- Goals ----

export type GoalRow = {
  id: string;
  slug: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export async function listGoals(env: AppEnv, limit = 500): Promise<GoalRow[]> {
  const sql = getDb(env);
  return sql<GoalRow>`
    SELECT
      g.id, g.slug, g.project_id,
      p.name AS project_name,
      g.title, g.description, g.status,
      g.created_at, g.updated_at
    FROM goals g
    LEFT JOIN projects p ON p.id = g.project_id
    ORDER BY g.created_at DESC
    LIMIT ${limit}
  `;
}

// ---- Portfolio (ships empty — a fork carries no personal holdings) ----

export function getPortfolio() {
  return {
    base: "EUR",
    as_of: null,
    fx: { EUR: 1 },
    total_base: 0,
    total_usd: 0,
    positions: 0,
    holdings: [] as unknown[],
    by_currency: [] as unknown[],
    by_cluster: [] as unknown[],
    configured: false,
  };
}

// ---- Settings ----

export type SettingsOut = { display_name: string; config: Config; pages: string[] };

type SettingsRow = { display_name: string | null; config: string | null };

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** Internal read — returns the FULL config (incl. the real tools_key). Never send
 * this straight to a client; use publicSettings() for any client/MCP response. */
export async function readSettings(env: AppEnv): Promise<SettingsOut> {
  const sql = getDb(env);
  const rows = await sql<SettingsRow>`SELECT display_name, config FROM settings WHERE id = 1`;
  const raw = rows[0]?.config ? safeParse(rows[0].config) : {};
  const config = migrateConfig(raw);
  const display_name = rows[0]?.display_name ?? config.display_name;
  return { display_name, config, pages: resolvePages(config) };
}

export async function writeSettings(env: AppEnv, patch: unknown): Promise<SettingsOut> {
  const current = await readSettings(env);
  const next = mergeConfig(current.config, patch);
  const sql = getDb(env);
  await sql`
    INSERT INTO settings (id, display_name, config, updated_at)
    VALUES (1, ${next.display_name}, ${JSON.stringify(next)}, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT (id) DO UPDATE
      SET display_name = ${next.display_name},
          config = ${JSON.stringify(next)},
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
  `;
  return { display_name: next.display_name, config: next, pages: resolvePages(next) };
}

/** Client-safe settings view — NEVER leaks tools_key (ISC-39). Used by both the
 * HTTP /settings routes and the MCP get_settings tool. */
export function publicSettings(out: SettingsOut) {
  const { tools_key, ...rest } = out.config;
  return {
    display_name: out.display_name,
    config: { ...rest, tools_key: null },
    pages: out.pages,
    tools_configured: Boolean(tools_key && tools_key.length > 0),
  };
}

// ---- Knowledge Base ----

export type KbIndexRow = { slug: string; title: string; updated_at: string };
export type KbDoc = { slug: string; title: string; blocks: unknown; updated_at: string };

export async function listKbDocs(env: AppEnv, limit = 500): Promise<KbIndexRow[]> {
  const sql = getDb(env);
  return sql<KbIndexRow>`
    SELECT slug, title, updated_at FROM kb_docs ORDER BY title ASC LIMIT ${limit}
  `;
}

export async function getKbDoc(env: AppEnv, slug: string): Promise<KbDoc | null> {
  const sql = getDb(env);
  const rows = await sql<{ slug: string; title: string; blocks: string; updated_at: string }>`
    SELECT slug, title, blocks, updated_at FROM kb_docs WHERE slug = ${slug} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  let blocks: unknown;
  try {
    blocks = JSON.parse(row.blocks);
  } catch {
    blocks = { blocks: [] };
  }
  return { slug: row.slug, title: row.title, blocks, updated_at: row.updated_at };
}
