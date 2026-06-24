---
project: My Dashboard
task: Build the shareable per-fork personal dashboard (productized "give-it-to-anyone")
slug: my-dashboard
effort: E3
phase: build
progress: 0/53
mode: ALGORITHM
started: 2026-06-24
updated: 2026-06-24
---

# My Dashboard — Project ISA (system of record)

> Built from the FINAL adopted plan: `~/Plans/my-dashboard-build-plan.md` (my draft + Ultraplan, reviewed together).
> Repo home: `~/Projects/my-dashboard-app` (fresh build; the old clone-fork `~/Projects/my-dashboard` is set aside as reference).
> The project's higher-level system of record is `~/.claude/PAI/USER/PROJECTS/MY_DASHBOARD/PROJECT.md`; this ISA is the build's living spec.

## Problem

Yaron's dashboard (`my-jarvis-dashboard-yaron`) is a single-tenant personal tool. He wants a **productized, shareable** version: a thing he can hand to any person (5–50 hand-picked recipients) who then runs and adapts it as **their own per-person fork**, with physical data isolation, near-zero ongoing maintenance for the giver, and a genuinely non-technical handoff. The existing single-tenant data layer (no `owner_id`, queries return all rows) makes a multi-tenant SaaS (L3) a permanent cross-tenant-leak risk; the council chose **L2 physical isolation** (one D1 + one R2 + one Worker per recipient). No clean OSS drop-in exists, so the build is fresh on a Cloudflare-native stack — but ports proven modules from the existing repo rather than green-fielding.

## Vision

A non-technical person clicks one "Deploy to Cloudflare" button, authorizes once, and 60 seconds later has their **own** dashboard at their own URL — their own database, their own files, isolated by construction from everyone else's. It just works: every page shows real or gracefully-empty content, never a blank screen. The giver maintains the whole fleet from one re-runnable script. Euphoric surprise = "I gave this to someone and they made it theirs without me touching anything."

## Out of Scope

