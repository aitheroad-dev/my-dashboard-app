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
  "assistant",
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

const KNOWN_PAGES = new Set<string>(PAGE_KEYS);

/** Pages a brand-new fork shows by default — the six v1 pages (Tools shows a
 * "not configured" state until the recipient adds their key). */
export const DEFAULT_ENABLED: PageKey[] = [
  "home",
  "projects",
  "goals",
  "portfolio",
  "tools",
  "kb",
  "assistant",
];

/** Pages that can never be turned off — a fork must always have a landing. Enforced
 * in normalizeConfig so NO write path (UI save, import, future default) can ship a
 * fork with no home page. */
export const ALWAYS_ON_PAGES: PageKey[] = ["home"];

export const ThemeSchema = z.enum(["light", "dark", "system"]).catch("system");
export type Theme = z.infer<typeof ThemeSchema>;

export const ConfigSchema = z.object({
  schemaVersion: z.number().int().catch(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
  display_name: z.string().catch("My Dashboard").default("My Dashboard"),
  theme: ThemeSchema.default("system"),
  // Forgiving arrays: unknown/foreign keys are tolerated and filtered in
  // normalizeConfig — this is what makes additive page evolution non-breaking.
  // NOTE (zod v4): `.default()` only fires on `undefined`; a present-but-wrong-type
  // value (non-array, or a non-string element) THROWS without `.catch()`. The
  // `.catch()` is load-bearing — it keeps a corrupted/old stored config from
  // 500-ing /api/settings (invariant: an old/garbage config never throws).
  enabled_pages: z.array(z.string()).catch([...DEFAULT_ENABLED]).default([...DEFAULT_ENABLED]),
  page_order: z.array(z.string()).catch([...PAGE_KEYS]).default([...PAGE_KEYS]),
  // Optional OpenAI key for multilingual (incl. Hebrew) text-to-speech. Stored
  // server-side in this fork's own D1, redacted from every client response, never
  // sent to the browser. Absent → TTS falls back to Workers AI MeloTTS (English).
  openai_key: z.string().nullable().catch(null).default(null),
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
  const base = enabled.length > 0 ? enabled : [...DEFAULT_ENABLED];
  // Always-on pages are forced enabled (in page_order position) no matter what was
  // stored/imported — a fork can never be saved without its landing page.
  const withAlwaysOn = uniq([
    ...order.filter((k) => ALWAYS_ON_PAGES.includes(k) || base.includes(k)),
  ]) as PageKey[];
  return {
    ...parsed,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    enabled_pages: withAlwaysOn,
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

  // Per-field `.catch()` makes parse throw-proof for type errors; this guard is
  // belt-and-suspenders for any shape we didn't anticipate — migrateConfig never throws.
  let parsed: Config;
  try {
    parsed = ConfigSchema.parse(obj); // defaults fill every gap
  } catch {
    parsed = ConfigSchema.parse({ schemaVersion: CURRENT_SCHEMA_VERSION });
  }
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
