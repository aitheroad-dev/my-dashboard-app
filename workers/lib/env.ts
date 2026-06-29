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

  // ---- Tools (native; run on this fork's own AI binding) ----
  /** Optional OpenAI key for multilingual (incl. Hebrew) text-to-speech, used ONLY
   * server-side, never sent to the browser. A per-fork `config.openai_key` (Settings)
   * takes precedence; this secret is the fork-wide fallback. Absent → English MeloTTS. */
  OPENAI_API_KEY?: string;

  // ---- Agent / MCP seam ----
  /** Scoped per-fork bearer token for the MCP control plane (P3). */
  MCP_BEARER?: string;

  // ---- Assistant (P3 Slice 2, ISC-44) ----
  /** Workers AI text model id for the assistant (default: a Llama instruct model). */
  ASSISTANT_MODEL?: string;
  /** Opt-in: Anthropic API key — used ONLY server-side via AI Gateway, never sent to the browser. */
  ANTHROPIC_API_KEY?: string;
  /** Opt-in: Cloudflare AI Gateway base URL
   *  (https://gateway.ai.cloudflare.com/v1/<account>/<gateway>); Anthropic is called
   *  at <base>/anthropic/v1/messages. Required alongside ANTHROPIC_API_KEY. */
  AI_GATEWAY_BASE_URL?: string;
}
