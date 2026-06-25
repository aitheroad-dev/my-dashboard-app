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

data.get("/settings", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  const out = await readConfig(c);
  return c.json(out);
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
  return c.json({ display_name: next.display_name, config: next, pages: resolvePages(next) });
});
