import { Hono } from "hono";
import type { AppEnv } from "../lib/env";
import type { FilterOp, FilterSpec, SortSpec } from "../lib/spec/schema";
import { requireViewer } from "../lib/viewer";
import { applyPlan, proposePlan, rejectPlan } from "../services/spec-plan";
import {
  addRecord,
  deleteRecord,
  editRecord,
  getPageDetail,
  listEntities,
  listPageSummaries,
  listRecords,
} from "../services/spec-store";
import { clampLimit } from "../services/store";

export const spec = new Hono<{ Bindings: AppEnv }>();

async function ownerOrResponse(c: { req: { raw: Request }; env: AppEnv }): Promise<{ email: string } | Response> {
  let viewer;
  try {
    viewer = await requireViewer(c.req.raw, c.env);
  } catch (res) {
    // requireViewer throws a ready 401 Response when no viewer resolves (unauth).
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

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("bad JSON");
  }
}

function errorResponse(c: { json: (body: unknown, status?: number) => Response }, e: unknown): Response {
  // A thrown Response (e.g. the 401 from requireViewer) passes straight through.
  if (e instanceof Response) return e;
  const msg = e instanceof Error ? e.message : "bad request";
  return c.json({ error: msg }, msg.startsWith("no ") || msg.startsWith("not found") ? 404 : 400);
}

function parseSort(raw: string | null): SortSpec | undefined {
  if (!raw) return undefined;
  const [field, direction] = raw.split(":");
  if (!field || (direction !== "asc" && direction !== "desc")) throw new Error("invalid sort");
  return { field, direction };
}

function parseFilter(raw: string | null): FilterSpec | undefined {
  if (!raw) return undefined;
  const parts = raw.split(":");
  if (parts.length < 2) throw new Error("invalid filter");
  const [field, op, ...rest] = parts;
  if (!field || !op) throw new Error("invalid filter");
  const value = rest.length ? rest.join(":") : undefined;
  return { field, op: op as FilterOp, value };
}

spec.post("/plans", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    const body = await readJson(c.req.raw);
    const input =
      body && typeof body === "object" && "plan" in body ? (body as { plan?: unknown }).plan ?? body : body;
    return c.json(await proposePlan(c.env, input, gate.email), 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

spec.post("/plans/:id/apply", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    return c.json(await applyPlan(c.env, c.req.param("id"), gate.email));
  } catch (e) {
    return errorResponse(c, e);
  }
});

spec.post("/plans/:id/reject", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    return c.json(await rejectPlan(c.env, c.req.param("id"), gate.email));
  } catch (e) {
    return errorResponse(c, e);
  }
});

spec.get("/entities", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    return c.json(await listEntities(c.env));
  } catch (e) {
    return errorResponse(c, e);
  }
});

spec.get("/pages", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    return c.json(await listPageSummaries(c.env));
  } catch (e) {
    return errorResponse(c, e);
  }
});

spec.get("/pages/:key", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    const detail = await getPageDetail(c.env, c.req.param("key"));
    if (!detail) return c.json({ error: "not found" }, 404);
    return c.json(detail);
  } catch (e) {
    return errorResponse(c, e);
  }
});

spec.get("/entities/:key/records", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    const url = new URL(c.req.url);
    const query = {
      sort: parseSort(url.searchParams.get("sort")),
      filter: parseFilter(url.searchParams.get("filter")),
      limit: clampLimit(url.searchParams.get("limit"), 500),
    };
    return c.json(await listRecords(c.env, c.req.param("key"), query));
  } catch (e) {
    return errorResponse(c, e);
  }
});

spec.post("/entities/:key/records", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    const body = await readJson(c.req.raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("record body must be an object");
    return c.json(await addRecord(c.env, c.req.param("key"), body as Record<string, unknown>, gate.email), 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

spec.put("/entities/:key/records/:id", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    const body = await readJson(c.req.raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("record body must be an object");
    return c.json(await editRecord(c.env, c.req.param("key"), c.req.param("id"), body as Record<string, unknown>, gate.email));
  } catch (e) {
    return errorResponse(c, e);
  }
});

spec.delete("/entities/:key/records/:id", async (c) => {
  try {
    const gate = await ownerOrResponse(c);
    if (gate instanceof Response) return gate;
    return c.json(await deleteRecord(c.env, c.req.param("key"), c.req.param("id"), gate.email));
  } catch (e) {
    return errorResponse(c, e);
  }
});
