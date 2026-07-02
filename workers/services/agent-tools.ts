import type { AppEnv } from "../lib/env";
import {
  ACTIVE_FIELD_TYPES,
  CURRENT_SPEC_VERSION,
  type ActiveFieldType,
  type FieldSpec,
  type Plan,
} from "../lib/spec/schema";
import { buildTemplatePlan, slugifyKey, type TemplateKey } from "./spec-catalog";
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
  normalizeDueDate,
  normalizePriority,
  parseLabels,
  parseChecklist,
} from "./store";

/**
 * Agent tool registry (P3 Slice 3b, ISC-79/81). The built-in Assistant's
 * tool-calling loop dispatches through this single table; each tool calls the SAME
 * `store.ts` service functions the MCP control plane and the HTTP routes use (ISC-45).
 *
 * `kind` is the security boundary:
 *  - "read"    → executed immediately inside the loop.
 *  - "write"   → NEVER executed by the model. The loop only PROPOSES a write; it runs
 *                only after the authenticated owner confirms it in the UI (see
 *                runAssistant's `confirm` path). Writes carry actor "assistant" and the
 *                store commits the data change + exactly one mcp_activity audit row.
 *  - "declare" → builds a persisted spec Plan for owner approval; it has no direct run.
 */

export type ToolKind = "read" | "write" | "declare";

export interface AgentTool {
  name: string;
  kind: ToolKind;
  description: string;
  /** JSON Schema for the function arguments (OpenAI tools format). */
  parameters: Record<string, unknown>;
  run?: (env: AppEnv, args: Record<string, unknown>, actor?: string) => Promise<unknown>;
  buildPlan?: (args: Record<string, unknown>) => Plan;
  /** Human-readable one-liner for the Confirm card + audit-facing text. */
  summarize: (args: Record<string, unknown>) => string;
}

const CARD_STATUS = { type: "string", enum: ["todo", "in_progress", "done"] };
const CARD_PRIORITY = { type: "string", enum: ["none", "low", "medium", "high"] };
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((item) => typeof item === "string") : []);

type FieldInput = {
  key?: unknown;
  label?: unknown;
  type?: unknown;
  required?: unknown;
  unique?: unknown;
  options?: unknown;
};

function inputField(raw: unknown): FieldInput {
  return raw && typeof raw === "object" ? (raw as FieldInput) : {};
}

function toFieldSpec(raw: unknown): FieldSpec {
  const field = inputField(raw);
  const type = str(field.type) as ActiveFieldType;
  return {
    specVersion: CURRENT_SPEC_VERSION,
    key: str(field.key),
    label: str(field.label) || str(field.key),
    type,
    required: Boolean(field.required),
    unique: Boolean(field.unique),
    ...(type === "single_select" ? { config: { options: strArray(field.options) } } : {}),
  };
}

// ---- Richer-card enrichment (ISC-83.13..): due_date / priority / labels / checklist.
// The model proposes model-friendly shapes; store.ts re-validates + bounds everything.

// Fixed 7-colour label palette — mirrors app/routes/board.tsx so an Assistant-made
// label looks identical to a hand-made one. The model proposes label NAMES; we assign
// a STABLE on-palette colour by hashing the name (store.parseLabels colour-validates).
const LABEL_PALETTE = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#64748b"];
function paletteColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return LABEL_PALETTE[h % LABEL_PALETTE.length];
}
/** Accept the model-friendly `["Home","Urgent"]` shape (→ {name,color}) OR pass-through
 * `{name,color}` objects. store.parseLabels then bounds (≤12) + colour-validates. */
