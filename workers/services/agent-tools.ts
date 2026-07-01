import type { AppEnv } from "../lib/env";
import {
  listCards,
  getPortfolio,
  readSettings,
  publicSettings,
  listKbDocs,
  getKbDoc,
  addCard,
  editCard,
  moveCard,
  deleteCard,
} from "./store";

/**
 * Agent tool registry (P3 Slice 3b, ISC-79/81). The built-in Assistant's
 * tool-calling loop dispatches through this single table; each tool calls the SAME
 * `store.ts` service functions the MCP control plane and the HTTP routes use (ISC-45).
 *
 * `kind` is the security boundary:
 *  - "read"  → executed immediately inside the loop.
 *  - "write" → NEVER executed by the model. The loop only PROPOSES a write; it runs
 *              only after the authenticated owner confirms it in the UI (see
 *              runAssistant's `confirm` path). Writes carry actor "assistant" and the
 *              store commits the data change + exactly one mcp_activity audit row.
 */

export type ToolKind = "read" | "write";

export interface AgentTool {
  name: string;
  kind: ToolKind;
  description: string;
  /** JSON Schema for the function arguments (OpenAI tools format). */
  parameters: Record<string, unknown>;
  run: (env: AppEnv, args: Record<string, unknown>) => Promise<unknown>;
  /** Human-readable one-liner for the Confirm card + audit-facing text. */
  summarize: (args: Record<string, unknown>) => string;
}

const CARD_STATUS = { type: "string", enum: ["todo", "in_progress", "done"] };
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const AGENT_TOOLS: AgentTool[] = [
  // ---------- READS (run immediately) ----------
  {
    name: "list_cards",
    kind: "read",
    description: "List the board's cards with their column (todo, in_progress, done). Call this to find a card's id before moving/editing/deleting it.",
    parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500 } } },
    run: (env, a) => listCards(env, typeof a.limit === "number" ? a.limit : 200),
    summarize: () => "List board cards",
  },
  {
    name: "get_portfolio",
    kind: "read",
    description: "Get the portfolio snapshot (empty until the owner connects one).",
    parameters: { type: "object", properties: {} },
    run: async () => getPortfolio(),
    summarize: () => "Read portfolio",
  },
  {
    name: "list_kb",
    kind: "read",
    description: "List knowledge-base documents (slug + title).",
    parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500 } } },
    run: (env, a) => listKbDocs(env, typeof a.limit === "number" ? a.limit : 100),
    summarize: () => "List knowledge base",
  },
  {
    name: "get_kb_doc",
    kind: "read",
    description: "Get a knowledge-base document's content by slug.",
    parameters: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
    run: (env, a) => getKbDoc(env, str(a.slug)),
    summarize: (a) => `Read KB doc "${str(a.slug)}"`,
  },
  {
    name: "get_settings",
    kind: "read",
    description: "Get this dashboard's public settings (display name, theme, enabled pages). Secrets are never exposed.",
    parameters: { type: "object", properties: {} },
    run: async (env) => publicSettings(await readSettings(env)),
    summarize: () => "Read settings",
  },

  // ---------- WRITES (proposed only; run after explicit owner confirm) ----------
  {
    name: "add_card",
    kind: "write",
    description: "Add a new card to the board. Defaults to the To Do column.",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, notes: { type: "string" }, status: CARD_STATUS },
      required: ["title"],
    },
    run: (env, a) =>
      addCard(
        env,
        { title: str(a.title), notes: a.notes == null ? null : str(a.notes), status: str(a.status) || undefined },
        "assistant",
      ),
    summarize: (a) => `Add card "${str(a.title)}"${a.status ? ` to ${str(a.status)}` : ""}`,
  },
  {
    name: "move_card",
    kind: "write",
    description: "Move a card to a different column (todo, in_progress, done). Needs the card id — call list_cards first if you don't have it.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, status: CARD_STATUS },
      required: ["id", "status"],
    },
    run: (env, a) => moveCard(env, { id: str(a.id), status: str(a.status) }, "assistant"),
    summarize: (a) => `Move card ${str(a.id)} to ${str(a.status)}`,
  },
  {
    name: "edit_card",
    kind: "write",
    description: "Edit an existing card's title and/or notes. Needs the card id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" }, notes: { type: "string" } },
      required: ["id"],
    },
    run: (env, a) =>
      editCard(
        env,
        {
          id: str(a.id),
          title: a.title === undefined ? undefined : str(a.title),
          notes: a.notes === undefined ? undefined : a.notes == null ? null : str(a.notes),
        },
        "assistant",
      ),
    summarize: (a) => `Edit card ${str(a.id)}`,
  },
  {
    name: "delete_card",
    kind: "write",
    description: "Delete a card from the board. Needs the card id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: (env, a) => deleteCard(env, { id: str(a.id) }, "assistant"),
    summarize: (a) => `Delete card ${str(a.id)}`,
  },
];

export const TOOLS_BY_NAME: Record<string, AgentTool> = Object.fromEntries(
  AGENT_TOOLS.map((t) => [t.name, t]),
);

/** OpenAI-format `tools` array for the Workers AI chat/completions request. */
export function openAiToolSpec() {
  return AGENT_TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
