import {
  CURRENT_SPEC_VERSION,
  type EntitySpec,
  type FieldSpec,
  type PageSpec,
  type Plan,
  type ViewSpec,
} from "../lib/spec/schema";

export const TEMPLATE_KEYS = ["clients_crm", "sessions_log", "meetings_tracker"] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];
export type TemplateOverrides = { page_title?: string };

export function slugifyKey(raw: string, fallback: string): string {
  const clean = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
  const base = clean(raw);
  const prefix = /^[a-z]/.test(clean(fallback)) ? clean(fallback) : "page";
  const withStart = /^[a-z]/.test(base) ? base : `${prefix}_${base}`;
  const clamped = withStart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 63)
    .replace(/_+$/g, "");
  return /^[a-z][a-z0-9_]{0,62}$/.test(clamped) ? clamped : "page";
}

export function buildTemplatePlan(key: TemplateKey, overrides?: TemplateOverrides): Plan {
  switch (key) {
    case "clients_crm":
      return clientsCrmPlan(overrides);
    case "sessions_log":
      return sessionsLogPlan(overrides);
    case "meetings_tracker":
      return meetingsTrackerPlan(overrides);
    default:
      throw new Error(`unknown template ${key}`);
  }
}

function field(key: string, label: string, type: FieldSpec["type"], required = false, unique = false, options?: string[]): FieldSpec {
  return {
    specVersion: CURRENT_SPEC_VERSION,
    key,
    label,
    type,
    required,
    unique,
    ...(type === "single_select" ? { config: { options: options ?? [] } } : {}),
  };
}

function templatePlan(entity: EntitySpec, view: ViewSpec, page: PageSpec): Plan {
  return {
    specVersion: CURRENT_SPEC_VERSION,
    actions: [
      { type: "add_entity", additive: true, entity },
      { type: "add_view", additive: true, entity_key: entity.key, view },
      { type: "add_page", additive: true, page },
    ],
  };
}

function clientsCrmPlan(overrides?: TemplateOverrides): Plan {
  const entity: EntitySpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "client",
    singular: "Client",
    plural: "Clients",
    fields: [
      field("name", "Name", "text", true, false),
      field("email", "Email", "text", false, true),
      field("phone", "Phone", "text", false, false),
      field("status", "Status", "single_select", false, false, ["Active", "Archived"]),
      field("notes", "Notes", "long_text", false, false),
    ],
  };
  const view: ViewSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "client_list",
    kind: "list",
    name: "All Clients",
    config: { visible_fields: ["name", "email", "status"] },
  };
  const page: PageSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "clients",
    title: overrides?.page_title ?? "Clients",
    icon: "👥",
    views: [{ entity_key: "client", view_key: "client_list" }],
  };
  return templatePlan(entity, view, page);
}

function sessionsLogPlan(overrides?: TemplateOverrides): Plan {
  const entity: EntitySpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "session",
    singular: "Session",
    plural: "Sessions",
    fields: [
      field("title", "Title", "text", true, false),
      field("date", "Date", "date", false, false),
      field("summary", "Summary", "long_text", false, false),
    ],
  };
  const view: ViewSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "session_list",
    kind: "list",
    name: "All Sessions",
    config: { visible_fields: ["title", "date"] },
  };
  const page: PageSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "sessions",
    title: overrides?.page_title ?? "Sessions",
    icon: "📝",
    views: [{ entity_key: "session", view_key: "session_list" }],
  };
  return templatePlan(entity, view, page);
}

function meetingsTrackerPlan(overrides?: TemplateOverrides): Plan {
  const entity: EntitySpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "meeting",
    singular: "Meeting",
    plural: "Meetings",
    fields: [
      field("title", "Title", "text", true, false),
      field("date", "Date", "date", false, false),
      field("attendees", "Attendees", "text", false, false),
      field("notes", "Notes", "long_text", false, false),
    ],
  };
  const view: ViewSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "meeting_list",
    kind: "list",
    name: "All Meetings",
    config: { visible_fields: ["title", "date", "attendees"] },
  };
  const page: PageSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "meetings",
    title: overrides?.page_title ?? "Meetings",
    icon: "📅",
    views: [{ entity_key: "meeting", view_key: "meeting_list" }],
  };
  return templatePlan(entity, view, page);
}