function toLabels(raw: unknown): Array<{ name: string; color: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => {
      if (typeof l === "string") {
        const name = l.trim();
        return { name, color: paletteColor(name) };
      }
      if (l && typeof l === "object") {
        const name = String((l as { name?: unknown }).name ?? "").trim();
        const color = String((l as { color?: unknown }).color ?? "") || paletteColor(name);
        return { name, color };
      }
      return { name: "", color: "" };
    })
    .filter((l) => l.name);
}
/** Accept `["Buy milk","Bread"]` (each unchecked) OR `{text,done}` objects. */
function toChecklist(raw: unknown): Array<{ text: string; done: boolean }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((i) => {
      if (typeof i === "string") return { text: i.trim(), done: false };
      if (i && typeof i === "object") {
        return {
          text: String((i as { text?: unknown }).text ?? "").trim(),
          done: Boolean((i as { done?: unknown }).done),
        };
      }
      return { text: "", done: false };
    })
    .filter((i) => i.text);
}
/** Map the model's raw enrichment args → the EXACT values that will persist: run them
 * through store's own sanitizers here so (1) store re-parsing is idempotent and (2)
 * describeEnrichment can show the owner precisely what the confirmed write commits — no
 * "confirm shows X, writes Y" gap (Forge B). The "field absent ⇒ undefined ⇒ keep
 * current" contract is preserved (edit_card stays additive; store.editCard now writes
 * ONLY the provided columns → no clobber of a concurrent edit, ISC-83.14). */
function enrichmentFields(a: Record<string, unknown>) {
  return {
    due_date: a.due_date === undefined ? undefined : normalizeDueDate(a.due_date),
    priority: a.priority === undefined ? undefined : normalizePriority(a.priority),
    labels: a.labels === undefined ? undefined : parseLabels(toLabels(a.labels)),
    checklist: a.checklist === undefined ? undefined : parseChecklist(toChecklist(a.checklist)),
  };
}

/** Human-readable parts describing the SANITIZED enrichment a write will persist — the
 * single source of truth for the Confirm card, so its text == the committed result
 * (never "due tomorrow" while writing null, or 13 labels while writing 12). Only fields
 * the model actually sent appear (undefined ⇒ untouched). */
