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

/** Internal read — returns the FULL config (incl. the real openai_key). Never send
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

/** Client-safe settings view — NEVER leaks openai_key (ISC-39). Used by both the
 * HTTP /settings routes and the MCP get_settings tool. */
export function publicSettings(out: SettingsOut) {
  // Strip every server-side secret from the client view (ISC-39): the optional
  // openai_key is NEVER sent to the browser.
  const { openai_key, ...rest } = out.config;
  return {
    display_name: out.display_name,
    config: { ...rest, openai_key: null },
    pages: out.pages,
    openai_configured: Boolean(openai_key && openai_key.length > 0),
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

// ---- Knowledge Base WRITES + MCP audit (P3 Slice 1, ISC-43/46) ----

export type BlocksDoc = { blocks: unknown[] };

/** Coerce arbitrary input into the stored {blocks:[...]} shape. Accepts a bare
 * array (used as the blocks list) or an object with a `blocks` array; anything
 * else becomes an empty list. Never throws — the BlockRenderer is XSS-safe. */
export function normalizeBlocks(input: unknown): BlocksDoc {
  if (Array.isArray(input)) return { blocks: input };
  if (input && typeof input === "object" && Array.isArray((input as { blocks?: unknown }).blocks)) {
    return { blocks: (input as { blocks: unknown[] }).blocks };
  }
  return { blocks: [] };
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

// Self-defending bounds (Forge audit, low DiI): enforce in the SERVICE so any
// future caller — not just the MCP zod layer — is protected from oversized writes.
const MAX_TITLE_LEN = 200;
const MAX_BLOCKS_BYTES = 256 * 1024;
function assertWritable(title: string, blocksJson: string): void {
  if (title.length > MAX_TITLE_LEN) throw new Error(`title too long (max ${MAX_TITLE_LEN} characters)`);
  if (blocksJson.length > MAX_BLOCKS_BYTES) throw new Error(`blocks too large (max ${MAX_BLOCKS_BYTES} bytes)`);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export type KbWriteResult = { slug: string; title: string; updated_at: string; created: boolean };

/**
 * Create a NEW kb doc AND write exactly one mcp_activity row in ONE atomic D1
 * batch (both commit or neither — so audit-row-count == successful-writes by
 * construction). Throws on slug conflict (no audit row for a no-op) — callers use
 * editKbDoc to change an existing doc.
 */
export async function addKbDoc(
  env: AppEnv,
  input: { slug: string; title: string; blocks?: unknown },
  actor = "mcp-bearer",
): Promise<KbWriteResult> {
  const slug = String(input.slug ?? "").trim().toLowerCase();
  if (!isValidSlug(slug)) throw new Error(`invalid slug "${input.slug}" (use lowercase letters, numbers, hyphens)`);
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("title is required");
  const blocksJson = JSON.stringify(normalizeBlocks(input.blocks));
  assertWritable(title, blocksJson);
  const ts = nowIso();

  const existing = await env.DB.prepare("SELECT slug FROM kb_docs WHERE slug = ?").bind(slug).first();
  if (existing) throw new Error(`a doc with slug "${slug}" already exists; use edit_kb_doc`);

  await env.DB.batch([
    env.DB.prepare("INSERT INTO kb_docs (slug, title, blocks, updated_at) VALUES (?, ?, ?, ?)").bind(
      slug, title, blocksJson, ts,
    ),
    env.DB.prepare("INSERT INTO mcp_activity (tool, target, actor, summary, ts) VALUES (?, ?, ?, ?, ?)").bind(
      "add_kb_doc", slug, actor, `Created KB doc "${title}"`, ts,
    ),
  ]);
  return { slug, title, updated_at: ts, created: true };
}

/**
 * Update an EXISTING kb doc (title and/or blocks) AND write exactly one audit row,
 * atomically. Throws if the slug does not exist (no audit row for a no-op).
 */
export async function editKbDoc(
  env: AppEnv,
  input: { slug: string; title?: string; blocks?: unknown },
  actor = "mcp-bearer",
): Promise<KbWriteResult> {
  const slug = String(input.slug ?? "").trim().toLowerCase();
  const current = await env.DB
    .prepare("SELECT slug, title, blocks FROM kb_docs WHERE slug = ?")
    .bind(slug)
    .first<{ slug: string; title: string; blocks: string }>();
  if (!current) throw new Error(`no doc with slug "${slug}"; use add_kb_doc to create it`);

  const title = input.title !== undefined ? String(input.title).trim() : current.title;
  if (!title) throw new Error("title cannot be empty");
  const blocksJson = input.blocks !== undefined ? JSON.stringify(normalizeBlocks(input.blocks)) : current.blocks;
  assertWritable(title, blocksJson);
  const ts = nowIso();

  await env.DB.batch([
    env.DB.prepare("UPDATE kb_docs SET title = ?, blocks = ?, updated_at = ? WHERE slug = ?").bind(
      title, blocksJson, ts, slug,
    ),
    env.DB.prepare("INSERT INTO mcp_activity (tool, target, actor, summary, ts) VALUES (?, ?, ?, ?, ?)").bind(
      "edit_kb_doc", slug, actor, `Edited KB doc "${title}"`, ts,
    ),
  ]);
  return { slug, title, updated_at: ts, created: false };
}

export type McpActivityRow = {
  id: number; ts: string; tool: string; target: string | null; actor: string; summary: string | null;
};

export async function listMcpActivity(env: AppEnv, limit = 50): Promise<McpActivityRow[]> {
  const sql = getDb(env);
  return sql<McpActivityRow>`
    SELECT id, ts, tool, target, actor, summary FROM mcp_activity ORDER BY id DESC LIMIT ${limit}
  `;
}
