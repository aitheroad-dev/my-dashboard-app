import { Hono } from "hono";
import type { AppEnv } from "../lib/env";
import { getViewer, requireViewer } from "../lib/viewer";
import { runAssistant } from "../services/assistant";
import {
  clampLimit,
  listProjects,
  listGoals,
  getPortfolio,
  readSettings,
  writeSettings,
  publicSettings,
  listKbDocs,
  getKbDoc,
} from "../services/store";

/**
 * HTTP `/api/*` routes — thin handlers over the shared service layer
 * (`workers/services/store.ts`). The MCP control plane calls the SAME service
 * functions (ISC-45), so there is one query path, not two. Auth via the
 * `getViewer` seam; portfolio ships empty; `tools_key` is redacted from every
 * settings response (ISC-39).
 */
export const data = new Hono<{ Bindings: AppEnv }>();

function limitOf(c: { req: { url: string } }): number {
  return clampLimit(new URL(c.req.url).searchParams.get("limit"));
}

data.get("/projects", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  return c.json(await listProjects(c.env, limitOf(c)));
});

data.get("/goals", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  return c.json(await listGoals(c.env, limitOf(c)));
});

data.get("/portfolio", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  return c.json(getPortfolio());
});

data.get("/settings", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  return c.json(publicSettings(await readSettings(c.env)));
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
  return c.json(publicSettings(await writeSettings(c.env, patch)));
});

// ---- Knowledge Base (ISC-40, ISC-41) ----

data.get("/kb", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  return c.json(await listKbDocs(c.env, limitOf(c)));
});

data.get("/kb/:slug", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  const doc = await getKbDoc(c.env, c.req.param("slug"));
  if (!doc) return c.json({ error: "not found" }, 404);
  return c.json(doc);
});

// ---- Tools proxy (ISC-38, ISC-39) ----
// The per-fork pt_ key lives in config (server-side) and is injected here. It is
// NEVER returned to the browser; the page calls these same-origin routes.

const TOOLS_BASE_FALLBACK = "https://pai-tools.aitheroad.workers.dev";

function toolsBase(env: AppEnv): string {
  const raw = (env.TOOLS_BASE_URL || TOOLS_BASE_FALLBACK).replace(/\/+$/, "");
  // The per-fork key rides on requests to this base — require a valid https URL
  // (deploy-controlled, but harden defensively); fall back to the known host (L2).
  try {
    if (new URL(raw).protocol === "https:") return raw;
  } catch {
    /* malformed override */
  }
  return TOOLS_BASE_FALLBACK;
}

// UUID-ish media id guard (M4) — upstream-derived; reject anything else before
// it becomes a media URL or a React key.
function isMediaId(id: unknown): id is string {
  return typeof id === "string" && /^[a-f0-9-]{8,}$/i.test(id);
}

data.get("/tools/status", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  const { config } = await readSettings(c.env);
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

// ---- Tool galleries (owner-only, read-only) ----
// Surfaces the fork owner's own generated media so the workspace feels inhabited.
// Read-only + free (no spend) → owner gate is enough (lighter than the spend path).
// The key is injected server-side; the public media URLs (unguessable UUID = the
// capability) are constructed here so the browser can render them without the key.
data.get("/tools/media/list", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  // Match the spend route's posture (advisor 2026-06-29): never open-dev. On a
  // bare workers.dev fork, open-dev grants owner to every anonymous visitor, so
  // a looser gate would leak the owner's generated media. Require verified Access.
  if (viewer.mode !== "access" || !viewer.isOwner)
    return c.json({ error: "Enable Cloudflare Access on this fork to view the gallery." }, 403);
  const { config } = await readSettings(c.env);
  const key = config.tools_key;
  if (!key) return c.json({ items: [] });
  const base = toolsBase(c.env);
  try {
    const r = await fetch(`${base}/api/media/list`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    // Surface a real error so the client can distinguish "broken" from "empty" (M5).
    if (!r.ok) return c.json({ error: "gallery upstream error" }, 502);
    let text = await r.text();
    // Redaction parity with the spend route (M1) — never reflect the key.
    if (key && text.includes(key)) text = text.split(key).join("[redacted]");
    const j = JSON.parse(text) as {
      items?: Array<{ id?: string; prompt?: string; quality?: string; ts?: number }>;
    };
    const items = (j.items ?? [])
      .filter((it) => isMediaId(it.id))
      .map((it) => ({
        id: it.id as string,
        prompt: it.prompt ?? "",
        quality: it.quality ?? "",
        ts: it.ts ?? 0,
        img_url: `${base}/img/${encodeURIComponent(it.id as string)}`,
      }));
    return c.json({ items });
  } catch {
    return c.json({ error: "gallery unavailable" }, 502);
  }
});

data.get("/tools/voice/list", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  // Match the spend route's posture (advisor 2026-06-29): never open-dev. On a
  // bare workers.dev fork, open-dev grants owner to every anonymous visitor, so
  // a looser gate would leak the owner's generated media. Require verified Access.
  if (viewer.mode !== "access" || !viewer.isOwner)
    return c.json({ error: "Enable Cloudflare Access on this fork to view the gallery." }, 403);
  const { config } = await readSettings(c.env);
  const key = config.tools_key;
  if (!key) return c.json({ items: [], ttl_days: 14 });
  const base = toolsBase(c.env);
  try {
    const r = await fetch(`${base}/api/voice/list`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return c.json({ error: "gallery upstream error" }, 502); // M5
    let text = await r.text();
    if (key && text.includes(key)) text = text.split(key).join("[redacted]"); // M1
    const j = JSON.parse(text) as {
      items?: Array<{ id?: string; text?: string; engine?: string; ts?: number }>;
      ttl_days?: number;
    };
    const items = (j.items ?? [])
      .filter((it) => isMediaId(it.id))
      .map((it) => ({
        id: it.id as string,
        text: it.text ?? "",
        engine: it.engine ?? "",
        ts: it.ts ?? 0,
        audio_url: `${base}/audio/${encodeURIComponent(it.id as string)}`,
      }));
    return c.json({ items, ttl_days: j.ttl_days ?? 14 });
  } catch {
    return c.json({ error: "gallery unavailable" }, 502);
  }
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

  const { config } = await readSettings(c.env);
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

// Built-in Assistant (ISC-44). Runs model inference grounded in this fork's data.
// Owner-gated + verified Access only (never open-dev) — same posture as tool spend:
// a bare workers.dev fork must not let anonymous visitors drive inference.
data.post("/assistant", async (c) => {
  let viewer;
  try {
    viewer = await requireViewer(c.req.raw, c.env);
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }
  if (viewer.mode !== "access" || !viewer.isOwner) {
    return c.json({ error: "Enable Cloudflare Access on this fork to use the assistant." }, 403);
  }
  let body: { question?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const question = String(body.question ?? "").slice(0, 4000).trim();
  if (!question) return c.json({ error: "Ask a question." }, 400);
  try {
    return c.json(await runAssistant(c.env, question));
  } catch (e) {
    return c.json({ error: `assistant failed: ${(e as Error).message}` }, 502);
  }
});