export function describeEnrichment(a: Record<string, unknown>): string[] {
  const f = enrichmentFields(a);
  const parts: string[] = [];
  if (f.due_date !== undefined) parts.push(f.due_date ? `due ${f.due_date}` : "due date cleared");
  if (f.priority !== undefined) parts.push(`priority ${f.priority}`);
  if (f.labels !== undefined)
    parts.push(f.labels.length ? `labels: ${f.labels.map((l) => l.name).join(", ")}` : "labels cleared");
  if (f.checklist !== undefined)
    parts.push(
      f.checklist.length ? `checklist (${f.checklist.length} item${f.checklist.length === 1 ? "" : "s"})` : "checklist cleared",
    );
  return parts;
}
const ENRICHMENT_PARAMS = {
  due_date: { type: "string", description: "Due date as YYYY-MM-DD; empty string clears it." },
  priority: CARD_PRIORITY,
  labels: { type: "array", items: { type: "string" }, description: 'Short label names, e.g. ["Home","Urgent"].' },
  checklist: { type: "array", items: { type: "string" }, description: "Checklist item texts; each starts unchecked." },
};

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
    description:
      "Add a new card to the board (defaults to the To Do column). You can also set a due date (YYYY-MM-DD), priority (low/medium/high), labels, and a checklist.",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, notes: { type: "string" }, status: CARD_STATUS, ...ENRICHMENT_PARAMS },
      required: ["title"],
    },
    run: (env, a, actor) =>
      addCard(
        env,
        {
          title: str(a.title),
          notes: a.notes == null ? null : str(a.notes),
          status: str(a.status) || undefined,
          ...enrichmentFields(a),
        },
        actor || "assistant",
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
    run: (env, a, actor) => moveCard(env, { id: str(a.id), status: str(a.status) }, actor || "assistant"),
    summarize: (a) => `Move card ${str(a.id)} to ${str(a.status)}`,
  },
  {
    name: "edit_card",
    kind: "write",
    description:
      "Edit an existing card. Send ONLY the fields to change (title, notes, due date, priority, labels, checklist) — omitted fields are kept as-is. Needs the card id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" }, notes: { type: "string" }, ...ENRICHMENT_PARAMS },
      required: ["id"],
    },
    run: (env, a, actor) =>
      editCard(
        env,
        {
          id: str(a.id),
          title: a.title === undefined ? undefined : str(a.title),
          notes: a.notes === undefined ? undefined : a.notes == null ? null : str(a.notes),
          ...enrichmentFields(a),
        },
        actor || "assistant",
      ),
    summarize: (a) => `Edit card ${str(a.id)}`,
  },
  {
    name: "delete_card",
    kind: "write",
    description: "Delete a card from the board. Needs the card id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: (env, a, actor) => deleteCard(env, { id: str(a.id) }, actor || "assistant"),
    summarize: (a) => `Delete card ${str(a.id)}`,
  },

  // ---------- DECLARES (persisted spec plans; run only after owner applies plan) ----------
  {
    name: "apply_template",
    kind: "declare",
    description: "Prepare a built-in page/data-structure template for owner approval. This proposes a spec plan; it does not apply it.",
    parameters: {
      type: "object",
      properties: {
        template: { type: "string", enum: ["clients_crm", "sessions_log", "meetings_tracker"] },
        page_title: { type: "string" },
      },
      required: ["template"],
    },
    buildPlan: (a) => buildTemplatePlan(str(a.template) as TemplateKey, { page_title: str(a.page_title) || undefined }),
    summarize: (a) => `Create the ${str(a.template)} page`,
  },
  {
    name: "propose_page",
    kind: "declare",
    description: "Prepare a custom list page and its data type for owner approval. This proposes a spec plan; it does not apply it.",
    parameters: {
      type: "object",
      properties: {
        entity_key: { type: "string" },
        singular: { type: "string" },
        plural: { type: "string" },
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              type: { type: "string", enum: ACTIVE_FIELD_TYPES },
              required: { type: "boolean" },
              unique: { type: "boolean" },
              options: { type: "array", items: { type: "string" } },
            },
            required: ["key", "label", "type"],
          },
        },
        view_name: { type: "string" },
        page_title: { type: "string" },
      },
      required: ["entity_key", "singular", "plural", "fields"],
    },
    buildPlan: (a) => {
      const entityKey = str(a.entity_key);
      const plural = str(a.plural);
      const pageTitle = str(a.page_title) || plural;
      const fields = Array.isArray(a.fields) ? a.fields.map(toFieldSpec) : [];
      const viewKey = `${entityKey}_list`;
      return {
        specVersion: CURRENT_SPEC_VERSION,
        actions: [
          {
            type: "add_entity",
            additive: true,
            entity: {
              specVersion: CURRENT_SPEC_VERSION,
              key: entityKey,
              singular: str(a.singular),
              plural,
              fields,
            },
          },
          {
            type: "add_view",
            additive: true,
            entity_key: entityKey,
            view: {
              specVersion: CURRENT_SPEC_VERSION,
              key: viewKey,
              kind: "list",
              name: str(a.view_name) || `All ${plural}`,
              config: { visible_fields: fields.map((field) => field.key).slice(0, 8) },
            },
          },
          {
            type: "add_page",
            additive: true,
            page: {
              specVersion: CURRENT_SPEC_VERSION,
              key: slugifyKey(pageTitle, entityKey),
              title: pageTitle,
              views: [{ entity_key: entityKey, view_key: viewKey }],
            },
          },
        ],
      };
    },
    summarize: (a) => `Create a ${str(a.plural)} page`,
  },
  {
    name: "add_field",
    kind: "declare",
    description: "Prepare a field addition for an existing data type. This proposes a spec plan; it does not apply it.",
    parameters: {
      type: "object",
      properties: {
        entity_key: { type: "string" },
        field: {
          type: "object",
          properties: {
            key: { type: "string" },
            label: { type: "string" },
            type: { type: "string", enum: ACTIVE_FIELD_TYPES },
            required: { type: "boolean" },
            unique: { type: "boolean" },
            options: { type: "array", items: { type: "string" } },
          },
          required: ["key", "label", "type"],
        },
      },
      required: ["entity_key", "field"],
    },
    buildPlan: (a) => ({
      specVersion: CURRENT_SPEC_VERSION,
      actions: [{ type: "add_field", additive: true, entity_key: str(a.entity_key), field: toFieldSpec(a.field) }],
    }),
    summarize: (a) => `Add field ${toFieldSpec(a.field).key} to ${str(a.entity_key)}`,
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
