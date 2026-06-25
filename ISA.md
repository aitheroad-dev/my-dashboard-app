---
project: My Dashboard
task: Build the shareable per-fork personal dashboard (productized "give-it-to-anyone")
slug: my-dashboard
effort: E3
phase: verify
progress: 37/57
mode: ALGORITHM
started: 2026-06-24
updated: 2026-06-25
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
- **Toolchain:** **bun** for install/scripts (never npm/npx). **Deploy must run under node**, not bun — `wrangler deploy` hangs mid-upload under bun on this Mac; use `/opt/homebrew/bin/node ./node_modules/wrangler/bin/wrangler.js deploy` wrapped in `script -q /dev/null`, no stdout redirect, no pipe. CF account ID stored locally (`~/.config/cloudflare/`), not committed — this repo is public.

## Goal

Ship a fresh Cloudflare-Workers dashboard that any hand-picked recipient can stand up as a physically-isolated per-fork instance via a one-click Deploy button, with versioned per-fork config, six v1 pages (Home, Goals, Projects, Portfolio, Tools, Knowledge Base), an MCP agent control plane (read tools + elicitation-gated writes), and a re-runnable fleet script — built by porting proven modules from `my-jarvis-dashboard-yaron` onto the `react-router-hono-fullstack-template` base. **Done when all ISCs below pass.** The current run targets **P0 (Foundation)**: prove per-fork auto-provisioned isolation + idempotent migrations before any page is ported.

## Criteria

> Numbered sequentially; never re-numbered on edit (splits become ISC-N.M). P0 is granular (active phase); P1–P5 are coarse placeholders to be split when each phase activates.

### Antecedent
- [ ] ISC-1: Antecedent: a recipient with no terminal/CLI access needs exactly one action — click the Deploy-to-Cloudflare button + authorize once — to get a running, isolated fork.

