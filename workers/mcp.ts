import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppEnv } from "./lib/env";
import {
  listCards,
  addCard,
  editCard,
  moveCard,
  deleteCard,
  getPortfolio,
  readSettings,
  publicSettings,
  listKbDocs,
  getKbDoc,
  addKbDoc,
  editKbDoc,
  listMcpActivity,
} from "./services/store";

/**
 * MCP control plane (ISC-42 reads, ISC-43/45/46 guarded writes). Stateless — built
 * per request via `createMcpHandler`. Tools call the SAME service functions the
 * HTTP routes use (ISC-45), never internal HTTP. Auth is the scoped per-fork bearer,
 * enforced in app.ts before this handler runs.
 *
 * Guarded WRITES (add_kb_doc / edit_kb_doc): a write executes ONLY when the caller
 * passes confirm:true — the ISA's sanctioned confirm-gate fallback for clients
 * without interactive elicitation. Without it the tool is a no-op preview. Every
 * successful write commits the data change + exactly one mcp_activity audit row in
 * one atomic D1 batch (store.ts). Interactive server→client elicitation (McpAgent
 * Durable Object) is deferred: it needs a stateful transport AND an elicitation-
 * capable client to exercise, and the DO migration touches the deploy-button
 * wrangler.jsonc — the confirm-gate satisfies ISC-43/46's verifiable contract today.
 */

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function createReadServer(env: AppEnv): McpServer {
  const server = new McpServer({ name: "My Dashboard", version: "1.0.0" });

  server.registerTool(
    "list_cards",
    {
      description: "List this dashboard's board cards (columns: todo, in_progress, done).",
      inputSchema: { limit: z.number().int().positive().max(1000).optional() },
    },
    async ({ limit }) => asText(await listCards(env, limit ?? 500)),
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

  // ---- Guarded WRITE tools (P3 Slice 1, ISC-43/46) ----
  const CONFIRM_HINT =
    "Not written. This tool changes stored data — re-call with confirm:true to proceed.";

  server.registerTool(
    "add_kb_doc",
    {
      description:
        "Create a NEW knowledge-base document. GUARDED: nothing is written unless confirm:true is passed (re-call to confirm). Fails if the slug already exists — use edit_kb_doc to change an existing doc.",
      inputSchema: {
        slug: z.string().min(1).max(63).describe("URL slug: lowercase letters, numbers, hyphens"),
        title: z.string().min(1).max(200),
        blocks: z.any().optional().describe("Blocks JSON: an array of blocks, or {blocks:[...]}"),
        confirm: z.boolean().optional().describe("Must be true to actually perform the write"),
      },
    },
    async ({ slug, title, blocks, confirm }) => {
      if (confirm !== true) {
        return asText({ status: "confirmation_required", action: "add_kb_doc", slug, title, note: CONFIRM_HINT });
      }
      try {
        return asText({ status: "created", ...(await addKbDoc(env, { slug, title, blocks })) });
      } catch (e) {
        return { ...asText({ status: "error", error: (e as Error).message }), isError: true as const };
      }
    },
  );

  server.registerTool(
    "edit_kb_doc",
    {
      description:
        "Edit an EXISTING knowledge-base document's title and/or blocks. GUARDED: nothing is written unless confirm:true is passed. Fails if the slug does not exist.",
      inputSchema: {
        slug: z.string().min(1).max(63),
        title: z.string().min(1).max(200).optional(),
        blocks: z.any().optional().describe("Replacement blocks JSON: an array, or {blocks:[...]}"),
        confirm: z.boolean().optional().describe("Must be true to actually perform the write"),
      },
    },
    async ({ slug, title, blocks, confirm }) => {
      if (confirm !== true) {
        return asText({ status: "confirmation_required", action: "edit_kb_doc", slug, note: CONFIRM_HINT });
      }
      try {
        return asText({ status: "updated", ...(await editKbDoc(env, { slug, title, blocks })) });
      } catch (e) {
        return { ...asText({ status: "error", error: (e as Error).message }), isError: true as const };
      }
    },
  );

  // ---- Board (card) guarded WRITE tools — same confirm-gate + atomic audit ----
  const CARD_STATUS = z.enum(["todo", "in_progress", "done"]);

  server.registerTool(
    "add_card",
    {
      description:
        "Add a NEW card to the board. GUARDED: nothing is written unless confirm:true is passed (re-call to confirm). Defaults to the To Do column.",
      inputSchema: {
        title: z.string().min(1).max(200),
        notes: z.string().max(2000).optional(),
        status: CARD_STATUS.optional().describe("Target column; defaults to todo"),
        confirm: z.boolean().optional().describe("Must be true to actually perform the write"),
      },
    },
    async ({ title, notes, status, confirm }) => {
      if (confirm !== true) {
        return asText({ status: "confirmation_required", action: "add_card", title, column: status ?? "todo", note: CONFIRM_HINT });
      }
      try {
        return asText({ result: "created", card: await addCard(env, { title, notes, status }, "mcp-bearer") });
      } catch (e) {
        return { ...asText({ status: "error", error: (e as Error).message }), isError: true as const };
      }
    },
  );

  server.registerTool(
    "move_card",
    {
      description:
        "Move a card to a different column (todo / in_progress / done). GUARDED: nothing changes unless confirm:true is passed.",
      inputSchema: {
        id: z.string().min(1),
        status: CARD_STATUS,
        confirm: z.boolean().optional().describe("Must be true to actually perform the move"),
      },
    },
    async ({ id, status, confirm }) => {
      if (confirm !== true) {
        return asText({ status: "confirmation_required", action: "move_card", id, to: status, note: CONFIRM_HINT });
      }
      try {
        return asText({ result: "moved", card: await moveCard(env, { id, status }, "mcp-bearer") });
      } catch (e) {
        return { ...asText({ status: "error", error: (e as Error).message }), isError: true as const };
      }
    },
  );

  server.registerTool(
    "edit_card",
    {
      description:
        "Edit an existing card's title and/or notes. GUARDED: nothing changes unless confirm:true is passed.",
      inputSchema: {
        id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        notes: z.string().max(2000).optional(),
        confirm: z.boolean().optional().describe("Must be true to actually perform the edit"),
      },
    },
    async ({ id, title, notes, confirm }) => {
      if (confirm !== true) {
        return asText({ status: "confirmation_required", action: "edit_card", id, note: CONFIRM_HINT });
      }
      try {
        return asText({ result: "updated", card: await editCard(env, { id, title, notes }, "mcp-bearer") });
      } catch (e) {
        return { ...asText({ status: "error", error: (e as Error).message }), isError: true as const };
      }
    },
  );

  server.registerTool(
    "delete_card",
    {
      description: "Delete a card from the board. GUARDED: nothing is deleted unless confirm:true is passed.",
      inputSchema: {
        id: z.string().min(1),
        confirm: z.boolean().optional().describe("Must be true to actually delete"),
      },
    },
    async ({ id, confirm }) => {
      if (confirm !== true) {
        return asText({ status: "confirmation_required", action: "delete_card", id, note: CONFIRM_HINT });
      }
      try {
        return asText({ status: "deleted", ...(await deleteCard(env, { id }, "mcp-bearer")) });
      } catch (e) {
        return { ...asText({ status: "error", error: (e as Error).message }), isError: true as const };
      }
    },
  );

  server.registerTool(
    "list_mcp_activity",
    {
      description: "List recent MCP write-tool audit entries (most recent first) — the write trail.",
      inputSchema: { limit: z.number().int().positive().max(200).optional() },
    },
    async ({ limit }) => asText(await listMcpActivity(env, limit ?? 50)),
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