- Multi-tenant shared-query SaaS (L3) — explicitly rejected; isolation is physical, not by query filter.
- Refine / heavyweight CRUD framework — bare TanStack Query over Hono instead.
- Meetings / Vexa / Google-OAuth / per-minute calendar cron in v1 — deferred to P5 (per-fork secrets break the non-technical handoff).
- Memory page — parked (fed only by Yaron's PAI Stop hook; no recipient data source).
- Spend, Move, Rental, Situation, Agents, Skills pages — dropped from the productized scope.
- Instant fleet-wide sync — given up deliberately; the deploy loop is one command.
- Pages / `wrangler.toml` — Cloudflare steers new full-stack apps to Workers + `wrangler.jsonc`.

## Principles

- **Isolation by construction beats isolation by discipline.** A bug in one fork must be physically unable to reach another's data — no shared query path exists to forget a filter on.
- **Reliability → low giver-maintenance → non-technical handoff**, optimized in that order.
- **Port the proven, green-field only the seam.** The existing repo already runs the target stack; reuse `db.ts` unchanged, adapt only what the runtime forces (Pages-Function → Hono).
- **Trust only verified information** — every ISC closes on a tool-verified probe, never "should work."
- **Additive-only evolution after forks ship** — a config/schema change must never break a fork already in the wild.
- **Secrets stay server-side** — keys (`tools_key`, Anthropic key) never reach the browser.

## Constraints

- **Runtime:** one Cloudflare **Worker per fork** = React Router (SSR) + Hono `/api/*` + Static Assets, on `@cloudflare/vite-plugin`. Base = `cloudflare/react-router-hono-fullstack-template` (Hono 4.8.2, React 19.0.0, react-router 7.6.3, vite 6, tailwind 4, wrangler 4.21.x, ts 5.8.3).
- **Config = `wrangler.jsonc`** with binding placeholders + **IDs omitted** (deploy button auto-provisions and writes IDs back to JSONC only — workers-sdk #13632; TOML breaks `wrangler d1 migrations apply --remote`). Load-bearing for both deploy paths.
- **Per-fork bindings:** `DB` (D1), `BUCKET` (R2), `KV` (KV), `AI` (Workers AI). MCP write Durable Object added at P3.
- **Server dir is `workers/`** (template layout), not the plan's `/server/` — port target = `workers/lib/db.ts`, `workers/lib/auth.ts`.
- **Auth:** CF Access (humans) — verify the signed `Cf-Access-Jwt-Assertion` via team JWKS, **never trust a spoofable header**; scoped per-fork bearer for the agent/MCP seam.
- **Data layer:** TanStack Query → Hono `/api/*` → `getDb(env)` tagged-template over D1. No Refine.
- **Config:** single `settings` row (versioned JSON, Zod-validated, every field `.default()`, embedded `schemaVersion` + lazy `migrateConfig`).
- **Toolchain:** **bun** for install/scripts (never npm/npx). **Deploy must run under node**, not bun — `wrangler deploy` hangs mid-upload under bun on this Mac; use `/opt/homebrew/bin/node ./node_modules/wrangler/bin/wrangler.js deploy` wrapped in `script -q /dev/null`, no stdout redirect, no pipe. CF account `a28d6c975f2cf4e25fb2acb10bf4627e`.

## Goal

Ship a fresh Cloudflare-Workers dashboard that any hand-picked recipient can stand up as a physically-isolated per-fork instance via a one-click Deploy button, with versioned per-fork config, six v1 pages (Home, Goals, Projects, Portfolio, Tools, Knowledge Base), an MCP agent control plane (read tools + elicitation-gated writes), and a re-runnable fleet script — built by porting proven modules from `my-jarvis-dashboard-yaron` onto the `react-router-hono-fullstack-template` base. **Done when all ISCs below pass.** The current run targets **P0 (Foundation)**: prove per-fork auto-provisioned isolation + idempotent migrations before any page is ported.

## Criteria

> Numbered sequentially; never re-numbered on edit (splits become ISC-N.M). P0 is granular (active phase); P1–P5 are coarse placeholders to be split when each phase activates.

### Antecedent
- [ ] ISC-1: Antecedent: a recipient with no terminal/CLI access needs exactly one action — click the Deploy-to-Cloudflare button + authorize once — to get a running, isolated fork.

### P0 — Foundation (scaffold + isolation + deploy)  ← ACTIVE
- [ ] ISC-2: `~/Projects/my-dashboard-app` is a fresh git repo with its own initial commit (template's `.git` history removed, no template origin remote).
- [ ] ISC-3: Scaffold present from `cloudflare/react-router-hono-fullstack-template` — `app/`, `workers/app.ts`, `wrangler.jsonc`, `react-router.config.ts`, `vite.config.ts` all exist.
- [ ] ISC-4: `bun install` completes and `bun.lock` exists; the npm `package-lock.json` is removed (bun is the package manager of record).
- [ ] ISC-5: `wrangler.jsonc` declares a `DB` D1 binding with `database_name` set and `database_id` OMITTED.
- [ ] ISC-6: `wrangler.jsonc` declares a `BUCKET` R2 binding with `bucket_name` set.
- [ ] ISC-7: `wrangler.jsonc` declares a `KV` KV-namespace binding with `id` OMITTED.
- [ ] ISC-8: `wrangler.jsonc` declares an `AI` Workers-AI binding.
- [ ] ISC-9: `wrangler.jsonc` sets `compatibility_flags` including `"nodejs_compat"`.
- [ ] ISC-10: Anti: no `database_id`, KV `id`, or other account-specific resource ID is committed in `wrangler.jsonc` (grep returns none).
- [ ] ISC-11: `workers/lib/db.ts` ports `getDb(env)` with the identical tagged-template API and only requires `env.DB`.
- [ ] ISC-12: `getDb` value normalization is preserved (undefined→null, boolean→0/1, Date→ISO, object/array→JSON).
- [ ] ISC-13: `workers/lib/auth.ts` ports the CF Access JWT verifier — verifies the signed assertion via team JWKS (issuer/audience/signature), never trusts the raw header; exports `identifyAccessUser` + `isOwnerEmail` (+ `requireUser`).
- [ ] ISC-14: A scoped-bearer verification function exists for the MCP seam (stub acceptable at P0).
- [ ] ISC-15: Migration runner applies numbered SQL from `db/migrations/`, keyed on binding `DB`, tracking applied names in a `_migrations` table.
- [ ] ISC-16: Running the migration runner twice reports "0 pending" the second time (idempotent).
- [ ] ISC-17: Boot-guard runs pending migrations on first request behind a single-flight lock (no concurrent double-apply).
- [ ] ISC-18: `bun run migrate` exists and applies pending migrations to a D1 database.
- [ ] ISC-19: Migration `0001_init.sql` creates `_migrations(name TEXT PRIMARY KEY, applied_at TEXT)` and `settings(id INTEGER PRIMARY KEY CHECK(id=1), display_name TEXT, config TEXT, updated_at TEXT)`.
- [ ] ISC-20: Hono `/api/health` returns 200 without auth; `/api/me` returns `{email, isOwner}` shape when authed.
- [ ] ISC-21: Unauthenticated `/api/me` (no CF-Access assertion, no bearer) returns 401.
- [ ] ISC-22: `/home` route renders a minimal live page (the fork "reaches /home").
- [ ] ISC-23: A TanStack Query provider + `app/lib/api.ts` fetch wrapper are wired (CF Access cookie carries auth; no custom Authorization header for humans).
- [ ] ISC-24: `bun run typecheck` passes clean (cf-typegen + react-router typegen + tsc).
- [ ] ISC-25: `bun run build` succeeds (react-router build emits the worker + client assets).
- [ ] ISC-26: `README.md` contains a "Deploy to Cloudflare" button targeting the project's GitHub repo.
- [ ] ISC-27: Anti: the worker never serves any `/api/*` route without first passing the auth gate (no route bypasses it; health is the sole documented public exception).
- [ ] ISC-28: Anti: boot-time migration cannot double-apply under concurrent first requests (single-flight lock verified by a synthetic concurrent probe).
- [DEFERRED-VERIFY] ISC-29: Clicking "Deploy to Cloudflare" stands up a SECOND fork with its own freshly provisioned D1+R2+KV and reaches `/home` with zero manual glue. (follow-up: P0-DEPLOY-PROOF — needs GitHub remote + Yaron OAuth)
- [DEFERRED-VERIFY] ISC-30: A CF-Access request from an allow-listed email returns 200 on `/api/me` against a deployed fork. (follow-up: P0-DEPLOY-PROOF)

### P1 — Easy pages + customization + first-run
- [ ] ISC-31: Home, Goals, Projects, Portfolio render from ported components + their `/api/*` handlers (DB calls unchanged).
- [ ] ISC-32: Zod `ConfigSchema` with embedded `schemaVersion`, every field `.default()`, and a lazy `migrateConfig(raw)` chain.
- [ ] ISC-33: Settings UI reads/writes the `settings` row; export = validated blob, import = validate + migrate-to-current.
- [ ] ISC-34: Page manifest filtered by `enabled_pages` + ordered by `page_order`; toggling a page off removes it from sidebar + routes next load and survives export→fresh-fork→import.
- [ ] ISC-35: First-run shows seeded demo content or a styled empty state on every page — never blank.
- [ ] ISC-36: Importing an OLD exported config into a newer schema yields a valid merged config (defaults fill gaps), no error.
- [ ] ISC-37: Anti: an additive new config key never breaks import of a config exported by an older fork.

### P2 — Tools embed + Knowledge Base
- [ ] ISC-38: Tools page embeds pai-tools via a per-fork `tools_key`; absent key → styled "not configured" state.
- [ ] ISC-39: Anti: `tools_key` never reaches the browser — tool calls proxy through `/api/tools/*` server-side.
- [ ] ISC-40: KB data-driven index (`/api/kb`) + `/kb-doc/*` detail + BlockRenderer (13 section types) renders without error.
- [ ] ISC-41: A small generic starter KB doc set is seeded (no MyJarvis-specific docs).

### P3 — Agent layer (one control plane, two clients)
- [ ] ISC-42: Read-only MCP tools via stateless `createMcpHandler()` at `/mcp` with reused Zod schemas; scoped-bearer auth; invalid bearer rejected.
- [ ] ISC-43: Guarded KB write via `McpAgent` DO with elicitation confirm (fallback `confirm:true`) — declining aborts with no DB change; accepting writes + inserts exactly one `mcp_activity` row.
- [ ] ISC-44: Built-in Assistant pane answers a read question on `env.AI`; opt-in Anthropic key via AI Gateway upgrades the tool-driving model.
- [ ] ISC-45: MCP tools call shared service functions, not internal HTTP round-trips.
- [ ] ISC-46: Anti: no write tool executes without auth → server-side Zod validation → audit row.

### P4 — Fleet + first real fork
- [ ] ISC-47: `recipients.json` manifest (name, email, subdomain, `enabled_pages` overrides) is the single source of truth.
- [ ] ISC-48: `deploy-fleet.mjs` is idempotent — running it twice over the same manifest is a no-op the second time.
- [ ] ISC-49: `smoke.mjs` per-fork health check is green (home loads, `/api/me` 200, migrations current, seed present).
- [ ] ISC-50: One real recipient logs in via CF Access, sees their seeded dashboard, edits a page — zero manual steps after the script run.

### P5 — Meetings module (deferred)
- [ ] ISC-51: Meetings module ported verbatim, ships `enabled:false` in default config; a fork that leaves it disabled is entirely unaffected.
- [ ] ISC-52: A fork that enables Meetings + supplies secrets gets a bot joining a test call + a rendered transcript.

### Cross-cutting
- [ ] ISC-53: Anti: no recipient fork can read or write another fork's D1/R2 (no shared binding, no cross-fork query path exists).

## Test Strategy

| isc | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| ISC-2 | build | fresh git history, no template remote | initial commit only | `git log`, `git remote -v` |
| ISC-3 | build | scaffold files present | all listed exist | `ls` |
| ISC-4 | build | bun.lock present, package-lock.json gone | both true | `ls` |
| ISC-5–9 | config | bindings + flags present, IDs omitted | exact | `Read` wrangler.jsonc + grep |
| ISC-10,27,28 | security | no committed IDs; no unauthed /api; no double-apply | 0 violations | grep + curl + synthetic concurrent probe |
| ISC-11,12 | functional | getDb API + normalization | identical to source | `Read` + unit probe |
| ISC-13,14 | auth | JWKS verify, exports present, bearer fn | present | `Read` + grep |
| ISC-15–19 | data | migrations apply, idempotent, schema landed | "0 pending" 2nd run; tables exist | `bun run migrate` ×2 + D1 SELECT |
| ISC-20,21,22 | api/ui | health 200, /api/me 401 unauth, /home renders | exact status | `curl -i` local dev + Interceptor |
| ISC-23,24,25 | build | provider wired, typecheck + build green | exit 0 | `Read` + `bun run typecheck/build` |
| ISC-26 | build | deploy button markup in README | present | `Read` |
| ISC-29,30 | deploy | 2nd fork via button, CF-Access 200 | live | deploy button + Interceptor (DEFERRED) |
| P1–P5 | — | split when phase activates | — | — |

## Features

| name | satisfies | depends_on | parallelizable |
|------|-----------|-----------|----------------|
| F0.1 Fresh repo + bun toolchain | ISC-2,3,4 | — | no (gates all) |
| F0.2 wrangler.jsonc bindings | ISC-5,6,7,8,9,10 | F0.1 | yes |
| F0.3 Port db.ts | ISC-11,12 | F0.1 | yes |
| F0.4 Port auth.ts + bearer | ISC-13,14 | F0.1 | yes |
| F0.5 Migration runner + 0001_init | ISC-15,16,17,18,19,28 | F0.3 | no |
| F0.6 Hono /api wiring + auth gate | ISC-20,21,27 | F0.3,F0.4 | no |
| F0.7 TanStack provider + api.ts + /home | ISC-22,23 | F0.1 | yes |
| F0.8 typecheck + build green | ISC-24,25 | all above | no |
| F0.9 README deploy button + commit | ISC-26 | F0.8 | no |
| F0.10 Deploy-button 2nd-fork proof | ISC-1,29,30 | F0.9 + GitHub remote + OAuth | DEFERRED (Yaron) |

## Decisions

- 2026-06-24: Repo home = `~/Projects/my-dashboard-app` (fresh dir + fresh git), per Yaron — leaves the set-aside `~/Projects/my-dashboard` clone-fork untouched as reference. GitHub repo name TBD at the deploy-button step.
- 2026-06-24: Verified the actual template before writing this ISA (cloned `cloudflare/react-router-hono-fullstack-template`, inspected real structure) rather than inferring — Explore's structural details came from the yaron repo, not the template. Real facts: Hono 4.8.2 / RR 7.6.3 / vite 6 / wrangler.jsonc / `workers/app.ts` Hono catch-all / `cloudflare.publish:true` block powers the Deploy button / template's stated UI system is shadcn/ui.
- 2026-06-24: Server dir = `workers/` (template), so port target is `workers/lib/*`, correcting the plan's `/server/lib/*`.
- 2026-06-24: Custom idempotent migration runner is authoritative (boot-guard + `bun run migrate`), not wrangler-native `d1 migrations` — sidesteps the JSONC/TOML remote-migration trap and gives us the single-flight + `_migrations` tracking the plan specifies.
- 2026-06-24: shadcn-admin shell + page components DEFERRED to P1 — not required for the P0 isolation milestone (plan: "prove the milestone BEFORE porting any page").
- 2026-06-24: Deploy via node (`/opt/homebrew/bin/node`) wrapped in `script -q /dev/null`, never bun — bun hangs `wrangler` uploads on this Mac ([[reference_wrangler_via_bun]]). New build is Workers → `wrangler deploy` (not `pages deploy`).

## Changelog

- conjectured: a fresh Workers skeleton + proven modules ported from `my-jarvis-dashboard-yaron` is faster and safer than green-fielding or cleaning the old clone-fork. | refuted_by: (open) | learned: (pending P0 completion) | criterion_now: ISC-11 (db.ts ports unchanged) is the load-bearing test of the "port the proven" conjecture.
- conjectured: the Deploy-to-Cloudflare button auto-provisions an isolated D1+R2+KV per click when `wrangler.jsonc` omits resource IDs. | refuted_by: (open — proven at ISC-29) | learned: (pending) | criterion_now: ISC-29 is the cheapest test of the riskiest, most load-bearing assumption in the whole project.

## Verification

_(filled during VERIFY — evidence per ISC)_
