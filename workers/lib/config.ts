import { z } from "zod";

/**
 * Versioned per-fork config (the customization spine).
 *
 * A single `settings` row holds `config` as JSON TEXT. The contract that keeps a
 * fork already in the wild from breaking on a later release:
 *   1. EVERY field has `.default()` — a partial/old blob parses to a full config.
 *   2. `schemaVersion` is embedded; `migrateConfig()` walks old → current.
 *   3. Page-key arrays are forgiving (`z.string()` + post-parse normalize), so an
 *      additive new page key in a config written by a newer fork never throws on
 *      an older one — it is simply dropped if unknown. (ISC-32, ISC-36, ISC-37.)
 */

export const CURRENT_SCHEMA_VERSION = 1;

/** v1 page set. Adding a key here is additive — never renumber/remove silently. */
export const PAGE_KEYS = [
  "home",
  "projects",
  "goals",
  "portfolio",
  "tools",
  "kb",
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

const KNOWN_PAGES = new Set<string>(PAGE_KEYS);

/** Pages a brand-new fork shows by default (Tools/KB land in P2; off until built). */
export const DEFAULT_ENABLED: PageKey[] = ["home", "projects", "goals", "portfolio"];

export const ThemeSchema = z.enum(["light", "dark", "system"]).catch("system");
export type Theme = z.infer<typeof ThemeSchema>;

export const ConfigSchema = z.object({
  schemaVersion: z.number().int().catch(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
  display_name: z.string().catch("My Dashboard").default("My Dashboard"),
  theme: ThemeSchema.default("system"),
  // Forgiving arrays: unknown/foreign keys are tolerated at parse time and filtered
  // in normalizeConfig — this is what makes additive page evolution non-breaking.
  enabled_pages: z.array(z.string()).default([...DEFAULT_ENABLED]),
  page_order: z.array(z.string()).default([...PAGE_KEYS]),
  tools_key: z.string().nullable().catch(null).default(null),
  prefs: z.record(z.string(), z.unknown()).catch({}).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Post-parse normalization: keep only known page keys, dedupe, and ensure
 * page_order covers every known page (enabled first, then the rest) so the
 * sidebar is always deterministic regardless of what was stored.
 */
export function normalizeConfig(parsed: Config): Config {
  const enabled = uniq(parsed.enabled_pages.filter((k) => KNOWN_PAGES.has(k))) as PageKey[];
  const orderKnown = uniq(parsed.page_order.filter((k) => KNOWN_PAGES.has(k))) as PageKey[];
  const order = uniq([...orderKnown, ...PAGE_KEYS]) as PageKey[];
  return {
    ...parsed,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    enabled_pages: enabled.length > 0 ? enabled : [...DEFAULT_ENABLED],
    page_order: order,
  };
}

/**
 * Walk any stored/old/partial blob up to the current schema, then parse with
 * defaults and normalize. Never throws on a well-formed-ish object — bad shapes
 * fall back to defaults field-by-field via `.catch()`.
 */
export function migrateConfig(raw: unknown): Config {
  const obj: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};

  // Stepwise migrations land here as the schema grows, e.g.:
  //   if (version < 2) { obj.newField = derive(obj); version = 2; }
  // v1 is current, so there is nothing to step yet.
  obj.schemaVersion = CURRENT_SCHEMA_VERSION;

  const parsed = ConfigSchema.parse(obj); // defaults fill every gap
  return normalizeConfig(parsed);
}

/** The config a fresh fork starts from. */
export const DEFAULT_CONFIG: Config = migrateConfig({});

/** Ordered list of enabled page keys — drives the sidebar + route gating. */
export function resolvePages(config: Config): PageKey[] {
  const enabled = new Set(config.enabled_pages);
  return config.page_order.filter((k) => enabled.has(k)) as PageKey[];
}

/** Shallow-merge a partial patch over a base config, then re-validate + migrate. */
export function mergeConfig(base: Config, patch: unknown): Config {
  const p =
    patch && typeof patch === "object" && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {};
  return migrateConfig({ ...base, ...p });
}
