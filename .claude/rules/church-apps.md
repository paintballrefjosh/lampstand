---
paths:
  - "apps/api/src/{assets,livestreams,signage}/**"
  - "services/signage-agent/**"
  - "apps/web/src/app/{assets,rooms,livestreams,signage}/**"
  - "apps/web/src/app/api/{assets,locations,livestreams,signage}/**"
  - "apps/web/src/components/assets*"
  - "apps/web/src/lib/{qr,signage}*"
  - "packages/shared/src/signage/**"
  - "packages/shared/src/schemas/{asset,location,livestream}.ts"
  - "apps/api/src/db/schema/{assets,livestreams,signage}.ts"
  - "apps/api/test/{assets,livestreams,signage}*"
  - "apps/api/test/fixtures/livestreams/**"
  - "apps/api/livestream-tools.txt"
  - "tests/signage/**"
  - "tests/smoke/{assets,livestreams,signage}.mjs"
  - "tests/e2e/tests/{assets,livestreams,signage}*"
  - "apps/web/src/components/guide.tsx"
---

# Rooms and equipment, livestreams, signage

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

**Rooms and equipment** (`apps/api/src/assets/`, pages `/assets` ("Equipment" in the IT menu) and `/rooms`, migration 0082; design and
decisions in [docs/assets.md](../../docs/assets.md); rules and CSV parsing in `packages/shared/src/schemas/{asset,location}.ts`, unit-tested in
`apps/api/test/assets.test.ts`). Module `assets`: user tier = `assets:read:any` + `assets:checkout:own` (every volunteer sees the
inventory and checks out to and back from THEMSELVES), moderator = `assets:write:any` (add/edit, check out to anyone or a typed name,
see cost, purchase date and history), admin = `assets:admin` + `locations:admin` (delete, import, edit rooms). Reading rooms needs only a
session. Rules: (1) **one open check-out per item is the database's rule** (partial unique index `asset_checkouts_open_idx`); a 23505
is the "just checked out to ..." 409, returning is a conditional UPDATE. (2) Cost and purchase date are null in every answer to a
non-staff reader (`toDto`), never only hidden in the UI; search never indexes them. (3) A room is `location_id` (ON DELETE SET NULL)
on tickets, assets, racks, monitors, infra hosts and printers, checked by `checkLocation`/`LocationsService.check`; **a Cisco switch's
`location` is its snmp-server location, not a room**. Cabinets keep `racks.location` equal to the room name for older nodes, and the
`locations-adopt` job turns leftover text into rooms (CockroachDB cannot write a column added in the same migration transaction, so
the conversion is not in the migration). (4) Overdue reminders: job `asset-overdue` (hourly), CLAIM `reminded_for` = the due date
before sending (kind `asset.overdue`), 30+ days overdue when first seen = flagged silently. (5) Import is parsed and checked in the
browser (`parseAssetCsv`), sent as JSON (2000 rows, under the 1 MiB body limit), applied in one transaction. (6) Labels and room signs
are print pages whose QR SVG is made on the server from the request's own address (`lib/qr.ts`). (7) Search kind `asset`
(`ASSET_KINDS`, `canSeeAssets`); writes call `SearchService.assetsChanged()`. (8) Retention: returned check-outs after 3 years. MCP has
read and create/update tools (`catalogue/assets.tools.ts`); check-out, return, due date, import and deletes are excluded. Tests: smoke
`tests/smoke/assets.mjs` (a throwaway volunteer account proves the own-only rules), e2e `assets.spec.ts`.

