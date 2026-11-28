---
paths:
  - "apps/{api,web}/Dockerfile"
  - "services/monitor/Dockerfile"
  - "**/.dockerignore"
  - "apps/web/entrypoint.sh"
  - "apps/web/next.config.mjs"
  - "apps/web/src/middleware.ts"
  - "infra/caddy/Caddyfile"
  - "apps/web/src/lib/{auth,load-module-settings}.ts"
  - "apps/api/src/{net,settings,propresenter,planning-center}/**"
  - "packages/shared/src/{contact-host,settings}.ts"
  - "apps/web/src/components/{module-settings,settings-form}.tsx"
  - "apps/web/src/app/**/settings/**"
  - "apps/api/test/{outbound,contact-host,settings}*"
  - "apps/api/test/lan-address.ts"
---

# Containers, page policy, module settings, outbound connections, public origin

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

## Containers and the page policy

- The api, web and monitor images run as the unprivileged `node` user on `node:22-alpine`. Nothing writes under `/app`
  except the web's `.next/cache`. The IPAM/monitor ping works unprivileged through Docker's default
  `net.ipv4.ping_group_range`; `NET_RAW` stays in compose for runtimes that restrict that. A new feature that
  writes to the container filesystem must use `/tmp`, an S3 key or the database.
- **Image layers are ordered by how often they change** (reworked 2026-10-24; a one-line api edit used to write a 166 MB layer, web 82 MB,
  and the monitor reinstalled its dependencies on every build). Rules: (1) production dependencies come from a stage that sees only
  manifests and the lockfile (api: `proddeps`, `pnpm deploy` of the manifests; monitor: `pnpm install --prod` before any code is copied),
  so that layer changes only with a dependency. (2) `@lampstand/shared` is built in its own stage (`shared-build`) in all three images, and
  the api puts the built package over the stub `pnpm deploy` leaves in `node_modules/.pnpm/@lampstand+shared@file+packages+shared/` (a
  `require.resolve` RUN fails the build if pnpm ever names that directory differently). (3) The web ships `standalone/node_modules` as
  its own layer, apart from the server code. (4) **`ARG BUILD_ID` goes after the last `RUN` of a runner stage**: the id changes every
  commit, and an ARG is part of the cache key of every RUN below it. (5) `next build` keeps `.next/cache` in a BuildKit cache mount
  (`next-build-cache`, `sharing=locked`); the output was compared with and without it and differs only where the build id is embedded.
  Do NOT cache the api's `dist` or `tsbuildinfo` the same way: tsc's incremental emit would keep stale files from deleted sources, and
  two nodes would then build different images from one commit. (6) `apps/api/test` and the web `*.test.ts(x)` are in `.dockerignore`, so
  editing a test rebuilds nothing. A `docker builder prune` empties the Next cache (the next web build is cold, about 3 minutes).
  What is left in a web build (~2 minutes): compile ~35 s, type check ~26 s, build traces ~25 s, page data ~10 s. Measured with a
  throwaway compose file; there is no `docker buildx` on the dev host, so `docker build` does not work, only `docker compose build`.
- **Content-Security-Policy:** `apps/web/src/middleware.ts` gives every page a per-request script nonce
  (`script-src 'nonce-...' 'strict-dynamic'`, no `unsafe-eval`) and Next applies it to its scripts; the layout hands it
  to the theme bootstrap. Caddy sends a looser baseline on every response as well (the browser enforces both). **A new
  inline `<script>` must take the nonce** (read `x-nonce` from `headers()`); the smoke suite fails on a bare one.
  Styles stay `unsafe-inline`.
- `/api/v1/auth/providers/internal`, `/auth/verify-credentials`, `/users/ensure-default-group` and `/users/oauth-provision`
  are 404 at the proxy (and token-gated in the api); a new internal-only route belongs in Caddy's `@internal_only` matcher too.
- `/api/v1/metrics` (Prometheus) needs `site:admin`: scrape it with a read-only API token of an admin-group account. `/_next/image`
  is 404 at the proxy and `images.unoptimized` is set (the app never uses `next/image`; the optimizer had RCE advisories).

