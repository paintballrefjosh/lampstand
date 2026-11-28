# CLAUDE.md

Context file for Claude (or any AI assistant) working on this repo. Keep this current.

**This file has a size budget: keep it under 60k characters** (Claude Code warns past 150k and every session pays for all of it).
It holds what applies to any change. The detail of one area belongs in its `.claude/rules/` file (keep each under 40k); add a
line here only when someone working elsewhere must know the rule.

## Area rules

Each file in `.claude/rules/` holds binding rules, reasons and tests that are not repeated here. Its `paths` frontmatter makes
Claude Code load it when a matching file is read, written or edited. **Open the file yourself** when planning before touching
any file, when you only searched the code, or when creating a file its patterns may not cover; after a context summary it
returns only once a matching file is touched again. **A new directory or file in an area gets added to that file's `paths`.**
A "## Name" reference to a section that has no heading in this file is in one of these.

| Working on | Read |
|---|---|
| Cisco switches, switch view and device profiles, UniFi, IPAM, DNS, UPS, cabinets and port sheets | [.claude/rules/network.md](.claude/rules/network.md) |
| Infra hosts and update runs, maintenance mode, alerting, escalation, status pages, AV probes, service monitoring, renewals | [.claude/rules/monitoring.md](.claude/rules/monitoring.md) |
| Rooms and equipment, livestreams, signage | [.claude/rules/church-apps.md](.claude/rules/church-apps.md) |
| Tickets and email-in, wiki (upkeep, access, archive, file import) | [.claude/rules/helpdesk-wiki.md](.claude/rules/helpdesk-wiki.md) |
| Notification delivery and push, command palette, home page looks | [.claude/rules/ui.md](.claude/rules/ui.md) |
| Accessibility (any screen) | [.claude/rules/accessibility.md](.claude/rules/accessibility.md) |
| Sign-in, OAuth and linked identities, API tokens, sessions, rate limits, 2FA, account lifecycle, Security overview | [.claude/rules/auth.md](.claude/rules/auth.md) |
| MCP server, Assistant | [.claude/rules/mcp-assistant.md](.claude/rules/mcp-assistant.md) |
| Search indexing, upload types and attachments | [.claude/rules/search-attachments.md](.claude/rules/search-attachments.md) |
| Background jobs, database pools, realtime, caches, object storage, cluster compose files and tests | [.claude/rules/cluster.md](.claude/rules/cluster.md) |
| `install.sh`, `scripts/upgrade*.sh` | [.claude/rules/install-upgrade.md](.claude/rules/install-upgrade.md) |
| Backups, restores, offsite copies, any new table | [.claude/rules/backups.md](.claude/rules/backups.md) |
| Dockerfiles, CSP, a module's settings pages, outbound connections, Host header handling | [.claude/rules/platform.md](.claude/rules/platform.md) |

## What this project is

