import {
  CURRENT_SPEC_VERSION,
  type EntitySpec,
  type FieldSpec,
  type PageSpec,
  type Plan,
  type ViewSpec,
} from "../lib/spec/schema";

export const TEMPLATE_KEYS = [
  "clients_crm",
  "sessions_log",
  "meetings_tracker",
  "situation_log",
  "holdings",
  "listings",
  "advisor_corpus",
  "site_registry",
] as const;
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
    case "situation_log":
      return situationLogPlan(overrides);
    case "holdings":
      return holdingsPlan(overrides);
    case "listings":
      return listingsPlan(overrides);
    case "advisor_corpus":
      return advisorCorpusPlan(overrides);
    case "site_registry":
      return siteRegistryPlan(overrides);
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

// W1 templates (recipient doctrine R1): generic page shapes matching common "life data"
// streams — a work journal, investment holdings, tracked listings, claim tracking, and a
// site/link registry. All active field types + list views only; every fork gets them.

function situationLogPlan(overrides?: TemplateOverrides): Plan {
  const entity: EntitySpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "journal_entry",
    singular: "Journal entry",
    plural: "Journal entries",
    fields: [
      field("title", "Title", "text", true, false),
      field("date", "Date", "date", false, false),
      field("kind", "Kind", "single_select", false, false, ["work", "decision", "milestone", "note"]),
      field("project", "Project", "text", false, false),
      field("details", "Details", "long_text", false, false),
    ],
  };
  const view: ViewSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "journal_entry_list",
    kind: "list",
    name: "All entries",
    config: { visible_fields: ["title", "date", "kind", "project"], sort: { field: "date", direction: "desc" } },
  };
  const page: PageSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "journal",
    title: overrides?.page_title ?? "Journal",
    icon: "🗒️",
    views: [{ entity_key: "journal_entry", view_key: "journal_entry_list" }],
  };
  return templatePlan(entity, view, page);
}

function holdingsPlan(overrides?: TemplateOverrides): Plan {
  const entity: EntitySpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "holding",
    singular: "Holding",
    plural: "Holdings",
    fields: [
      field("name", "Name", "text", true, false),
      field("ticker", "Ticker", "text", false, false),
      field("quantity", "Quantity", "number", false, false),
      field("currency", "Currency", "single_select", false, false, ["EUR", "USD", "GBP", "ILS", "other"]),
      field("value", "Value", "number", false, false),
      field("notes", "Notes", "long_text", false, false),
    ],
  };
  const view: ViewSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "holding_list",
    kind: "list",
    name: "All holdings",
    config: { visible_fields: ["name", "ticker", "quantity", "currency", "value"] },
  };
  const page: PageSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "holdings",
    title: overrides?.page_title ?? "Holdings",
    icon: "💼",
    views: [{ entity_key: "holding", view_key: "holding_list" }],
  };
  return templatePlan(entity, view, page);
}

function listingsPlan(overrides?: TemplateOverrides): Plan {
  const entity: EntitySpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "listing",
    singular: "Listing",
    plural: "Listings",
    fields: [
      field("title", "Title", "text", true, false),
      field("url", "URL", "text", false, false),
      field("price", "Price", "number", false, false),
      field("location", "Location", "text", false, false),
      field("status", "Status", "single_select", false, false, ["new", "watching", "contacted", "rejected", "done"]),
      field("date", "Date", "date", false, false),
      field("notes", "Notes", "long_text", false, false),
    ],
  };
  const view: ViewSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "listing_list",
    kind: "list",
    name: "All listings",
    config: { visible_fields: ["title", "price", "location", "status", "date"] },
  };
  const page: PageSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "listings",
    title: overrides?.page_title ?? "Listings",
    icon: "🏠",
    views: [{ entity_key: "listing", view_key: "listing_list" }],
  };
  return templatePlan(entity, view, page);
}

function advisorCorpusPlan(overrides?: TemplateOverrides): Plan {
  const entity: EntitySpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "advisor_claim",
    singular: "Claim",
    plural: "Claims",
    fields: [
      field("advisor", "Advisor", "text", true, false),
      field("claim", "Claim", "long_text", true, false),
      field("source", "Source", "text", false, false),
      field("date", "Date", "date", false, false),
      field("verdict", "Verdict", "single_select", false, false, ["pending", "true", "false", "mixed"]),
      field("notes", "Notes", "long_text", false, false),
    ],
  };
  const view: ViewSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "advisor_claim_list",
    kind: "list",
    name: "All claims",
    config: { visible_fields: ["advisor", "claim", "date", "verdict"], sort: { field: "date", direction: "desc" } },
  };
  const page: PageSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "advisor_claims",
    title: overrides?.page_title ?? "Advisor Claims",
    icon: "📈",
    views: [{ entity_key: "advisor_claim", view_key: "advisor_claim_list" }],
  };
  return templatePlan(entity, view, page);
}

function siteRegistryPlan(overrides?: TemplateOverrides): Plan {
  const entity: EntitySpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "site",
    singular: "Site",
    plural: "Sites",
    fields: [
      field("name", "Name", "text", true, false),
      field("url", "URL", "text", true, false),
      field("kind", "Kind", "single_select", false, false, ["app", "static", "tool", "demo"]),
      field("status", "Status", "single_select", false, false, ["live", "paused", "dead"]),
      field("notes", "Notes", "long_text", false, false),
    ],
  };
  const view: ViewSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "site_list",
    kind: "list",
    name: "All sites",
    config: { visible_fields: ["name", "url", "kind", "status"] },
  };
  const page: PageSpec = {
    specVersion: CURRENT_SPEC_VERSION,
    key: "sites",
    title: overrides?.page_title ?? "Sites",
    icon: "🌐",
    views: [{ entity_key: "site", view_key: "site_list" }],
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