**Livestreams** (`apps/api/src/livestreams/`, page `/livestreams` in the Church Apps menu, migration 0084; design, platforms and what was not
verified in [docs/livestreams.md](../../docs/livestreams.md); rules in `packages/shared/src/schemas/livestream.ts`, unit-tested in
`apps/api/test/livestreams.test.ts` against REAL ffmpeg output in `test/fixtures/livestreams/`). Module `livestreams` (user reads, moderator
adds/edits/checks now, admin deletes and owns the `livestreams` settings: optional YouTube/Twitch/Facebook/Resi keys). Rules: (1) **it runs in
the API** (`livestream-checks` job, 10 s ticks; the worker cannot decrypt a private link or notify): a stream is CLAIMED with `claimed_until`
before it is read; status on its own clock (yt-dlp `-J` on a page, or a GET of an HLS/DASH link), and while live a sample (ffmpeg:
freeze/black/loudness/silence/per-channel level plus one JPEG still) on another. (2) **A problem is confirmed by two samples in a row**
(the second 30 s after the first), "not live" only inside a schedule window past its grace minutes, "cannot be read" after three
failures (`confirmedProblems`); outside its hours nothing is read and an open alert closes silently. (3) Alerts (`livestream.problem`,
urgent, an outage kind) go to the stream's group, else Monitoring's recipients, CLAIMED through `alerted_problem` (`alertMarker`).
(4) **yt-dlp and ffmpeg run with an argument array, an empty environment, a time limit and an output cap**; ffmpeg only on network
protocols; addresses go through `streamUrlProblem` + `assertFetchableHost` (no loopback, link-local, one-word container names, also after
DNS and on each redirect; LAN allowed for encoders). yt-dlp is pinned by hash in `apps/api/livestream-tools.txt` (venv `/opt/ytdlp`); YouTube
breaks old versions, so update the pin when pages stop reading. (5) The private link is `stream_url_enc` (encrypted, never returned,
`[saved]` keeps it). (6) Nothing is ever sent that starts, stops or changes a stream (Resi's Go Live routes are never called).
Tests: `livestreams.integration.test.ts` (CockroachDB and YugabyteDB), smoke `tests/smoke/livestreams.mjs` (never reads a stream), e2e
`livestreams.spec.ts`.

**Signage** (`apps/api/src/signage/`, the Pi agent in `services/signage-agent/`, pages under `/signage` in the Church Apps menu, migrations
0091 and 0092; design, decisions and the hardware checks still to run in [docs/signage.md](../../docs/signage.md) section 0; rules in
`packages/shared/src/signage/`, unit-tested in `apps/api/test/signage-*.test.ts`). **Built 2026-11-08 against simulated Pis only: nothing has
run on a real Pi or TV yet.** The module has an in-app **Guide** tab (`/signage/guide`, built from `components/guide.tsx`; settings tables come from the catalogue; admin-only parts hidden from others): when Signage behaviour changes, update the guide as well as docs/signage.md. Other modules get a Guide tab the same way. Module `signage` (user reads, moderator edits content, admin owns devices, discovery, settings, key and releases);
a non-system `signage` group holds moderator. Rules: (1) **Pis run stock Raspberry Pi OS Lite (or the full desktop image, which setup switches to console boot) and never contact the dashboard**: it finds them
(`signage-discover`: private subnets, /22 at most, knocks on port 22, never signs in; **only a host that looks like a Pi** (Pi MAC, a matching name, our setup banner: `isLikelyPi`) is listed, counted, marked New and announced, other SSH hosts wait in a collapsed "Other SSH hosts" section, and known equipment (IPAM gateways, Cisco switches, UniFi devices, monitored hosts) is skipped unless its address was typed in by hand), sets them up ("Adopt" in the UI since 2026-11-11; the code, routes and data still say `setup`) over SSH with the saved setup login once,
then manages them with its own Ed25519 key, DERIVED from `AUTH_SECRET` per generation (`ssh-key.ts`; the derivation strings never change;
"Make a new key" moves to the next generation). Host keys are pinned (`host_key` problem + "Trust the new host key"). Every command is
`signage-ctl <cmd>` with one JSON answer; with "restrict key" on, that is all the key may run. (2) **Settings live in the module**
(`/signage/settings`, `/signage/security`, category `signage`, `SIGNAGE_SECURITY_KEYS`/`SIGNAGE_GENERAL_KEYS`), never under Admin > Settings; the
pages mask secrets before they reach the browser. (3) **Applying settings can never lock the dashboard out**: the Pi starts a 120 s undo
(`revert-after`) and keeps the change only after a SECOND key login confirms it. (4) The manifest is compiled on the server (`compileManifest`,
14 days, schedule entries by priority 1-5 > fallback > logo slide; **one-time and weekly/monthly entries are one Schedule since 2026-11-11, and saving refuses two entries that would meet on a screen at the same priority** (`signageScheduleConflicts`; old events and rows are converted by the `signage-schedule-adopt` job, migration 0093)) and the Pi plays it on its own, power times included, while the
dashboard or Wi-Fi is down; a new version is stored only when the content differs, five kept, and `manifest_dirty_at` is cleared only if unchanged.
(5) Work is CLAIMED (`claimed_until`): setup runs (`signage-setup`), media conversion (`signage-media`, ffmpeg), sync; jobs `signage-compile`,
`signage-sync`, `signage-poll`, `signage-watch` (offline = `signage.device_offline`, an urgent outage kind), `signage-prune`, `signage-media-check`.
(6) Passwords typed for a Pi (login, sudo) are used for that run only, encrypted while it waits, redacted from the audit log and scrubbed from run
output. (7) Routes that reach a Pi or a TV are `@OperationalOnly`; MCP has content tools only. Search kinds `signage_screen`,
`signage_playlist`, `signage_media` (`SIGNAGE_KINDS`, gated on `signage:read:any`; one-off event playlists and devices are never indexed,
nor any address); writes call `SignageService.searchChanged()`. The home page's Systems and Meters show a `screens` area (`AREA_KEYS`)
only for a Signage reader on an install with a Pi set up (`readSignageHealth`: "offline" is the `signage-watch` job's `offline_alerted`,
so a TV off by its power times is not a problem; problems link to the screen's page, never the admin-only device page). (8) Media files go into a backup only when it asks
(`include_signage_media`; `SIGNAGE_FILE_PREFIXES`), are never removed by a restore, and a restored row whose file is absent becomes `missing`.
(9) The agent ships in the api image (`/app/signage-agent`, bundle hash-checked); uploaded releases are checked before they are kept. (10) **Forget resets the Pi** (agent 1.1.0, `release.py`, `SignageSetup.forget`): `DELETE /signage/devices/:id` pushes the agent, runs `signage-ctl release` (unlocks the first user, removes the key, SSH rules, firewall, accounts, agent and media, restores console/desktop boot; Wi-Fi untouched; read-only root lifted first, work resumes after the reboot) and refuses to forget a Pi it cannot reach unless `?reset=0`; **the row is not deleted until the reset is seen to finish** (status `resetting`, a `forget` run that waits for the dashboard's key to be refused, `forgetVerdict`, agent 1.1.2 `release-status`; a stuck reset turns the device `failed` with `FORGET_FAILED_PREFIX`), and notes that must survive a restart under the read-only root are `write_json(..., durable=True)`; see docs/signage.md section 4. A repeat setup, and "Show a code" on a set-up Pi, first try the dashboard's key (`recognise`, `openWithKey`): the dedicated login may only run `signage-ctl`, so the code is the agent's own `identify`. **mpv drops an `osd-overlay` the moment the IPC connection that made it closes**, so the player keeps ONE connection open (`Mpv.raw`; a connection per command drew the identify code and the logo slide for no time at all, found 2026-11-10 by driving a real mpv under Xvfb and capturing the screen); keep `--osd-level=1` too (the effect of 0 on overlays was not isolated). `agent-put` with the read-only root on is persisted to the real root (`persist_agent`), or the old agent returns at the next restart.
Tests: `signage.integration.test.ts` (CockroachDB and YugabyteDB), `tests/signage/fake-pi.sh` (real setup, lock-down, sync and key rotation
against two Debian containers over SSH; run by hand, not in `make regression`), the agent's pytest suite (`services/signage-agent/tests`),
smoke `tests/smoke/signage.mjs` (never reaches a Pi), e2e `signage.spec.ts`.
