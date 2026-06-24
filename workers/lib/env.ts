/**
 * Per-fork environment bindings for My Dashboard.
 *
 * Each recipient fork gets its OWN D1 (DB), R2 (BUCKET), KV (KV) and Workers AI
 * (AI) — physically isolated by construction (L2). `wrangler types` regenerates a
 * global `Env` from wrangler.jsonc; `AppEnv` is the hand-written contract the
 * server code depends on so it typechecks independently of codegen and documents
 * the CF Access + MCP fields that live as vars/secrets rather than bindings.
 */
export interface AppEnv {
  /** Cloudflare D1 (SQLite) — this fork's data store. */
  DB: D1Database;
  /** Cloudflare R2 — this fork's object/file store. */
  BUCKET: R2Bucket;
  /** Cloudflare KV — settings cache + migration single-flight lock. */
  KV: KVNamespace;
  /** Cloudflare Workers AI — default zero-config assistant model. */
  AI: Ai;
  /** Static assets binding (managed by the Cloudflare Vite plugin build). */
  ASSETS?: Fetcher;

  // ---- CF Access (set per fork at provisioning; absent → auth fails closed) ----
  /** This fork's owner email (full access, lockout-safe). */
  TENANT_OWNER_EMAIL?: string;
  /** CF Access team domain, e.g. your-team.cloudflareaccess.com (JWKS issuer base). */
  ACCESS_TEAM_DOMAIN?: string;
  /** CF Access Application Audience (AUD) tag for this fork's app. */
  ACCESS_AUD?: string;
  /** Comma-separated allow-list of authorized emails (owner always included). */
  ACCESS_ALLOWED_EMAILS?: string;

  // ---- Agent / MCP seam ----
  /** Scoped per-fork bearer token for the MCP control plane (P3). */
  MCP_BEARER?: string;
}
