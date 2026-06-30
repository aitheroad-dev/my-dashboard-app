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
import {
  toolsStatus,
  generateImage,
  transcribe,
  ocr,
  synthesize,
  listImages,
  listVoice,
  listTranscripts,
  getMedia,
  deleteMedia,
  deleteTranscript,
  ToolError,
} from "../services/tools";

/**
 * HTTP `/api/*` routes — thin handlers over the shared service layer
 * (`workers/services/store.ts`). The MCP control plane calls the SAME service
 * functions (ISC-45), so there is one query path, not two. Auth via the
 * `getViewer` seam; portfolio ships empty; `openai_key` is redacted from every
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

// ---- Tools (native, ISC-54.x rebuild 2026-06-29) ----
// The tools run IN this worker on the fork's own `env.AI` (+ OpenAI for TTS) — no
// pai-tools, no key in the browser, no worker→worker hop (kills CF error 1042).
// Gated by the dashboard's own CF Access (the caller is already signed in); media
// lives in this fork's own KV. Logic in workers/services/tools.ts.

data.get("/tools/status", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  // `ready` tracks whether this viewer can actually run the tools (all tool routes
  // are owner-gated) — so the page shows an honest state on an open-dev fork. The
  // status no longer depends on any key: English (Aura) and Hebrew (Edge) are keyless.
  const canUse = viewer.mode === "access" && viewer.isOwner;
  return c.json(toolsStatus(canUse));
});

// ---- Tool galleries (owner-only) — this fork's OWN generated media ----
data.get("/tools/media/list", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  if (viewer.mode !== "access" || !viewer.isOwner)
    return c.json({ error: "Sign in to this dashboard to view your gallery." }, 403);
  return c.json(await listImages(c.env));
});

data.get("/tools/voice/list", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  if (viewer.mode !== "access" || !viewer.isOwner)
    return c.json({ error: "Sign in to this dashboard to view your gallery." }, 403);
  return c.json(await listVoice(c.env));
});

data.get("/tools/text/list", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  if (viewer.mode !== "access" || !viewer.isOwner)
    return c.json({ error: "Sign in to this dashboard to view your gallery." }, 403);
  return c.json(await listTranscripts(c.env));
});

// Serve this fork's own generated media from KV (owner-only; the browser's
// same-origin <img>/<audio> requests carry the CF Access cookie, so they're authed).
data.get("/tools/media/:kind/:id", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  if (viewer.mode !== "access" || !viewer.isOwner) return c.json({ error: "forbidden" }, 403);
  const kind = c.req.param("kind");
  if (kind !== "img" && kind !== "audio") return c.json({ error: "not found" }, 404);
  const media = await getMedia(c.env, kind, c.req.param("id"));
  if (!media) return c.json({ error: "not found" }, 404);
  return new Response(media.body, {
    headers: {
      "content-type": media.contentType,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
});

// Delete one gallery item (owner-only) — image/audio blob + its index entry.
data.delete("/tools/media/:kind/:id", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  if (viewer.mode !== "access" || !viewer.isOwner) return c.json({ error: "forbidden" }, 403);
  const kind = c.req.param("kind");
  if (kind !== "img" && kind !== "audio") return c.json({ error: "not found" }, 404);
  const ok = await deleteMedia(c.env, kind, c.req.param("id"));
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ deleted: true });
});

// Delete one saved transcript (owner-only).
data.delete("/tools/text/:id", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  if (viewer.mode !== "access" || !viewer.isOwner) return c.json({ error: "forbidden" }, 403);
  const ok = await deleteTranscript(c.env, c.req.param("id"));
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ deleted: true });
});

// Run a tool natively. Never open-dev: a bare workers.dev fork would otherwise let
// any anonymous visitor spend the fork's own AI quota. The caller is already signed
// into the dashboard via CF Access — that IS the auth.
data.post("/tools/:tool", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  if (viewer.mode !== "access" || !viewer.isOwner) {
    return c.json({ error: "Sign in to this dashboard (Cloudflare Access) to use the tools." }, 403);
  }
  const tool = c.req.param("tool");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const { config } = await readSettings(c.env);
  try {
    let result: Record<string, unknown>;
    switch (tool) {
      case "flux":
        result = await generateImage(c.env, body);
        break;
      case "whisper":
        result = await transcribe(c.env, body);
        break;
      case "ocr":
        result = await ocr(c.env, body);
        break;
      case "tts":
        result = await synthesize(c.env, config.openai_key, body);
        break;
      default:
        return c.json({ error: `unknown tool: ${tool}` }, 404);
    }
    return c.json(result);
  } catch (e) {
    if (e instanceof ToolError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.status,
        headers: { "content-type": "application/json" },
      });
    }
    // Unexpected (non-ToolError) failure: don't leak the raw internal message —
    // every meaningful client-input error is already a ToolError(400).
    return c.json({ error: "The tool failed unexpectedly. Please try again." }, 502);
  }
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
