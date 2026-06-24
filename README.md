# My Dashboard

A productized, **shareable** personal dashboard. Every recipient runs their **own
fork** — their own Cloudflare D1 + R2 + KV, **physically isolated by construction
(L2)**. Built on Cloudflare Workers (React Router 7 SSR + Hono) from the
[`react-router-hono-fullstack-template`](https://github.com/cloudflare/templates/tree/main/react-router-hono-fullstack-template)
base, porting proven modules from the original single-tenant dashboard.

## One-click fork

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aitheroad-dev/my-dashboard-app)

Clicking the button stands up a brand-new, isolated fork: Cloudflare auto-provisions
a fresh D1 database, R2 bucket and KV namespace (resource IDs are intentionally
omitted from `wrangler.jsonc`, so each click provisions its own), runs the build, and
deploys. No terminal, no config files.

> The repo URL in the button is finalized when the GitHub remote is created.

## Develop

```bash
bun install
bun run dev        # react-router dev (workerd via @cloudflare/vite-plugin)
bun run migrate    # apply pending D1 migrations (--local default; --remote for prod)
bun run typecheck
bun run build
```

> Deploys must run under **node**, not bun, on this machine — `wrangler` hangs its
> upload under bun. Use `/opt/homebrew/bin/node ./node_modules/wrangler/bin/wrangler.js deploy`
> wrapped in `script -q /dev/null` (no stdout redirect, no pipe).

## Architecture

- **Runtime:** one Worker per fork = React Router (SSR) + Hono `/api/*` + Static Assets.
- **Data:** D1 (`DB`) via `getDb(env)` tagged-template SQL — `workers/lib/db.ts`.
- **Auth:** Cloudflare Access — `workers/lib/auth.ts` verifies the signed JWT against the
  team JWKS (issuer + audience + signature), never the spoofable header.
- **Migrations:** idempotent runner (`workers/lib/migrate.ts`) + boot-guard + `bun run migrate`.
- **Config:** single versioned `settings` row (P1).
- **Bindings:** `DB` (D1), `BUCKET` (R2), `KV` (KV), `AI` (Workers AI).

See [`ISA.md`](./ISA.md) for the full living spec and the phased build plan (P0–P5).
