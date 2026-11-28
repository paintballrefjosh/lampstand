---
paths:
  - "apps/api/src/{notifications,mailer,dashboard,availability}/**"
  - "apps/web/src/app/{home,dashboard-tiles,notifications}/**"
  - "apps/web/src/app/page.tsx"
  - "apps/web/src/app/me/{notification,push,home-look}*"
  - "apps/web/src/app/api/{dashboard,notifications}/**"
  - "apps/web/src/components/command-palette.tsx"
  - "apps/web/src/lib/{palette,push}*"
  - "apps/web/public/sw.js"
  - "apps/web/public/home-looks/**"
  - "packages/shared/src/notification-delivery.ts"
  - "packages/shared/src/dashboard/**"
  - "packages/shared/src/schemas/{notification,dashboard}.ts"
  - "apps/api/src/db/schema/{notifications,dashboard,availability}.ts"
  - "apps/api/test/{notification,push,home,dashboard,availability,mail}*"
  - "scripts/check-look-contrast.mjs"
  - "tests/smoke/{notification-delivery,home-prefs,home-snapshot}.mjs"
  - "tests/e2e/tests/{home,palette,notification,dashboard}*"
---

# Notifications, command palette, home page looks

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

**Notification delivery: quiet hours, daily summary, push** (migration 0068; rules in `packages/shared/src/notification-delivery.ts`, unit-tested in
`apps/api/test/notification-delivery.test.ts`). Channels per kind are `in_app`, `email`, `push` (push opt-in: a kind with no saved row never pushes).
**All routing goes through `NotificationsService.create/createMany`**: in-app is always immediate and silent; **push is sent immediately except during
quiet hours, and is then DROPPED, not queued** (`pushAllowed`); **email is held in `notification_held` when `emailReleaseAt` says it is not due yet**
(quiet hours, or a daily summary) and sent by the `notification-release` cluster job (60 s). A held row stores what the email says, never a release
time: due-ness is recomputed from the person's CURRENT `notification_delivery` row (quiet start/end, summary time, `urgent_through`, minutes after
midnight on the SITE zone `site.timezone`), so changing settings applies to waiting mail. Rows are CLAIMED by deleting them before sending (two nodes
never double-send; a crash loses at most that email, the bell has it); one held notice goes as itself, two or more as one summary (`HELD_EMAIL_MAX_ITEMS`);
anything held over 3 days is released regardless. `URGENT_NOTIFICATION_KINDS` (down alerts: services, infra thresholds, UniFi/Cisco devices offline, cluster nodes, DNS primary) skip quiet hours and the summary unless the person turned
`urgent_through` off. **A new kind that means "something is down now" belongs in that list.** *Push* (`notifications/push.service.ts`, `web-push` pinned):
the VAPID key pair is DERIVED from `AUTH_SECRET` (`vapid.ts`; the derivation strings never change; rotating the secret orphans subscriptions, which are
removed when the push service answers 404/410), so there is no key storage and every node agrees. **A subscription endpoint is user-supplied and the server
POSTs to it, so only `isAllowedPushEndpoint` hosts (FCM, Mozilla, Apple, Windows) over https/443 are accepted: never loosen that (SSRF).** Routes `/me/push/**`
are `@SessionOnly` and MCP-excluded; `GET|PUT /me/notification-delivery` are ordinary tools. `push_subscriptions` and `notification_held` are `skip` in the
backup registry (device credentials / a queue), `notification_delivery` is data. The page list never returns an endpoint (only `endpointFingerprint`). The
service worker (`apps/web/public/sw.js`) handles `push` and `notificationclick` (only same-origin URLs); `/sw.js` is a PUBLIC middleware path (behind the
sign-in redirect a browser refuses to register it). Tests: `notification-delivery.integration.test.ts` (CockroachDB and YugabyteDB), `push.test.ts`
(derivation, a verified VAPID signature, the endpoint allowlist), smoke `notification-delivery.mjs`, e2e `notification-delivery.spec.ts` (the browser's push
manager is stubbed: headless Chromium has no push service and refuses subscribing in incognito; a real device round trip was never run).

**Command palette** (`apps/web/src/components/command-palette.tsx`; what it offers is decided ONLY by the pure `paletteCommands` in `apps/web/src/lib/palette.ts`,
unit-tested in `palette.test.ts`). A `go` command needs the module (any tier; admin pages need `access.admin === "admin"`); a `run` command reuses an existing
audited route and is offered by PERMISSION STRING from `GET /me` (read when the palette opens), never by tier guesses: pausing alerts needs `monitors:write:any`,
which is the monitoring ADMIN tier. The route still decides; a failure is shown in a toast. **An action that changes what other people see (pausing alerts) must
set `confirm`**, which shows a confirmation step (Escape backs out of it first). Page context comes from the address (`currentThing`: `/tickets/<uuid>`,
`/wiki/<uuid>...`). A new action = a `RunCommand` here, a case in `execute`, a test. The palette sets `data-palette-ready` on `<html>` once Ctrl+K is heard (tests
wait for it); the dialog wrapper itself has no size, so assert on the search box, not the dialog. e2e `palette.spec.ts`.

## Home page looks

The home page (`/`) can be shown in six looks that each person picks (plan and decisions: [docs/dashboard-themes.md](../../docs/dashboard-themes.md);
the original concepts: `docs/dashboard-concepts/`): `tiles` (the original draggable grid, `app/dashboard-tiles/`), `start`, `nave`,
`toward-sunday`, `glass` and `front-of-house` (`apps/web/src/app/home/looks/<id>/`). Rules for changing them:

- **One snapshot, many renderers.** `GET /api/v1/dashboard/home?include=` (`apps/api/src/dashboard/home/`) returns a `HomeSnapshot`
  (`packages/shared/src/dashboard/home.ts`). Every section is `{state:"ok",data}` or `unconfigured|unavailable|forbidden`, is
  permission-gated in its own builder (`sections/*.section.ts`) and runs under a 2.5 s timeout, so one slow source costs only its
  section. Optional parts (`week`, `readiness`, `availability`, `meters`) are built only when a look asks for them. Looks are
  presentation only: they read the snapshot through `useHomeSnapshot` (30 s poll, window focus, `monitoring`/`infra` realtime
  signals; never the `network` room, which turns the UniFi poller on) and never fetch their own data. The rules (what "needs you"
  means, the summary sentence, week events, readiness, availability buckets, meter scales) are pure functions in
  `packages/shared/src/dashboard/`, tested in `apps/api/test/home-*.test.ts`.
- **Cost control (measure with a signed-in script before changing: the snapshot was ~600 ms for every poll).**
  (1) `HomeService.snapshot` coalesces identical simultaneous requests (same person, access and `include`) into one
  build and keeps nothing afterwards, so a refetch after an action always sees its effect: never add a TTL there.
  (2) Sections whose answer is the same for everyone who may see them (`systems`, `meters`, the availability and
  week-incident reads) are computed once per few seconds (`SYSTEMS_SHARED_MS`, `METERS_SHARED_MS`,
  `WEEK_SHARED_MS`, `HOURLY_READ_CACHE_MS`) and shared; the permission gate stays outside the cache, and anything an
  action changes (maintenance mode, the write flag) is read live. A new section that is the same for everyone
  belongs behind a `TtlCache` like these; one that depends on the person (tickets, checklists, wiki ACLs) does not.
  (3) Reads of other systems use `TtlCache.get(..., { failTtlMs, deadlineMs })`: a dependency that is down or slow
  costs one wait per window, not one per request, and is not asked again meanwhile. The cache is bounded
  (`maxEntries`). Cached arrays/objects are shared between callers: never mutate what a cached read returns.
- **Nothing is faked.** A section that is not `ok` is hidden or says why in one plain line. `unavailable` with reason
  "no upcoming service" means nothing is scheduled that this person can see: hide, never "can't be reached".
- **Actions reuse existing audited routes** (UniFi ack, take a ticket, tick a checklist task, maintenance mode) through
  `home/parts/need-action.tsx` and the looks. The only new write is `PUT /dashboard/prefs` (audited `dashboard.prefs.update`).
- **Choosing a look:** `?theme=` (preview, not saved) > the device cookie `lampstand_home_look` ("use on this device only",
  `/api/dashboard/device-look`) > `dashboard_prefs.theme` > setting `dashboard.default_theme`. A look missing from
  `dashboard.enabled_themes`, or whose `requires` the person lacks (Glass and Front of House need `monitors:read:any`), falls
  through; `start` is the last resort (`resolveLook` in `packages/shared/src/dashboard/themes.ts`). `?kiosk=1` hides the nav for a
  booth screen. `dashboard_prefs.sections` holds each person's hidden optional sections per look (`optionalSections` in the
  catalogue; unknown ids are dropped).
- **Every look ships light and dark:** two complete token sets in its CSS Module (`.root` and `:global(.dark) .root`), WCAG AA
  checked by `scripts/check-look-contrast.mjs` (list new text/background pairs there), fonts via `next/font/google` inside the
  look's folder (only that look's chunk loads them), motion only inside `prefers-reduced-motion: no-preference`, and no
  horizontal scroll at 390 px. Check a change in both schemes.
- **Time** is shown in `site.timezone` (IANA name; `zoned.ts` helpers are DST-safe). Format dates from `zonedParts` by hand, not
  with `Intl` presets in rendered text: Node and the browser ship different ICU data, and a differing comma caused a React
  hydration error (#418).
- **Availability history:** `AvailabilitySampler` (`apps/api/src/availability/`, `ClusterJobs` jobs `availability-sample` every
  minute and `availability-prune`, 8 days) adds one up/down sample per system to `availability_hourly`; Glass's window and Toward
  Sunday's health strips read it. A source that is unconfigured or unreachable records nothing ("no data"), never "down".
- **Picker thumbnails show a generic person and generic device names** (`apps/web/public/home-looks/<id>-light|dark.png`, 720x450, shot at
  1280x800 and downscaled with LANCZOS: Chromium's fractional device scale factor kerns text badly). Re-shoot them signed in as the
  regression user with `?theme=<id>`, and before each shot rewrite the page's text: the person is "Alex" / `alex.morgan@example.org`, real
  device and host names become `Office AP`, `Main UDM Pro`, `*.example.org`. Never commit a thumbnail that shows a real name or host.
- **Adding a look:** a `LOOK_IDS` entry and `DASHBOARD_LOOKS` definition (requires, includes, optionalSections, thumbnails
  `apps/web/public/home-looks/<id>-light|dark.png`), a folder under `looks/` whose root carries `data-look="<id>"`, an entry in
  `home-root.tsx`, and an e2e spec `tests/e2e/tests/home-<id>.spec.ts` that never performs a real action.