### P0 — Foundation (scaffold + isolation + deploy)  ✅ buildable surface VERIFIED (deploy-button proof deferred to Yaron)
- [x] ISC-2: `~/Projects/my-dashboard-app` is a fresh git repo with its own initial commit (`6759d59`; template `.git` removed; `git remote -v` empty).
- [x] ISC-3: Scaffold present from `cloudflare/react-router-hono-fullstack-template` — `app/`, `workers/app.ts`, `wrangler.jsonc`, `react-router.config.ts`, `vite.config.ts` all exist.
- [x] ISC-4: `bun install` completes (226 pkgs) and `bun.lock` exists; `package-lock.json` removed.
- [x] ISC-5: `wrangler.jsonc` declares a `DB` D1 binding with `database_name` set and `database_id` OMITTED.
- [x] ISC-6: `wrangler.jsonc` declares a `BUCKET` R2 binding with `bucket_name` set.
- [x] ISC-7: `wrangler.jsonc` declares a `KV` KV-namespace binding with `id` OMITTED.
- [x] ISC-8: `wrangler.jsonc` declares an `AI` Workers-AI binding.
- [x] ISC-9: `wrangler.jsonc` sets `compatibility_flags` including `"nodejs_compat"`.
- [x] ISC-10: Anti: no `database_id`, KV `id`, or other account-specific resource ID is committed in `wrangler.jsonc` (grep returns none).
- [x] ISC-11: `workers/lib/db.ts` ports `getDb(env)` with the identical tagged-template API and only requires `env.DB`.
- [x] ISC-12: `getDb` value normalization is preserved (undefined→null, boolean→0/1, Date→ISO, object/array→JSON).
- [x] ISC-13: `workers/lib/auth.ts` ports the CF Access JWT verifier — `jose.jwtVerify` validates issuer + **audience** + signature + exp; never trusts the raw header; exports `identifyAccessUser` + `isOwnerEmail` + `requireUser`.
- [x] ISC-14: A scoped-bearer verification function (`verifyBearer`, constant-time) exists for the MCP seam (stub for P0).
- [x] ISC-15: Migration runner applies numbered SQL from `db/migrations/` (bundled via `import.meta.glob`), keyed on binding `DB`, tracking applied names in `_migrations`.
- [x] ISC-16: `bun run migrate` twice reports "0 pending" the second time (run 1 applied 0001, run 2 applied none).
- [x] ISC-17: Boot-guard runs pending migrations on first `/api/*` request (proven: fresh-DB `/api/me` returned 401, not 500).
- [x] ISC-18: `bun run migrate` exists and applies pending migrations to a (local) D1 database.
- [x] ISC-19: `0001_init.sql` creates `_migrations(name TEXT PK, applied_at TEXT)` and `settings(id INTEGER PK CHECK(id=1), display_name, config, updated_at)` — both confirmed present in D1.
- [x] ISC-20: `/api/health` returns 200 without auth with a binding-presence map `{db,bucket,kv,ai}`; `/api/me` returns `{email,isOwner}` when authed.
- [x] ISC-21: Unauthenticated `/api/me` returns 401 (`{"error":"unauthorized"}`).
- [x] ISC-22: The app serves a live SSR landing at `/` rendering "My Dashboard" (200). NOTE: the dedicated `/home` *page key* + routing lands in P1; for P0 the live landing is `/`.
- [x] ISC-23: A TanStack Query provider + `app/lib/api.ts` fetch wrapper are wired. DONE in P1: `QueryClientProvider` in `app/root.tsx`; typed `apiGet/apiPut` + query hooks in `app/lib/api.ts`; every page reads through it.
- [x] ISC-24: `bun run typecheck` passes clean (after wrangler 4.104 bump — older wrangler rejected omitted IDs).
- [x] ISC-25: `bun run build` succeeds (after vite-plugin 1.42 bump; emits worker + client assets; migration `.sql` bundled).
- [x] ISC-26: `README.md` contains a "Deploy to Cloudflare" button (repo URL finalized at the remote step).
- [x] ISC-27: Anti: `/api/me` (and all non-health `/api/*`) pass the auth gate; `/api/health` is the sole documented public route (verified: health 200 public, me 401).
- [x] ISC-28: Anti: boot-time migration cannot double-apply — now guaranteed **by construction**: the DDL + completion row commit in one atomic `D1.batch()`, so a concurrent second isolate hits a PK conflict and rolls back entirely (advisor-driven redesign; sequential idempotency proven; a true multi-isolate race is not locally probeable).
- [x] ISC-29: Clicking "Deploy to Cloudflare" stands up a fork with its own freshly provisioned D1+R2+KV and reaches the live landing with zero manual glue. VERIFIED 2026-06-24: repo made public → one button click auto-provisioned D1 `my-dashboard-db` (uuid `ee9fee75-f345-4cb2-a782-e475aa0e9dec`), R2 `my-dashboard-bucket`, KV `My Dashboard`, new repo `aitheroad-dev/my-dashboard`, deployed Worker LIVE @ https://my-dashboard.aitheroad.workers.dev (HTTP 200; `/api/health` reports db/bucket/kv/ai all true; Interceptor real-Chrome render confirmed). Reusable: the CF deploy-button React submit only fires on a TRUSTED Interceptor click with Chrome foregrounded.
- [DEFERRED-VERIFY] ISC-30: A CF-Access request from an allow-listed email returns 200 on `/api/me` against a deployed fork. (follow-up: P0-DEPLOY-PROOF)

