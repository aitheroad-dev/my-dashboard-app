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

// ---- Board (cards) — the personal Kanban; replaces projects/goals ----

export const CARD_STATUSES = ["todo", "in_progress", "done"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];
function isCardStatus(s: unknown): s is CardStatus {
  return typeof s === "string" && (CARD_STATUSES as readonly string[]).includes(s);
}

export type CardRow = {
  id: string;
  title: string;
  notes: string | null;
  status: CardStatus;
  position: number;
  created_at: string;
  updated_at: string;
};

export async function listCards(env: AppEnv, limit = 500): Promise<CardRow[]> {
  const sql = getDb(env);
  return sql<CardRow>`
    SELECT id, title, notes, status, position, created_at, updated_at
    FROM cards
    ORDER BY status ASC, position ASC, created_at ASC
    LIMIT ${limit}
  `;
}

// Self-defending bounds enforced in the SERVICE so every caller (HTTP + MCP) is
// protected — not just a single zod layer at one entry point.
const MAX_CARD_TITLE_LEN = 200;
const MAX_CARD_NOTES_LEN = 2000;
function assertCardWritable(title: string, notes: string | null): void {
  if (!title) throw new Error("title is required");
  if (title.length > MAX_CARD_TITLE_LEN) throw new Error(`title too long (max ${MAX_CARD_TITLE_LEN} characters)`);
  if (notes !== null && notes.length > MAX_CARD_NOTES_LEN)
    throw new Error(`notes too long (max ${MAX_CARD_NOTES_LEN} characters)`);
}

/** Append position = one step past the current max in the target column. */
async function nextPosition(env: AppEnv, status: CardStatus): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), 0) AS maxpos FROM cards WHERE status = ?",
  )
    .bind(status)
    .first<{ maxpos: number }>();
  return (row?.maxpos ?? 0) + 1000;
}

/**
 * Every card write commits the data change + exactly one mcp_activity audit row in
 * ONE atomic D1 batch — same contract as the KB writers (audit-count == successful
 * writes by construction). `actor` distinguishes an owner UI action (email/"owner-ui")
 * from an MCP call ("mcp-bearer").
 */
export async function addCard(
  env: AppEnv,
  input: { title: string; notes?: string | null; status?: string },
  actor = "owner-ui",
): Promise<CardRow> {
  const title = String(input.title ?? "").trim();
  const notes = input.notes == null ? null : String(input.notes).trim() || null;
  const status: CardStatus = isCardStatus(input.status) ? input.status : "todo";
  assertCardWritable(title, notes);
  const id = crypto.randomUUID();
  const position = await nextPosition(env, status);
  const ts = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO cards (id, title, notes, status, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, title, notes, status, position, ts, ts),
    env.DB.prepare("INSERT INTO mcp_activity (tool, target, actor, summary, ts) VALUES (?, ?, ?, ?, ?)").bind(
      "add_card", id, actor, `Added card "${title}" to ${status}`, ts,
    ),
  ]);
  return { id, title, notes, status, position, created_at: ts, updated_at: ts };
}

export async function editCard(
  env: AppEnv,
  input: { id: string; title?: string; notes?: string | null },
  actor = "owner-ui",
): Promise<CardRow> {
  const id = String(input.id ?? "").trim();
  const current = await env.DB.prepare(
    "SELECT id, title, notes, status, position, created_at FROM cards WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; title: string; notes: string | null; status: CardStatus; position: number; created_at: string }>();
  if (!current) throw new Error(`no card with id "${id}"`);
  const title = input.title !== undefined ? String(input.title).trim() : current.title;
  const notes =
    input.notes !== undefined ? (input.notes == null ? null : String(input.notes).trim() || null) : current.notes;
  assertCardWritable(title, notes);
  const ts = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE cards SET title = ?, notes = ?, updated_at = ? WHERE id = ?").bind(title, notes, ts, id),
    env.DB.prepare("INSERT INTO mcp_activity (tool, target, actor, summary, ts) VALUES (?, ?, ?, ?, ?)").bind(
      "edit_card", id, actor, `Edited card "${title}"`, ts,
    ),
  ]);
  return { id, title, notes, status: current.status, position: current.position, created_at: current.created_at, updated_at: ts };
}

export async function moveCard(
  env: AppEnv,
  input: { id: string; status: string; position?: number },
  actor = "owner-ui",
): Promise<CardRow> {
  const id = String(input.id ?? "").trim();
  if (!isCardStatus(input.status))
    throw new Error(`invalid status "${input.status}" (use todo, in_progress, or done)`);
  const status = input.status;
  const current = await env.DB.prepare(
    "SELECT id, title, notes, status, position, created_at FROM cards WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string; title: string; notes: string | null; status: CardStatus; position: number; created_at: string }>();
  if (!current) throw new Error(`no card with id "${id}"`);
  const position =
    typeof input.position === "number" && Number.isFinite(input.position)
      ? input.position
      : await nextPosition(env, status);
  const ts = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE cards SET status = ?, position = ?, updated_at = ? WHERE id = ?").bind(status, position, ts, id),
    env.DB.prepare("INSERT INTO mcp_activity (tool, target, actor, summary, ts) VALUES (?, ?, ?, ?, ?)").bind(
      "move_card", id, actor, `Moved card "${current.title}" to ${status}`, ts,
    ),
  ]);
  return { id, title: current.title, notes: current.notes, status, position, created_at: current.created_at, updated_at: ts };
}

export async function deleteCard(
  env: AppEnv,
  input: { id: string },
  actor = "owner-ui",
): Promise<{ id: string; deleted: boolean }> {
  const id = String(input.id ?? "").trim();
  const current = await env.DB.prepare("SELECT id, title FROM cards WHERE id = ?")
    .bind(id)
    .first<{ id: string; title: string }>();
  if (!current) throw new Error(`no card with id "${id}"`);
  const ts = nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cards WHERE id = ?").bind(id),
    env.DB.prepare("INSERT INTO mcp_activity (tool, target, actor, summary, ts) VALUES (?, ?, ?, ?, ?)").bind(
      "delete_card", id, actor, `Deleted card "${current.title}"`, ts,
    ),
  ]);
  return { id, deleted: true };
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
