import { Hono } from "hono";
import type { AppEnv } from "../lib/env";
import { getDb } from "../lib/db";
import { getViewer, requireViewer } from "../lib/viewer";
import {
  migrateConfig,
  mergeConfig,
  resolvePages,
  type Config,
} from "../lib/config";

/**
 * P1 data routes — mounted at `/api`. Auth via the `getViewer` seam (real CF
 * Access where configured, owner open-dev otherwise). Generic data shapes;
 * portfolio ships EMPTY by design — a fork starts with no holdings and the
 * recipient connects their own. The template carries no personal data.
 */
export const data = new Hono<{ Bindings: AppEnv }>();

function clampLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(n, 1000);
}

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  mission: string | null;
  status: string;
  goal_count: number;
  created_at: string;
  updated_at: string;
};

data.get("/projects", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  const limit = clampLimit(new URL(c.req.url).searchParams.get("limit"));
  const sql = getDb(c.env);
  const rows = await sql<ProjectRow>`
    SELECT
      p.id, p.slug, p.name, p.mission, p.status,
      (SELECT COUNT(*) FROM goals g WHERE g.project_id = p.id) AS goal_count,
      p.created_at, p.updated_at
    FROM projects p
    ORDER BY p.created_at DESC
    LIMIT ${limit}
  `;
  return c.json(rows);
});

