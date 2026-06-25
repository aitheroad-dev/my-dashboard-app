import { Hono } from "hono";
import { createRequestHandler } from "react-router";
import type { AppEnv } from "./lib/env";
import { runMigrations } from "./lib/migrate";
import { getViewer } from "./lib/viewer";
import { data } from "./api/data";

const app = new Hono<{ Bindings: AppEnv }>();

// --- Boot-guard: apply pending D1 migrations once per isolate. The single-flight
// lock lives in runMigrations() so concurrent first requests cannot double-apply. ---
let migrated = false;
async function ensureMigrations(env: AppEnv): Promise<void> {
  if (migrated) return;
  await runMigrations(env);
  migrated = true;
}

// Public health check — the ONE documented unauthenticated /api route. No auth,
// no migration dependency, so a fork is probeable before first data access. The
// bindings map distinguishes "not provisioned" from "healthy" for fork diagnosis.
app.get("/api/health", (c) => {
  const env = c.env;
  const bindings = {
    db: Boolean(env.DB),
    bucket: Boolean(env.BUCKET),
    kv: Boolean(env.KV),
    ai: Boolean(env.AI),
  };
  const ok = Object.values(bindings).every(Boolean);
  return c.json({ ok, ts: new Date().toISOString(), bindings });
});

// Auth gate for every other /api/* route. Also ensures the schema exists before
// any data access (boot-guard). Registered AFTER /api/health so health bypasses it.
app.use("/api/*", async (c, next) => {
  await ensureMigrations(c.env);
  await next();
});

// Identity via the viewer seam: an Access-configured fork requires a verified
// allow-listed user (else 401); a fork without Access yet returns the owner in
// open-dev mode so the dashboard is usable on a bare workers.dev fork / locally.
app.get("/api/me", async (c) => {
  const viewer = await getViewer(c.req.raw, c.env);
  if (!viewer) return c.json({ error: "unauthorized" }, 401);
  return c.json({ email: viewer.email, isOwner: viewer.isOwner, mode: viewer.mode });
});

// P1 data routes (projects/goals/portfolio/settings). The /api/* migration
// boot-guard above already ran for these paths; mounted before the SSR catch-all.
app.route("/api", data);

// React Router SSR catch-all — must stay last.
app.get("*", (c) => {
  const requestHandler = createRequestHandler(
    () => import("virtual:react-router/server-build"),
    import.meta.env.MODE,
  );

  return requestHandler(c.req.raw, {
    cloudflare: { env: c.env, ctx: c.executionCtx },
  });
});

export default app;