- **A module's own settings live in the module** (plan, decisions and per-module status: [docs/module-settings.md](../../docs/module-settings.md)). A page
  `/<module>/settings` is built from `ModuleSettingsPage` / `SettingsFormSection` (`components/module-settings.tsx`), `loadModuleSettings(settingKeysOf(category))`
  (secrets masked on the server) and the shared `SettingsForm` (saves to `/api/settings/save/<key>`, tests to `/api/settings/test/<target>`); the module's admin
  permission authorises its category (`SETTING_CATEGORY_MANAGE_PERMISSION`) and the module page links to it for admins only. Done: Signage, Printers, ProPresenter,
  Livestreams, Planning Center (its people links are `/planning-center/links`), Help Desk (`/tickets/settings`: SLA targets and the mailbox; `/tickets/categories`), Wiki (`/wiki/settings`), Assistant (`/assistant/settings`, `/assistant/usage`), Checklists (the admin pages are `/checklists/manage/*`, a tab row), Monitoring (`/monitoring/settings` for checks, retention and alerts; `/monitoring/network/settings` UniFi, `/dns/settings`, `/ipam/settings`, `/monitoring/ups/settings`). **Do not add a module to `admin/settings/categories.ts` or the Admin menu**; Admin (hub, menu and settings list) is for site admins and site-wide settings only (site, auth, Google, Microsoft, SMTP, backups, attachments, home page defaults, retention, push, monthly report). Never pass a lucide icon into a client component (a server page does that): keep the page shell server-rendered. Old `/admin/...` addresses
  redirect in `next.config.mjs`.
- **Outbound connections to an address an admin typed go through ONE guard** (reviewed 2026-11-15; before it, three hand-written checks had drifted apart
  and ProPresenter's host was pasted into a URL unchecked, so `api:3001/api/v1/readyz#` as the host would have made the dashboard fetch its own API).
  Pure rules in `packages/shared/src/contact-host.ts` (`contactHostProblem`, `contactUrlProblem`, `STACK_HOST_NAMES`; `blockedAddress` in
  `schemas/livestream.ts` parses IPv6 properly and unwraps mapped, IPv4-compatible, NAT64 and 6to4 forms) refuse this machine, link-local
  (cloud metadata), multicast and the stack's own containers, and are used at SAVE time (`validateSettingValue` for `propresenter.host`,
  `unifi.controller_url`, `dns.primary_url`, the mailbox host, alert destinations, livestream links). **The API connects only through
  `apps/api/src/net/outbound.ts`** (`outboundFetch`, `outboundAgent`, `assertOutboundHost`): its socket `lookup` judges the address it is really
  connecting to (no check-then-resolve-again gap, so DNS rebinding does not work), redirects are followed for a GET only (3 hops, each host
  checked) and never for anything else; **a redirect to another origin keeps only harmless headers** (`headersForRedirect`, so a connector's
  key never follows; the same host moving from http to https keeps them). A NEW connector that takes a host or URL from settings or a form uses it and gets a case in
  `validateSettingValue`; never `fetch(`${host}...`)`, and never build a URL by pasting a typed host into a string (`propresenterUrl` allows
  letters, digits, dots and dashes only). `allowShortNames` keeps `pp7-mac`-style one-word LAN names working for the connectors that always
  accepted them; the stack's container names stay refused by name. A fake device in a test must listen on `lanAddress()` (`test/lan-address.ts`),
  not 127.0.0.1. **Known gap:** yt-dlp and ffmpeg (livestreams) resolve and follow redirects themselves, so they get the pre-check
  (`assertFetchableHost`) but not the pinned connection; a Livestreams moderator could still reach a host through a redirect (blind, no
  response). Tests: `outbound.test.ts`, `contact-host.test.ts`, `alert-channels.test.ts`, smoke `alert-channels.mjs`.

## Public origin / hostname handling

The app **does not bake any hostname into env or code**. It works at every URL
you can reach it on — `localhost:8100`, a LAN IP, `docker01.example.com:8100`,
behind an HTTPS LB — without any per-deployment config.

How it works end-to-end:
- Caddy listens on `:8100` and reverse-proxies to the upstream containers with
  `header_up Host {host}`, so `web` and `api` see the original `Host` header
  from the user's browser.
- Next.js standalone is the gotcha: it sets `req.url` from `HOSTNAME:PORT`
  (`0.0.0.0:3000`), not from the request's `Host` header. Auth.js builds OAuth
  callback URLs, sign-in redirects, and cookie domains from `req.url`, which
  would leak the bind address out to the browser and break every sign-in.
- The wrapper `withPublicOriginRewrite` in [apps/web/src/lib/auth.ts](../../apps/web/src/lib/auth.ts)
  intercepts every `/api/auth/*` request, rewrites `req.url` using
  `X-Forwarded-Host` (set by Caddy from the original Host) + `X-Forwarded-Proto`,
  and only then hands off to Auth.js. Result: the redirect/cookie/callback URL
  always matches the host the user actually typed.
- `AUTH_URL` and `APP_URL` are **intentionally unset** in `.env.example`. Setting
  them would override the dynamic detection and re-introduce the original bug.
  Only override if a proxy strips/rewrites both `Host` AND `X-Forwarded-Host`.

If you ever change the proxy or the way the Next standalone server starts:
re-test sign-in from **at least two different hostnames** (e.g. localhost and a
non-localhost domain) before merging. The smoke suite covers the localhost case;
the wrapper itself is non-trivial to unit-test, but the symptom — being
redirected to `http://0.0.0.0:3000/` — is obvious in the browser address bar.
