import { Hono } from "hono";
import type { AppEnv } from "../lib/env";
import { requireViewer } from "../lib/viewer";
import {
  IngestAuthError,
  createStream,
  ingestEvents,
  listDeadLetters,
  listStreams,
  rotateStreamKey,
  setStreamEnabled,
} from "../services/ingest";

/**
 * W3 ingest routes. Two audiences, one router:
 *  - MACHINE: `POST /:stream` — authenticated by the per-stream X-Ingest-Key (the edge
 *    CF Access service token already gated arrival). NO viewer/owner identity involved.
 *  - OWNER (browser): `/streams*` management — same requireViewer+isOwner gate as /api/sd.
 *
 * Route order matters: `/streams*` management routes are registered BEFORE the `/:stream`
 * catch-all, and "streams" is a reserved stream key, so the two can never collide.
 */

export const ingest = new Hono<{ Bindings: AppEnv }>();

async function ownerOrResponse(c: { req: { raw: Request }; env: AppEnv }): Promise<{ email: string } | Response> {
  let viewer;
  try {
    viewer = await requireViewer(c.req.raw, c.env);
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }
  if (!viewer.isOwner) {
    return new Response(JSON.stringify({ error: "owner required" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  return { email: viewer.email || "owner-ui" };
}

function errorJson(c: { json: (body: unknown, status?: number) => Response }, e: unknown): Response {
  if (e instanceof Response) return e;
  const msg = e instanceof Error ? e.message : "bad request";
  return c.json({ error: msg }, msg.startsWith("no ") ? 404 : 400);
}

// ---- Owner management (browser, CF Access identity) ----

ingest.get("/streams", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    return c.json({ streams: await listStreams(c.env) });
  } catch (e) {
    return errorJson(c, e);
  }
});

ingest.post("/streams", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => ({}))) as { key?: string; entity_key?: string };
    const created = await createStream(c.env, { key: body.key ?? "", entity_key: body.entity_key ?? "" }, gate.email);
    return c.json(created, 201);
  } catch (e) {
    return errorJson(c, e);
  }
});

ingest.post("/streams/:key/rotate", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    return c.json(await rotateStreamKey(c.env, c.req.param("key"), gate.email));
  } catch (e) {
    return errorJson(c, e);
  }
});

ingest.post("/streams/:key/enable", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    await setStreamEnabled(c.env, c.req.param("key"), body.enabled !== false, gate.email);
    return c.json({ key: c.req.param("key"), enabled: body.enabled !== false });
  } catch (e) {
    return errorJson(c, e);
  }
});

ingest.get("/streams/:key/dead-letters", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    return c.json({ dead_letters: await listDeadLetters(c.env, c.req.param("key")) });
  } catch (e) {
    return errorJson(c, e);
  }
});

// ---- Machine write path (per-stream key; MUST stay last so /streams wins) ----

ingest.post("/:stream", async (c) => {
  try {
    const result = await ingestEvents(
      c.env,
      c.req.param("stream"),
      c.req.header("X-Ingest-Key") ?? null,
      await c.req.json().catch(() => null),
    );
    return c.json(result, result.dead_lettered > 0 && result.accepted === 0 && result.duplicates === 0 ? 422 : 200);
  } catch (e) {
    if (e instanceof IngestAuthError) return c.json({ error: e.message }, e.status as 401 | 403 | 404);
    return errorJson(c, e);
  }
});