**Lampstand** (the name's meaning is the first thing in the README). A web-based dashboard for a single church. Modular tile dashboard, helpdesk
(tickets + SLAs), wiki, notes, monitoring + incidents, printer (SNMP) status,
UniFi network views, ProPresenter control, Planning Center, volunteer checklists,
tags, @mentions, activity feed, full-text search, a notification centre, and
admin. Self-hosted via Docker Compose behind an upstream HTTPS load balancer.

**Naming.** Everything is called `lampstand`: the repo, the `@lampstand/*` workspace scope, the compose projects (`lampstand`, `lampstand-prod`) and
images (`lampstand-<service>`), the database and its user, the default bucket (`lampstand-files`), the cookies and headers (`lampstand_rv`,
`lampstand_home_look`, `X-Lampstand-Node`, `X-Lampstand-Signature`), and the key-derivation strings. **There is no compatibility with any earlier
product name** (decided 2026-11-27: assume no installation predates the name), so do not add legacy fallbacks for one. Sample text and prose that
say "church" (example domains, "Church Apps", "a church") are about the organisation, not the product. The GitHub repo is `paintballrefjosh/lampstand`.

**Tenancy:** single church only. Do **not** add `tenant_id` columns or multi-tenant
abstractions. If multi-tenancy is ever needed it will be a separate, explicit phase.

## Architecture

```
                                            ┌──────────────────────┐
                          host :8100  ──────►│  Caddy (proxy)       │
                          (HTTP only,        │  routes / → web      │
                          HTTPS upstream)    │  routes /api → api   │
                                            └─────┬──────────┬──────┘
                                                  │          │
                                          ┌───────▼───┐  ┌───▼────────┐
                                          │  web      │  │  api       │
                                          │  Next.js  │  │  NestJS    │
                                          │  Auth.js  │  │  Drizzle   │
                                          │  :3000    │  │  :3001 +WS │
                                          └─────┬─────┘  └─┬───┬──────┘
                                                │          │   │
                                       ┌────────▼──────────▼─┐ │
                                       │  CockroachDB or     │ │
                                       │  YugabyteDB (see    │ │
                                       │  ## Database)       │ │
                                       └─────────────────────┘ │
                                                               │
                                      ┌─────────────┐  ┌──────────────┐
                                      │  meilisearch│  │ garage (S3)  │
                                      └─────────────┘  └──────────────┘
                                       (search across   (attachments,
                                        wiki/notes/      note images,
                                        tickets)         wiki uploads)

  No Redis: realtime fan-out between nodes, the mail queue, cache
  invalidation and the strict rate limits live in the database (see
  ## Cluster coordination).
```

The `monitor` probe worker runs as its own service in the dev/prod stack (it is
the only thing that probes uptime monitors; prod lacked it until 2026-10-03). The
ProPresenter, UniFi, and Planning Center integrations are outbound HTTP/WS
clients to external systems (configured in the `settings` table), not local
services in compose.

## Tech stack (pinned)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js 15.5 (App Router) + React 19 + TS 5 | RSC where it helps; Tailwind for styles; `next/image` unused and its optimizer off |
| Backend | NestJS 11 + Fastify 5 adapter | WS via Socket.io, RBAC guard, audit interceptor |
| DB | CockroachDB v24 or YugabyteDB YSQL (2024.2+) | Postgres wire; SQL must run on both (see ## Database) |
| ORM | Drizzle ORM + drizzle-kit | Schema-as-code TS; migrations checked into `apps/api/migrations/` |
| Auth | Auth.js v5 (NextAuth) | Google + Microsoft Entra OAuth + Credentials (argon2id) + TOTP; providers configured in DB `settings`, not env |
| Realtime | Socket.io 4 (in-process adapter) + `ClusterBus` over the DB between nodes | Rooms per resource (`monitor:{id}`, `ticket:{id}`; see ## Realtime rooms) and per user (`user:{id}`) |
| Search | Meilisearch v1 | Single `content` index, kind-discriminated; permission-filtered at query time (see ## Search) |
| File storage | Garage (S3-compatible), or any external S3 store | Behind API only, never exposed via proxy. Was MinIO until its images were withdrawn from the registries (2026-10-04). |
| Reverse proxy | Caddy 2 | Only ingress; serves :8100 |
| Monorepo | pnpm 9 + Turborepo | `pnpm -w` for workspace commands |

## Repo layout

```
apps/
  web/        Next.js — UI, Auth.js routes, theme, PWA
  api/        NestJS — REST + WS, access guards, audit, DB access
              (drizzle schema in src/db/schema/, migrations in apps/api/migrations/;
              backups and restores in src/backup/)
services/
  monitor/    ICMP/TCP/HTTP and AV probe worker (its own compose service)
  signage-agent/  the Python agent that runs on each signage Raspberry Pi (outside the Node workspace)
packages/
  shared/     Zod schemas, modules/permissions/settings catalogues, audit types
scripts/                     compose.sh, rebuild.sh, upgrade*.sh, cluster.sh, release.sh, assistant-eval.mjs ...
patches/                     pnpm patchedDependencies (see ## Dependencies)
docs/                        design notes and decisions per feature (module-settings, multi-node, assistant, mcp, signage ...)
install.sh                   guided installer (wizard; every deployment shape, see ## Guided installer)
infra/
  docker-compose.yml         dev (bundled single Cockroach node, or external DB)
  docker-compose.prod.yml    prod (bundled 3-node Cockroach, or external DB)
  caddy/Caddyfile            ingress config
tests/
  e2e/        Playwright suite (runs against the live compose stack)
  smoke/      API/HTTP regression suite (Node, runs against live stack)
  cluster/    multi-node harnesses (sim.sh, shape-d.sh, failover, backup-restore ...)
  installer/  install.sh tests: dry-run.sh (no docker), e2e.sh (real installs in throwaway copies)
```

## Access control: groups + module tiers

There is **no role model** in the live system anymore (it was replaced in
migrations 0022/0024). Access is granted as **(module, tier)** per **group**:

- A user belongs to 0+ **groups** (`groups` + `group_memberships`).
- Each group is granted a **tier** on each **module** it can touch
  (`group_module_access` → `(group_id, module_key, tier)`).
- Tiers are `user` < `moderator` < `admin`; higher tiers inherit lower ones. The
  `admin` module only has the `admin` tier.
- `loadUserById` in [apps/api/src/auth/auth.service.ts](apps/api/src/auth/auth.service.ts)
  resolves a user's groups → highest tier per module → a flat set of permission
  **strings** (e.g. `tickets:read:any`) via `permissionsFor()` in
  `packages/shared/src/modules.ts`. Route guards still check permission strings —
  but those strings are now *derived* from module tiers, not stored per role.
- The `admin` **group** is special-cased: top tier on every module + every
  permission, and locked from edit in the UI/API.
- **A module's pages are gated in its layout** (`RequireModule`, `apps/web/src/components/require-module.tsx`: any tier on the module
  opens it, same rule as the top-bar menus; otherwise a "No access" page). Until 2026-11-10 only the menus hid the links, and pages
  that swallowed the API's 403 (`/monitoring`) drew an empty shell for anyone who typed the address. **A new module section's
  `layout.tsx` wraps what it renders in `<RequireModule module="...">`** (IPAM, DNS, Cabinets, Device profiles, Renewals and the print
  sheets use `monitoring`; Rooms is left open because its API needs only a session). It fails open if `/me` cannot be read (the API
  still refuses the data). The `user` group's default grants include Assets and Livestreams (`DEFAULT_GROUP_MODULE_ACCESS`, migrations
  0082/0084), so a plain `user` account sees those menus until an admin removes them in Admin > Groups.

Modules are defined in `packages/shared/src/modules.ts`: `notes`, `tickets`,
`wiki`, `monitoring`, `printers`, `propresenter`, `planning_center`,
`checklists`, `assets`, `admin` (among others). Default per-group grants live in
`DEFAULT_GROUP_MODULE_ACCESS` and are applied by the seed.

Four groups ship by default: `admin` (everything), `support_engineer`
(helpdesk-focused), `user` (baseline; auto-joined by every newly provisioned
account) and `signage` (Signage moderator, no members at first). Wiki page ACLs and other per-resource controls reference **groups**.
Only `admin` and `user` are system groups; `support_engineer` and `signage` are seed defaults that installs rename or delete.
Only `admin` holds the `assistant` module by default. **A migration that grants a new module to existing installs grants by the tiers a group already holds, never by a
non-system group's name** (0083: moderators of Tickets or Monitoring get Assets moderator); the seed's
`DEFAULT_GROUP_MODULE_ACCESS` covers fresh installs.

**Legacy:** the `roles`, `permissions`, `role_permissions`, `user_roles`, and
`group_permissions` tables still exist (kept for migration safety) but are never
read; the old `apps/api/src/roles/` module was removed. Don't write code that
reads them — use `group_module_access`.

## Rules every change must follow

Short forms of rules whose detail is in the area files.

**Routes and permissions**
- Every REST route is an MCP catalogue tool or is named in `route-rules.ts` with a reason (`mcp-coverage.test.ts`).
- A route that reaches live equipment gets `@OperationalOnly()`; one that would let a leaked API token outlive revocation or
  take over an account gets `@SessionOnly()`.
- A new module section's `layout.tsx` wraps its pages in `<RequireModule module="...">`.
- A credential is never returned to a reader: answer `[saved]`, keep it on `[saved]`, store it encrypted (`enc:v1:`), and read
  it with `decryptStoredSecret`.
- A new security-relevant setting or policy gets a check in the Security overview (`evaluatePosture`).
- A new activity event kind is added to `ActivityService`'s `visibleTo`.

**Data**
- Every new table gets a `data` or `skip` decision in `backup/table-registry.ts`.
- A table that grows without bound gets a retention window.
- Migrations are additive (expand/contract): the previous release keeps running against the new schema.

**Background work, realtime, search** (several nodes must work)
- Periodic work goes through `ClusterJobs.register`; "only one at a time" is a lease; state kept across runs goes in `job_state`.
  Writers outside those honour the restore gate.
- Claim work with a conditional UPDATE before sending or doing it, so two nodes never do it twice.
- Database pools come only from `createPool` (`@lampstand/shared/db`).
- A per-process cache that a write invalidates also drops other nodes' copies (`CACHE_ROOM`).
- Realtime goes through `RealtimeGateway`; a room shared by people with different rights carries no content.
- Never write to Meilisearch from a feature: call `SearchService.changed()` (or the live-kind publishers). Permissions are
  applied in the query filter.
- Alert notices respect maintenance mode: ask `maintenanceActive` / `readMaintenance`, never the stored boolean. A "down now"
  notification kind joins `URGENT_NOTIFICATION_KINDS`; a test monitor that goes down on purpose sets `alerts: false`.
- Notifications go through `NotificationsService`; email is never sent inline.

**Web**
- Polling uses `usePoll`. Proxied calls use `apiFetch` / `forwardToApi` / `streamToApi`, never a hand-rolled `fetch`.
- A new inline `<script>` takes the CSP nonce.
- New screens pass the axe sweep (light and dark, 390 px); icon-only buttons have names; overlays use `DialogFrame`/`useModal`
  or a portal.
- When Signage behaviour changes, update its in-app Guide as well as `docs/signage.md`.

**Outbound and untrusted input**
- A connection to an address an admin typed goes through `apps/api/src/net/outbound.ts` and gets a case in
  `validateSettingValue`.
- Uploaded files and backups are untrusted. `.docx` and `.pdf` are parsed only in the sandbox (`convertInSandbox`).

**Operations and tests**
- A new bootstrap setting in `.env.example` or a new install step updates `install.sh` and its tests.
- A new service or config file is added to `scripts/rebuild.sh`.
- Never restore a backup against the live dev stack, push configuration to the real Cisco switches, or send live commands to a
  configured device from a test.

## Audit log

Every mutating action (POST/PUT/PATCH/DELETE that hits an audited route) writes a row to
`audit_log` via a NestJS interceptor. Schema: `(id, actor_user_id, action,
resource_type, resource_id, before, after, ip, user_agent, ts)`. Do **not** bypass the
interceptor; if you find yourself needing to, fix the interceptor instead.

The snapshot is the route's response, and `AuditService.write` runs `scrubSnapshot` (`audit/audit-scrub.ts`) on `before` and
`after` of every row: a string or object under a key that looks like a credential (`password`, `token`, `authorization`,
`community`, `secret`, `api key`, `cookie` ...) is stored as `[hidden]`. Nothing has to opt in; `redactKeys` on `@Audited` only
drops a key outright. A key that is only an identifier or count (`tokenId`, `prefix`) is left alone. Test: `audit-scrub.test.ts`.

A handler whose action depends on what the request turned out to do (the MCP
endpoint multiplexes reads and writes over one POST) calls
`startDynamicAudit(req)` and then `recordAuditEntry(req, {...})` per change
(`audit/audit.decorator.ts`); the interceptor then writes exactly those
entries instead of the route-level row, so a read-only request writes none.

## Activity feed

`GET /activity` and the home page's activity section go through `ActivityService.list(user, limit)`, which holds
each event to the read rule of the thing it is about (`visibleTo`): a note's event is only ever its owner's, a
ticket's is its creator's or a `tickets:read:any` holder's, a wiki page's follows visibility + ACL (or
`wiki:read:any`), infra/monitor events need `monitors:read:any`, and an event type the filter does not know is
visible to its actor only. **A new kind of event must be added to `visibleTo`**, or it stays private. Test:
`apps/api/test/activity-visibility.integration.test.ts` (needs `TEST_DATABASE_URL`; empties the tables it uses).

## Realtime rooms, mentions and polling

- **A browser joins only the rooms `ROOM_PERMISSIONS` lists** (`realtime.gateway.ts`), and `mayJoin` also checks the thing
  itself: `ticket:<id>` needs the ticket to be the person's or `tickets:read:any`, re-judged every 30 s. A room that holds
  people with different rights (a ticket's requester and its staff) carries **no content**: `ticket:changed {ticketId}`
  (`TicketEvents.changed`), and the page refetches through the routes that leave internal notes out. Never emit a comment
  body to a ticket room.
- **An @mention carries the text** (in-app and email), so `MentionsService.notify` takes `canSee(user)` and only tells people
  who could open what it is in: `mayReadComment` for tickets (an internal note is for `tickets:read:any` only), the page's
  own rule for wiki pages. Disabled, deleted and pending accounts are skipped; at most `MAX_MENTIONS` (20) handles per body.
  Ticket mentions are sent by `TicketEvents.commented` alone (the service used to send them too: every mention twice).
- **Client polling goes through `usePoll`** (`apps/web/src/lib/use-poll.ts`): it stops while the tab is hidden and catches up
  when it is shown, and `enabled: !connected` keeps a page that has a live socket from polling as well. A bare `setInterval`
  that fetches must at least skip `document.visibilityState === "hidden"`.

## Database

The app speaks the Postgres wire protocol (`pg` + Drizzle) and supports three
deployments, chosen by `DB_MODE` in `.env` and applied by `scripts/compose.sh`
(the Makefile, `rebuild.sh` and the `pnpm dev:*` scripts all go through it):

- `DB_MODE=bundled` (default): CockroachDB inside the stack (single node dev,
  3 nodes prod), in the `bundled-db` compose profile. `DATABASE_URL` is set for you.
- `DB_MODE=external` + `DATABASE_URL`: an existing **YugabyteDB** (YSQL, :5433)
  or **CockroachDB** cluster. The bundled profile is off.

Deployments never name the engine: `apps/api/src/db/connection.ts` reads
`DATABASE_URL` (falling back to the old `COCKROACH_URL`) and `detectEngine()`
classifies `SELECT version()` (`CockroachDB …` / `…-YB-…` / plain PostgreSQL).
Engine-specific behaviour is confined to `scripts/migrate.ts`:

- **YugabyteDB doesn't support DDL inside a transaction block** (each DDL bumps
  the catalog version and a long transaction gets aborted), but drizzle's
  migrator wraps *all* pending migrations in one transaction. On YugabyteDB,
  migrate applies statements one by one and records them in drizzle's own
  `drizzle.__drizzle_migrations` table with drizzle's rules; Cockroach and
  Postgres keep drizzle's transactional migrator. A YB migration that fails
  halfway leaves earlier statements applied, so prefer `IF NOT EXISTS`.
- **`gen_random_uuid()`** is built in on Cockroach and PG 13+ bases, but on
  YugabyteDB 2024.2 (PG 11 based) it needs `pgcrypto`, which migrate enables.

Portability rules for new SQL (verified against Cockroach 24.2, YugabyteDB
2024.2 LTS and 2026.1):
- No CockroachDB row-level TTL (`ttl_expiration_expression`). Retention lives in
  the app: infra metrics are pruned by `InfraCollector.prune()` (raw 7d, 5m
  rollups 90d, 1h rollups 365d). Migration 0030 originally set Cockroach TTL;
  installs that ran it keep it, harmlessly.
- No `DELETE … LIMIT` (Cockroach-only): batch with
  `WHERE (pk…) IN (SELECT pk… LIMIT n)`.
- No `LISTEN/NOTIFY` and no `DO $$` blocks (Cockroach < 24.3); no
  Cockroach-only syntax (`UPSERT`, `STRING`, `AS OF SYSTEM TIME`, `crdb_internal`).
- `count(*)::int` comes back as a string on Cockroach (INT8) and a number on
  YugabyteDB/Postgres (INT4): wrap with `Number()` when the value matters.

## Retention

Tables that only grow are pruned by age, in batches (`retention/batched-delete.ts`: portable `WHERE pk IN (SELECT pk ...
LIMIT n)` loops, capped per run), by cluster jobs, each window a setting where 0 keeps everything: audit log
(`audit.retention_days`, 365, in `AuditService`), notifications (`notifications.retention_days`, 180) and the activity
feed (`activity.retention_days`, 90), the last two in `RetentionService`, which also removes FINISHED monitoring history
(`monitoring.history_retention_days`, 365, edited at `/monitoring/settings`: resolved incidents, resolved Cisco drift, finished host update runs with their
output) and runtime rows on fixed windows (spent or expired invite/reset links after 30 days, finished backup operations after
180). An open incident or a running operation is never removed. The probe worker prunes `monitor_checks` itself, in batches
through `monitor_checks_ts_idx` (migration 0076). A new table that grows without bound needs a
window here (or in its own service, as infra metrics and mail do), not a one-off `DELETE`. Test:
`apps/api/test/retention.integration.test.ts`.

Emails are stored lower-case and "already in use" ignores case (admin create and `PATCH /me`): sign-in lower-cases what
is typed, so a mixed-case row could never be matched.

## Dependencies

- **`pnpm audit --prod`** is the check; pick versions published at least two weeks ago (`latest.py`-style: newest version
  whose npm `time` is older than the cutoff). Vulnerable transitive packages are pinned in the root `package.json`
  `pnpm.overrides`, scoped by major (`fast-uri@^3`), so a parent's range cannot pull a bad version back. Fixes still inside the
  two-week window are left for a later pass, never taken early.
- **`patches/`** holds `pnpm.patchedDependencies`, copied into every image before `pnpm install` (all three Dockerfiles):
  `@fastify/busboy` (its types augment `stream.Readable` with a `'limit'` event that hid `on()`/`once()` from TypeScript
  everywhere) and `drizzle-orm@0.45.4`: since 0.45 a failed query throws `DrizzleQueryError` whose message was the SQL **and
  its parameters** (row values in logs and in errors shown to admins) and whose `code` was gone (every `err.code ===
  "23505"` stopped matching). The patch makes the message the database's own and copies `code`. **A drizzle upgrade needs the
  patch regenerated for the new version.** `dbErrorCode`/`unwrapDbError` (`@lampstand/shared/db`) also read through `cause`.
- drizzle 0.45's `is()` walks the prototype chain, so a lazy `Proxy` standing in for a drizzle client must forward
  `getPrototypeOf` (`apps/web/src/lib/db.ts`; without it the Auth.js adapter refused the database and sign-in broke).
- `tsc --noEmit` in `apps/api` is incremental (`dist/.tsbuildinfo`) and can skip files: typecheck with
  `--tsBuildInfoFile /tmp/tsbi` (a throwaway file) to see every error.

## Repository hygiene

- **`.gitignore` entries for root folders are anchored** (`/backups/`, `/data/`, `/secrets/`). Unanchored, `backups/` hid
  the whole admin Backups page (`apps/web/src/app/admin/backups/`) and the Cisco backups page: they worked on the machine
  that wrote them and were missing from every clone (a fresh install's `/admin/backups` was a 404). `make check-repo`
  (`scripts/check-ignored.sh`, also run by `tests/installer/dry-run.sh`) fails if any source file is ignored. Before saying a
  feature is pushed, `git status` must show it tracked; tests run on a working copy do not prove a fresh clone has it.

## Conventions

- **Type-safe everywhere.** No `any` in committed code. Use Zod schemas from
  `packages/shared` for request/response validation on both sides.
- **Portable SQL only: it must run on CockroachDB *and* YugabyteDB.** See
  ## Database for the specific traps (no LISTEN/NOTIFY, no row-level TTL, no
  `DELETE … LIMIT`, no DO blocks). Prefer Drizzle helpers.
- **No `tenant_id`.** Single-tenant only.
- **Church-specific modules stay deferred.** Bespoke volunteer scheduling, kids
  check-in, and service planning are out of scope (decided 2026-05-25). The
  read-only Planning Center integration and the generic per-event checklists are
  the deliberate exceptions already shipped — don't add more church-domain
  features (or "in case we need them" hooks) without an explicit ask.
- **HTTPS is upstream.** Inside this stack everything is HTTP. Do not set `Secure`-only
  cookies or HSTS headers from this app — that is the load balancer's job. Cookies must
  still be `HttpOnly` and `SameSite=Lax`.
- **Single port 8100.** Caddy is the only thing bound to a host port. Every other
  service is internal to the compose network.

- **A module's own settings live in the module** (`/<module>/settings`); Admin is for site-wide settings only. How:
  [.claude/rules/platform.md](.claude/rules/platform.md).
- **Outbound connections to an admin-typed address use the one guard** (see "Rules every change must follow").

- **No emoji in code.** Per repo conventions.

## Common commands

All commands assume you're at the repo root.

```bash
# dev stack (bundled Cockroach single node unless DB_MODE=external). No bundled
# mail sink — configure SMTP in /admin/settings (or leave blank to disable email).
# Every compose call goes through scripts/compose.sh (applies DB_MODE).
pnpm dev:up               # scripts/compose.sh up -d --build
pnpm dev:down             # stop + remove
pnpm dev:logs             # tail all services
pnpm dev:psql             # SQL shell (cockroach sql, or psql for an external DB)

# migrations
pnpm db:generate          # drizzle-kit generate (after editing schema TS)
pnpm db:migrate           # apply pending migrations
pnpm db:seed              # bootstrap admin + default groups & per-module access

# tests
pnpm test                 # unit tests (vitest)
pnpm test:smoke           # API/HTTP smoke tests against running stack
pnpm test:e2e             # Playwright e2e against running stack
pnpm regression           # smoke + e2e (used by CI and post-build verification)

# typecheck / lint
pnpm typecheck
pnpm lint
```

If `pnpm` is not installed on the host, every command above has a docker-only
equivalent — see [INSTALL.md](./INSTALL.md).

### Fast iteration after code changes

`make rebuild` is the preferred command to apply a code change to the running
stack. It diffs file mtimes against the `.last-rebuild` marker and only invokes
`--build` for services whose source actually changed (api, web, or both via a
`packages/shared/` edit). It also runs migrations only when there's a new SQL
file since `.last-migrate`. Both markers are gitignored.

Use `make rebuild-all` if you want to force a full rebuild of both services.
Avoid `docker compose -f infra/docker-compose.yml up -d --build api web` —
that wastes 5–15 s per build verifying the cache for the service that didn't
change. `make rebuild` does the right thing in all cases.

## Roadmap / status

- **Phase 0 — done** — auth, access control, audit log, theme shell, compose stack, regression suite
- **Phase 1 — done** — helpdesk/tickets (+SLAs), notes, wiki (+attachments/ACLs), modular dashboard tiles, notification centre + SMTP (per-category in-app/email)
- **Phase 2 — done** — monitoring (ICMP/TCP/HTTP) + incidents, UniFi views, printer (SNMP) status, ProPresenter adapter, Planning Center
- **Phase 3 — done** — Meilisearch across wiki/notes/tickets **and all monitoring data points** (monitors, infra, UniFi devices/clients, Cisco switches/ports/MAC/ARP/VLAN — see ## Search), @mentions, tags, activity feed, saved views, checklists, backups and restore.
- **MCP server — complete (2026-10-15)** — the route bridge covers the whole app (reads, writes, an "operational" token level for equipment, read-only admin); see ## MCP server and [docs/mcp.md](docs/mcp.md).
- **Module settings inside the module — complete (2026-11-09)** — every module's settings and admin pages live in the module; Admin is for site admins and site-wide settings; see [docs/module-settings.md](docs/module-settings.md).
- **Assistant (chatbot) — phases 1-3 built (2026-10-25/26)** — see ## Assistant and section 0 of [docs/assistant.md](docs/assistant.md); embeddings, replayed evaluation, API-token access and other channels are not built; do not start them without an explicit ask.
- **Service monitoring templates — built (2026-10-26)** — see "Service monitoring" under ## Access control; service groups across hosts, the home-page Services area and catalogue wave two also built (2026-10-26); group roles per template, the redundancy warning, groups on the status page, in search and in the availability history (2026-10-27).
- **Signage — built against simulated Pis (2026-11-08)** — see **Signage** under ## Access control and section 0 of [docs/signage.md](docs/signage.md); untested on real Pis and TVs until hardware arrives.
- **Phase 4 — deferred** — bespoke church-specific modules. Do not start without an explicit ask.

Infra threshold *actions* (running something when a rule breaches) are deferred: see
[.claude/rules/monitoring.md](.claude/rules/monitoring.md). Do not start them without an explicit ask.

## Public origin / hostname handling

No hostname is baked into env or code, and `AUTH_URL` / `APP_URL` are intentionally unset in `.env.example`. Caddy passes the
original `Host`, and `withPublicOriginRewrite` (`apps/web/src/lib/auth.ts`) rewrites `/api/auth/*` URLs from it. After any
change to the proxy or how the Next server starts, test sign-in from two hostnames. Detail:
[.claude/rules/platform.md](.claude/rules/platform.md).

## Host ports

Only one port on the docker host belongs to a real user: `EXTERNAL_PORT` (default
`8100`) for Caddy. The dev compose also exposes `COCKROACH_UI_PORT` (8180) as a
convenience when the bundled database runs, bound to `127.0.0.1` only because the
insecure-mode UI has no login (reach it over an SSH tunnel). Both are env-overridable.
`scripts/compose.sh` passes `--env-file .env`, so the root `.env` feeds the `${VAR}`
interpolation in both compose files (compose would otherwise look in `infra/`).

`scripts/check-ports.sh` runs automatically as part of `make up` (and `make prod-up`).
It distinguishes three states per port: free, held by one of our own containers
(re-up is safe), or taken by something else (abort with a suggested free port + env
var to set). Never bypass this check — port collisions surface late and confusingly.

Internal container ports (Next.js `:3000`, NestJS `:3001`) are NOT bound on the host;
they live on the `lampstand_internal` bridge. Do not add `ports:` entries for them in
compose — that would defeat the single-ingress design.

## Operational defaults

- **Default admin:** seed creates user `admin` with password `admin` (stored as
  `admin@local`) and `must_change_password=true`. The first sign-in is force-routed to
  `/change-password`. `make reset-admin` restores this state — **only** if the operator
  explicitly asks. **Automated tests never touch the admin user's password.**
- **Regression test user:** smoke + e2e tests sign in as `regression-test@local`
  (created/refreshed by `make reset-test-user`, which is the first step of
  `make regression`). The bootstrap admin's credentials are immutable from the
  test suite's perspective — verified by setting a real admin password and
  running the full suite; admin password is preserved end-to-end.
  The user is reset with `must_change_password=true`: the smoke suite asserts
  the gate blocks writes, then changes the password itself; `make regression`
  resets the user again before e2e, which tests the browser change-password
  flow. Smoke tests that touch optional integrations (UniFi, ProPresenter,
  DNS) branch on whether they're configured, and never send live commands
  (e.g. ProPresenter "next") to a configured device.
- **API rate limit:** `auth.rate_limit_per_minute` (default 1200, floor 60) is
  read live by @fastify/rate-limit; sign-in/TOTP/password-change have a fixed
  10/min bucket. The smoke client waits out 429s via `retry-after`.
- **Configuration:** anything an operator might want to change at runtime lives in the `settings` table, never in env.
  Site-wide values (Google/Microsoft OAuth, SMTP, site name, sign-in policy, backups, upload types, home page defaults, retention) are
  edited at `/admin/settings`; a module's own values are edited on that module's Settings page (see Conventions, "A module's own
  settings live in the module"). Only true bootstrap values (DB URL, `AUTH_SECRET`, `APP_URL`)
  stay in `.env`. `KNOWN_SETTINGS` in `packages/shared/src/settings.ts`
  is the catalogue.
- **Volumes:** all stateful services bind-mount into `./data/<service>/` at the repo
  root. Backup = `tar -czf data/`. `make init-data` creates the dirs with the right
  perms (Meilisearch needs a world-writable dir).

## Things to never do

- Restore a backup in a test against the live dev stack (use the throwaway cluster)
- Start the production compose stack from this checkout on the dev host (it shares `./data` with the
  live dev stack): use `tests/cluster/sim.sh`
- Add `tenant_id` columns
- Bypass the audit interceptor
- Set HTTPS/HSTS/TLS config inside the app (it's offloaded upstream)
- Expose any service besides Caddy to the host
- Hard-code role/group names in business logic (guard on permission strings derived from module tiers), or read the legacy `roles`/`permissions`/`role_permissions`/`group_permissions` tables
- Use SQL that only one of CockroachDB / YugabyteDB accepts
- Add Phase 4 church-specific modules without an explicit user ask
- Commit emojis in code or generated files
- Re-introduce env-based config for things in `KNOWN_SETTINGS` — they belong in the DB
- Add a bare `setInterval`/`setTimeout` loop for work that must not run twice at once — use `ClusterJobs` (see ## Cluster coordination)