type GoalRow = {
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

data.get("/goals", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  const limit = clampLimit(new URL(c.req.url).searchParams.get("limit"));
  const sql = getDb(c.env);
  const rows = await sql<GoalRow>`
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
  return c.json(rows);
});

data.get("/portfolio", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  // Empty productized snapshot. A fork starts with zero holdings; the recipient
  // connects their own later (sync integration in a later phase). No seed ships.
  return c.json({
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
  });
});

type SettingsRow = { display_name: string | null; config: string | null };

async function readConfig(c: { env: AppEnv }): Promise<{ display_name: string; config: Config; pages: string[] }> {
  const sql = getDb(c.env);
  const rows = await sql<SettingsRow>`SELECT display_name, config FROM settings WHERE id = 1`;
  const raw = rows[0]?.config ? safeParse(rows[0].config) : {};
  const config = migrateConfig(raw);
  const display_name = rows[0]?.display_name ?? config.display_name;
  return { display_name, config, pages: resolvePages(config) };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Client-safe settings view. The per-fork `tools_key` is a SECRET — it must never
 * reach the browser (ISC-39). We strip it from every response and expose only a
 * boolean `tools_configured` so the UI can show connected/not-configured without
 * ever holding the key. The real key stays in D1 and is used only by the
 * server-side /tools/* proxy.
 */
function settingsView(out: { display_name: string; config: Config; pages: string[] }) {
  const { tools_key, ...rest } = out.config;
  return {
    display_name: out.display_name,
    config: { ...rest, tools_key: null },
    pages: out.pages,
    tools_configured: Boolean(tools_key && tools_key.length > 0),
  };
}

data.get("/settings", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  const out = await readConfig(c);
  return c.json(settingsView(out));
});

data.put("/settings", async (c) => {
  let viewer;
  try {
    viewer = await requireViewer(c.req.raw, c.env);
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }
  if (!viewer.isOwner) return c.json({ error: "owner only" }, 403);

  let patch: unknown;
  try {
    patch = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return c.json({ error: "body must be a JSON object" }, 400);
  }

  const current = await readConfig(c);
  const next = mergeConfig(current.config, patch);
  const sql = getDb(c.env);
  await sql`
    INSERT INTO settings (id, display_name, config, updated_at)
    VALUES (1, ${next.display_name}, ${JSON.stringify(next)}, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT (id) DO UPDATE
      SET display_name = ${next.display_name},
          config = ${JSON.stringify(next)},
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
  `;
  return c.json(settingsView({ display_name: next.display_name, config: next, pages: resolvePages(next) }));
});

// ---- Knowledge Base (ISC-40, ISC-41) ----

data.get("/kb", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  const limit = clampLimit(new URL(c.req.url).searchParams.get("limit"));
  const sql = getDb(c.env);
  const rows = await sql<{ slug: string; title: string; updated_at: string }>`
    SELECT slug, title, updated_at FROM kb_docs ORDER BY title ASC LIMIT ${limit}
  `;
  return c.json(rows);
});

data.get("/kb/:slug", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  const slug = c.req.param("slug");
  const sql = getDb(c.env);
  const rows = await sql<{ slug: string; title: string; blocks: string; updated_at: string }>`
    SELECT slug, title, blocks, updated_at FROM kb_docs WHERE slug = ${slug} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  let blocks: unknown;
  try {
    blocks = JSON.parse(row.blocks);
  } catch {
    blocks = { blocks: [] };
  }
  return c.json({ slug: row.slug, title: row.title, blocks, updated_at: row.updated_at });
});

// ---- Tools proxy (ISC-38, ISC-39) ----
// The per-fork pt_ key lives in config (server-side) and is injected here. It is
// NEVER returned to the browser; the page calls these same-origin routes.

const TOOLS_BASE_FALLBACK = "https://pai-tools.aitheroad.workers.dev";

function toolsBase(env: AppEnv): string {
  return (env.TOOLS_BASE_URL || TOOLS_BASE_FALLBACK).replace(/\/+$/, "");
}

data.get("/tools/status", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  const { config } = await readConfig(c);
  const key = config.tools_key;
  if (!key) return c.json({ configured: false });

  const base = toolsBase(c.env);
  // Public catalog (no auth) for the tool list. Timeout-guarded so a hung upstream
  // can't stall the Worker request.
  let tools: Array<{ name: string; description: string }> = [];
  try {
    const cat = await fetch(`${base}/`, { signal: AbortSignal.timeout(5000) });
    if (cat.ok) {
      const j = (await cat.json()) as {
        endpoints?: { tools?: Array<{ name: string; description: string }> };
      };
      tools = (j.endpoints?.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
      }));
    }
  } catch {
    /* catalog is best-effort */
  }
  // Authed key-validity probe (free GET) — owner-only, so a non-owner can't learn
  // whether the owner's key is valid. The key itself is never returned either way.
  let valid: boolean | undefined;
  if (viewer.isOwner) {
    valid = false;
    try {
      const probe = await fetch(`${base}/api/media/list`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      valid = probe.ok;
    } catch {
      valid = false;
    }
  }
  return c.json({ configured: true, valid, tools });
});

data.post("/tools/:tool", async (c) => {
  let viewer;
  try {
    viewer = await requireViewer(c.req.raw, c.env);
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }
  // Tool calls SPEND the per-fork key (real money/quota). Require a verified CF
  // Access owner — never open-dev: on a bare workers.dev fork (no Access yet),
  // open-dev grants owner to every anonymous visitor, so allowing the spend there
  // would let strangers drain the key. Spending requires real auth, full stop.
  if (viewer.mode !== "access" || !viewer.isOwner) {
    return c.json(
      { error: "Enable Cloudflare Access on this fork to use tools." },
      403,
    );
  }
  const tool = c.req.param("tool");
  if (!/^[a-z0-9_-]+$/.test(tool)) return c.json({ error: "bad tool name" }, 400);

  const { config } = await readConfig(c);
  const key = config.tools_key;
  if (!key) return c.json({ error: "tools not configured" }, 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const base = toolsBase(c.env);
  const res = await fetch(`${base}/api/${tool}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(60000),
  });
  let text = await res.text();
  // Belt-and-suspenders: never reflect the key back to the browser even if a
  // buggy/hostile upstream echoed it (ISC-39).
  if (key && text.includes(key)) text = text.split(key).join("[redacted]");
  return new Response(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
});