### P1 — Easy pages + customization + first-run
> ISC-31 split into per-page probes (ID-stability: parent preserved as this header). "Slice 1" = the spine + 4 pages live with empty states + viewer auth; Settings UI export/import (ISC-33) + full toggle round-trip (ISC-34) + migration fixtures (ISC-36/37 tests) follow.
- [ ] ISC-31: [SPLIT — see ISC-31.1..31.5]
- [x] ISC-31.1: `/api/projects` (Hono, `getDb`) returns projects rows; `/projects` page renders them (or styled empty state). Verified: curl 200 → 2 demo projects w/ goal_count subquery; real-Chrome prod render shows 2 cards.
- [x] ISC-31.2: `/api/goals` (Hono, `getDb`, project join) returns goals rows; `/goals` page renders them (or empty state). Verified: curl 200 → 3 goals w/ project_name join; real-Chrome render shows 3 with project labels.
- [x] ISC-31.3: `/api/portfolio` returns an empty productized snapshot (Yaron's personal holdings NOT shipped); `/portfolio` page renders the "connect your portfolio" empty state. Verified: curl `configured:false, holdings:[]`; real-Chrome shows "No portfolio connected".
- [x] ISC-31.4: `/` Home renders an overview (project/goal counts + nav) from live `/api/*`, never blank. Verified real-Chrome: "2 active projects / 2 active goals", welcome card, recent-projects list.
- [x] ISC-31.5: A `getViewer(request, env)` seam gates data endpoints: enforces verified CF Access when the fork configures it, allows owner open-dev when Access is unconfigured (local dev / bare fork). Anti: an Access-configured fork still 401s an unverified request. Verified via probe: access-env + no token → null (401); bare env → open-dev owner.
- [x] ISC-32: Zod `ConfigSchema` with embedded `schemaVersion`, every field `.default()`, and a lazy `migrateConfig(raw)` chain. Verified: `/api/settings` returns fully default-filled config; probe confirmed defaults.
- [ ] ISC-33: Settings UI reads/writes the `settings` row; export = validated blob, import = validate + migrate-to-current. PARTIAL: server `GET/PUT /api/settings` done + round-trip verified (toggle/rename/theme persist); the Settings UI PAGE (export/import buttons) is next slice.
- [ ] ISC-34: Page manifest filtered by `enabled_pages` + ordered by `page_order`; toggling a page off removes it from sidebar + routes next load and survives export→fresh-fork→import. PARTIAL: manifest filters+orders the SIDEBAR (proven — PUT dropping "goals" → `pages` excludes it, Shell renders from it); route-level gating + export/import survival = next slice.
- [x] ISC-35: First-run shows seeded demo content or a styled empty state on every page — never blank. Verified: demo seed renders on Home/Projects/Goals; Portfolio + each list have styled EmptyState components.
- [x] ISC-36: Importing an OLD exported config into a newer schema yields a valid merged config (defaults fill gaps), no error. Verified via probe: `{schemaVersion:0, theme:"dark", ...}` → schemaVersion 1, theme kept, defaults filled.
- [x] ISC-37: Anti: an additive new config key never breaks import of a config exported by an older fork. Verified via probe: unknown page key "FUTURE_PAGE" dropped (not fatal); null/string/bad-type inputs never throw (`.catch()` per field).

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

- 2026-06-25: **P1 Slice 1 scope.** P0 closed (ISC-29 deploy-proof verified; ISC-30 CF-Access deferred). This run builds the P1 spine: TanStack Query provider + `app/lib/api.ts` (ISC-23), Zod versioned config (ISC-32), page manifest + sidebar shell (ISC-34 foundation), Hono data handlers + the 4 easy pages with never-blank empty states (ISC-31.1..31.5, 35). Settings export/import UI (ISC-33) + toggle round-trip + migration fixtures (ISC-36/37) follow next slice.
- 2026-06-25: **Portfolio ships EMPTY, not seeded.** The source `/api/portfolio` handler embeds Yaron's real holdings (SLV/GLDG/… from `pai-portfolio sync`). A recipient fork must never carry his personal data → portfolio returns an empty productized snapshot + a "connect your portfolio" empty state. Enforces the "wiped of personal data" + isolation principles.
- 2026-06-25: **`getViewer` auth seam (Access-or-open-dev).** Data endpoints can't use bare `requireUser` — on a fork with no CF Access configured (the current live bare-workers.dev fork, and all local dev) it would 401 every page. `getViewer` enforces verified Access when `ACCESS_TEAM_DOMAIN`+`ACCESS_AUD` are set, else grants an owner open-dev viewer. Keeps the gate real where Access exists (ISC-31.5 anti) while letting an unconfigured fork actually show its seeded pages.
- 2026-06-25: **Dev-server hydration quirk DEFERRED (not blocking).** `bun run dev` (react-router dev + `@cloudflare/vite-plugin`) throws `Cannot read properties of null (reading 'useContext')` inside react-router's `Meta`, from `.vite/deps` optimized chunks — DEV ONLY. The PRODUCTION build is clean: `bun run build` green, and the prod preview (`vite preview`, real workerd bundle) renders all 4 pages correctly in real Chrome — and production is exactly what ships to recipients (ISC-29's live fork already rendered prod-built). Root cause is the dev dep-optimizer's module graph (identical render logic works in prod; only the dev bundling differs), not our SSR/CSR output. Tried `resolve.dedupe` + `optimizeDeps.include` for the new react-consuming deps — did not resolve; deeper plugin/version interplay. Follow-up: fix the dev loop (try plugin order / `optimizeDeps.exclude: ['react-router']` / version bump) so local hot-reload works for future slices. Verification this slice ran against the prod preview.
- 2026-06-25: **Advisor (commitment boundary) — proceed.** Advisor flagged "no ISA.md" (false positive — it scans MEMORY/WORK, not this project ISA, which has 53→57 ISCs) and "confirm auth seam not a stub" (already negative-tested: access-configured + no token → 401). Its config-migration + empty-state cautions were already covered by probes. Net: no blocker; the two it would block on are both satisfied. Hydration deferral accepted with the root-cause note above.
- 2026-06-25: **Single-author slice; Forge as independent hardening pass (delegation show-your-math).** This is a small, tightly-coupled vertical slice (shared `api.ts`/config/manifest contracts). A 2nd concurrent write-agent recreates the concurrent-edit conflict class documented for this lineage ([[feedback_concurrent_edit_commit]]); the parallelizable surface is too small to justify it. Delegation = 1 (Forge runs read-then-fix on the quiet committed tree = cross-vendor independence per Yaron's "same-family review shares blind spots" principle), under the E3 soft floor of 2 by design.
- 2026-06-24: Repo home = `~/Projects/my-dashboard-app` (fresh dir + fresh git), per Yaron — leaves the set-aside `~/Projects/my-dashboard` clone-fork untouched as reference. GitHub repo name TBD at the deploy-button step.
- 2026-06-24: Verified the actual template before writing this ISA (cloned `cloudflare/react-router-hono-fullstack-template`, inspected real structure) rather than inferring — Explore's structural details came from the yaron repo, not the template. Real facts: Hono 4.8.2 / RR 7.6.3 / vite 6 / wrangler.jsonc / `workers/app.ts` Hono catch-all / `cloudflare.publish:true` block powers the Deploy button / template's stated UI system is shadcn/ui.
- 2026-06-24: Server dir = `workers/` (template), so port target is `workers/lib/*`, correcting the plan's `/server/lib/*`.
- 2026-06-24: Custom idempotent migration runner is authoritative (boot-guard + `bun run migrate`), not wrangler-native `d1 migrations` — sidesteps the JSONC/TOML remote-migration trap and gives us the single-flight + `_migrations` tracking the plan specifies.
- 2026-06-24: shadcn-admin shell + page components DEFERRED to P1 — not required for the P0 isolation milestone (plan: "prove the milestone BEFORE porting any page").
- 2026-06-24: Deploy via node (`/opt/homebrew/bin/node`) wrapped in `script -q /dev/null`, never bun — bun hangs `wrangler` uploads on this Mac ([[reference_wrangler_via_bun]]). New build is Workers → `wrangler deploy` (not `pages deploy`).
- 2026-06-24: **Toolchain bump required for omitted-IDs.** The template pins wrangler 4.21.2 + vite-plugin 1.7.5, both of which REJECT `wrangler.jsonc` bindings without `database_id`/`id`. Bumped to `wrangler ^4.104.0` + `@cloudflare/vite-plugin@1.42.2` (uses the hoisted wrangler) — these tolerate omitted IDs, which is the whole deploy-button premise. Pinned in package.json + bun.lock so the button builds with matching versions.
- 2026-06-24: **Migration concurrency redesign (advisor-driven).** Forge's first runner claimed the `_migrations` row BEFORE running DDL → a concurrent loser could read the claim and serve a half-migrated DB (TOCTOU). Replaced with an atomic-batch completion barrier: DDL + completion row commit together in one `D1.batch()`; the loser hits a PK conflict → full rollback → re-reads → proceeds only after the winner committed. Row presence now means "fully applied," never "claimed."
- 2026-06-24: **AI binding triggers a remote connection in `bun run dev`** ("⎔ Establishing remote connection…") since Workers AI can't run locally — resolves on its own here; note it for fork dev onboarding.
- 2026-06-24: `/api/health` returns a binding-presence map (advisor hardening) so a partially-provisioned fork is diagnosable rather than a blanket 500.
- 2026-06-24: ISC-23 (TanStack provider + api.ts) moved to P1 — the P0 milestone is isolation/migrations, and no page consumes the data layer yet; frontend stays the template placeholder.

## Changelog

- conjectured: a fresh Workers skeleton + proven modules ported from `my-jarvis-dashboard-yaron` is faster and safer than green-fielding or cleaning the old clone-fork. | refuted_by: (open) | learned: (pending P0 completion) | criterion_now: ISC-11 (db.ts ports unchanged) is the load-bearing test of the "port the proven" conjecture.
- conjectured: the Deploy-to-Cloudflare button auto-provisions an isolated D1+R2+KV per click when `wrangler.jsonc` omits resource IDs. | refuted_by: (open — proven at ISC-29) | learned: omitted-IDs requires wrangler ≥4.40-ish (4.104 confirmed) + a matching vite-plugin; the template's pinned 4.21/1.7 reject it. | criterion_now: ISC-29 is the cheapest test of the riskiest, most load-bearing assumption in the whole project.
- conjectured: an `INSERT OR IGNORE` PK-claim row is a sufficient single-flight lock for boot-time migrations. | refuted_by: advisor review 2026-06-24 — a claim is not a completion barrier; a concurrent loser reads the claimed row and serves against a half-migrated DB (TOCTOU). | learned: under D1's no-long-transaction model the only safe barrier is committing the migration body AND its completion marker in ONE atomic `D1.batch()`, so row-presence ⟺ fully-applied. | criterion_now: ISC-28 reworded to "guaranteed by construction (atomic batch + PK rollback)".

## Verification

- conjectured: P1 pages "port" from `my-jarvis-dashboard-yaron` near-verbatim (per the plan's "port existing page components + their /api/* handlers"). | refuted_by: the source is Pages-Functions + react-admin/atomic-crm; the target is Hono + RR7 + bare TanStack Query — the API handlers are rewritten as Hono routes and the pages are rebuilt on the new data layer; and the source `/api/portfolio` embeds Yaron's real holdings. | learned: "port the proven" holds for the DATA layer (`getDb` + SQL shapes port unchanged) but NOT the framework seam (handlers + UI rebuilt) — port the data, rebuild the seam; and a "port" can smuggle personal data, so privacy is an explicit anti-criterion. | criterion_now: ISC-31.1–31.4 verify rebuilt-on-stack; ISC-31.3 ensures the empty productized portfolio.
- conjectured: a green local `bun run build` + a green dev server together gate "the app renders." | refuted_by: `bun run dev` (cloudflare-vite-plugin) crashes in react-router's `Meta` while the production build renders all pages cleanly in real Chrome. | learned: for this stack, the PRODUCTION preview (`vite preview`, real workerd) is the faithful render check — verify there, not against the dev server; dev hot-reload is a separate, deferrable concern. | criterion_now: the P1 UI verification evidence is captured against the prod preview.

P0 buildable surface (run 2026-06-24, E3):
- ISC-2: `git log --oneline` → single commit `6759d59`; `git remote -v` empty.
- ISC-4: `bun install` → "226 packages installed"; `bun.lock` present, `package-lock.json` absent.
- ISC-5–10: `grep wrangler.jsonc` → DB/BUCKET/KV/AI bindings + `nodejs_compat`; "NO committed IDs ✓".
- ISC-11–14: `Read workers/lib/{db,auth}.ts` → `getDb` verbatim; `jose.jwtVerify` checks aud+iss+sig+exp; `verifyBearer` present.
- ISC-16,18: `bun run migrate` ×2 → "Applied: 0001_init.sql / 0 pending", then "Applied: none / 0 pending".
- ISC-17,19: wiped `.wrangler`; fresh-DB `/api/me` → **401 (not 500)**; `SELECT … sqlite_master` → `_migrations` + `settings` present.
- ISC-20,21,22: `curl` → `/api/health` 200 `{ok:true,bindings:{db,bucket,kv,ai all true}}`; `/api/me` 401; `/` 200 rendering "My Dashboard".
- ISC-24,25: `bun run typecheck` clean; `bun run build` → "✓ built", worker + client assets emitted (migration `.sql` bundled).
- ISC-27: health 200 public + me 401 → auth gate enforced, health is the sole public route.
- ISC-28: code — atomic `D1.batch([...ddl, markComplete])` in `workers/lib/migrate.ts` (completion barrier by construction).
- ISC-1,29,30: ISC-1/29 closed (deploy-proof, prior run); ISC-30 still DEFERRED (CF Access on the fork).

P1 Slice 1 (run 2026-06-25, E3) — commit `75769cc`:
- Build: `bun run typecheck` EXIT 0 (after `wrangler types` + `react-router typegen` + `tsc -b`); `bun run build` EXIT 0 (client + SSR bundles, 15.6 kB CSS = Tailwind compiled the new classes).
- Migrate: `bun run migrate` applied `0002_p1.sql`; 2nd run "Applied: none / 0 pending" (idempotent).
- API (local dev, open-dev viewer): `/api/health` 200 all-bindings-true; `/api/me` 200 `{owner@local,open-dev}`; `/api/settings` 200 fully-default config + `pages:[home,projects,goals,portfolio]`; `/api/projects` 200 (2 demo, goal_count 1/2); `/api/goals` 200 (3, project_name joined); `/api/portfolio` 200 `{configured:false, holdings:[]}`.
- Settings write: `PUT /api/settings` dropping "goals" + rename + theme:dark → `pages:[home,projects,portfolio]`, display_name "Rex Test", theme dark; re-GET reflects; restore → 4 pages.
- Auth seam probe: access-env (`ACCESS_TEAM_DOMAIN`+`ACCESS_AUD`) + no token → `getViewer` null (= 401); bare env → open-dev owner.
- Config probe: `migrateConfig({})` defaults; `migrateConfig({schemaVersion:0,enabled_pages:[...,"FUTURE_PAGE"],theme:"dark"})` → v1, theme kept, FUTURE_PAGE dropped; `migrateConfig(null|"str"|{theme:99})` never throws.
- UI (real Chrome, Interceptor, against prod preview `vite preview` @ :4173): Home (nav + 2/2 stat cards + welcome + recent projects), `/projects` (2 cards), `/goals` (3 w/ project labels), `/portfolio` ("No portfolio connected" empty state). Dev server (`react-router dev`) has a separate cloudflare-vite-plugin hydration error — prod verified instead (see Decisions).
