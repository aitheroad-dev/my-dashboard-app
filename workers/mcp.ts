import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppEnv } from "./lib/env";
import {
  listProjects,
  listGoals,
  getPortfolio,
  readSettings,
  publicSettings,
  listKbDocs,
  getKbDoc,
} from "./services/store";

/**
 * Read-only MCP control plane (ISC-42). Stateless — no Durable Object — built per
 * request via `createMcpHandler`. Tools call the SAME service functions the HTTP
 * routes use (ISC-45), never internal HTTP. Auth is the scoped per-fork bearer,
 * enforced in app.ts before this handler runs. Guarded WRITE tools land in P3
 * Slice 1 via an McpAgent Durable Object (elicitation + audit).
 */

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function createReadServer(env: AppEnv): McpServer {
  const server = new McpServer({ name: "My Dashboard", version: "1.0.0" });

  server.registerTool(
    "list_projects",
    {
      description: "List this dashboard's projects (with goal counts).",
      inputSchema: { limit: z.number().int().positive().max(1000).optional() },
    },
    async ({ limit }) => asText(await listProjects(env, limit ?? 500)),
  );

  server.registerTool(
    "list_goals",
    {
      description: "List this dashboard's goals (with their project names).",
      inputSchema: { limit: z.number().int().positive().max(1000).optional() },
    },
    async ({ limit }) => asText(await listGoals(env, limit ?? 500)),
  );

  server.registerTool(
    "get_portfolio",
    { description: "Get the portfolio snapshot (empty until the recipient connects one).", inputSchema: {} },
    async () => asText(getPortfolio()),
  );

  server.registerTool(
    "list_kb",
    {
      description: "List knowledge-base documents (slug + title).",
      inputSchema: { limit: z.number().int().positive().max(1000).optional() },
    },
    async ({ limit }) => asText(await listKbDocs(env, limit ?? 500)),
  );

  server.registerTool(
    "get_kb_doc",
    {
      description: "Get a knowledge-base document's blocks by slug.",
      inputSchema: { slug: z.string().min(1) },
    },
    async ({ slug }) => {
      const doc = await getKbDoc(env, slug);
      return doc ? asText(doc) : asText({ error: "not found", slug });
    },
  );

  server.registerTool(
    "get_settings",
    {
      description: "Get this dashboard's settings (display name, theme, enabled pages). The tools key is never exposed.",
      inputSchema: {},
    },
    async () => asText(publicSettings(await readSettings(env))),
  );

  return server;
}

/** Entry point — wired at /mcp in app.ts after bearer auth. */
export function mcpReadHandler(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
): Response | Promise<Response> {
  const server = createReadServer(env);
  return createMcpHandler(server)(request, env, ctx);
}
