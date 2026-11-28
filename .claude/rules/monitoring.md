---
paths:
  - "apps/api/src/{monitors,infra,alerts,service-monitoring,renewals}/**"
  - "services/monitor/**"
  - "apps/web/src/app/monitoring/*.{ts,tsx}"
  - "apps/web/src/app/monitoring/{infra,alert-channels,settings,new}/**"
  - "apps/web/src/app/monitoring/*id*/**"
  - "apps/web/src/app/{status,public-status,renewals}/**"
  - "apps/web/src/app/api/{monitors,infra,alert-channels,service-monitoring,renewals,status}/**"
  - "apps/web/src/components/{runbook-link,gone-notice}.tsx"
  - "apps/web/src/lib/{host-filter,targets-up-tone}*"
  - "packages/shared/src/{alert-channels,alert-rules,maintenance,monitor-schedule}.ts"
  - "packages/shared/src/service-monitoring/**"
  - "packages/shared/src/schemas/{monitor,infra,renewal}.ts"
  - "apps/api/src/db/schema/{monitors,infra,alerts,service-monitoring,renewals}.ts"
  - "apps/api/test/{alert,av-probes,probe,maintenance,infra,sudo-access,service,renewals}*"
  - "tests/smoke/{alerts,alert-channels,renewals,service-monitoring}.mjs"
  - "tests/e2e/tests/{maintenance,status,service-monitoring,gone-pages}*"
  - "apps/api/src/printers/**"
  - "apps/api/test/fixtures/service-monitoring/**"
  - "apps/api/test/device-secret.test.ts"
  - "packages/shared/src/schemas/alert-channel.ts"
---

# Monitoring: hosts, alerts, probes, service monitoring, renewals

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

**Update runs and sudo** (`infra/infra-updater.ts`, `infra/sudo-access.ts`): "Run updates" on a Linux
infra target needs root. The script first probes sudo (`sudoProbeScript`: root, `sudo -n true`, or a password read from
stdin and piped into a fresh `sudo -S` for every command; never a cached credential reused with `sudo -n`, which
sudo-rs (Ubuntu 25.10+) refuses without a tty: "interactive authentication is required") and stops there if the run cannot go on, so apt is never run unprivileged. The run then
ends `needs_sudo` (key login with no password, or a wrong one: the web opens a terminal-style dialog,
`SudoTerminalDialog`, showing sudo's own output and a masked prompt) or `sudo_denied` (not in sudoers: the error
says how to fix it on the host; the dashboard cannot). The password typed is sent with the next
`POST .../update-run` (`sudoPassword`, redacted from the audit row, never stored, scrubbed from run output); with
`enablePasswordlessSudo` the run first writes `<login> ALL=(ALL) NOPASSWD: ALL` to
`/etc/sudoers.d/zz-lampstand-<login>` (`zz-` because sudoers is last-match-wins; temp name, `visudo -cf`,
then `mv`). "Written" is not "working": while still root the script runs `sudo -n true` as the login; if a later
entry overrides the rule it retries with `Defaults:<login> !authenticate` (sudo-rs has no such setting), and
failing that removes the file and returns `sudo -l -U` plus the relevant sudoers lines. A scoped sudoers rule does not satisfy the `sudo -n true` probe. Statuses are
free text in `infra_update_runs.status`, so no migration. Tests: `apps/api/test/sudo-access.test.ts` runs the
real scripts against a fake `sudo`; the real messages were also checked in a Debian container and over SSH.

**Removing unused packages after an update** (`createInfraUpdateRunSchema.cleanup`, `infra_update_runs.cleanup`, migration 0089, a checkbox in the
Run updates dialog): after a SUCCESSFUL upgrade `upgradeScript` runs `apt-get -y autoremove` (dnf/yum `autoremove`; other managers print "not supported" and skip).
A failing autoremove fails the run (exit code), its output follows the upgrade's in the same log, and it is off by default because it deletes software.
Test: `apps/api/test/infra-update-cleanup.test.ts`.

**The Run updates dialog remembers its checkboxes** (2026-11-28): they start as they were for the most recent run on ANY host by anyone
(`GET /infra/update-run-defaults`, `InfraUpdaterService.lastRunOptions`, read from `infra_update_runs`, so nothing separate is stored);
`DEFAULT_INFRA_UPDATE_RUN_OPTIONS` (reboot only) when there is no run. Cancelling the dialog changes nothing. A new checkbox in that
dialog joins `InfraUpdateRunOptions`, the query and the defaults.

**Switching a Cisco switch off** (`cisco_switches.enabled`, migration 0090; the Monitoring pill in the switch list, the same pill on the switch page, and a
checkbox in Edit switch; all use `PATCH /cisco/switches/:id {enabled}`): `pollAll` skips it, `pollSwitch` returns at once and `pinnedConn` refuses, so no
SSH login happens at all (no backups, drift checks, pushes); the poll, re-import, collect, backup, drift-push and port-toggle routes answer 409
(`requireMonitored`). It shows as "Monitoring off" and is left out of the tab badge, the home Systems area, the dashboard tile, the availability
samples ("no data", never "down") and the Security overview's host-key check. Stored ports, backups and drift stay readable. Switching it back on clears
`last_polled_at`, so the next poll is a quiet first one (no alerts for changes made while it was off).

**Switching an infra host off** (`infra_targets.enabled`, the toggle beside Edit on the host page): the collector
does not poll it, and `poll-now`, `discover-services` and update runs answer 409. Its open incidents stay recorded
but are left out of `openAlerts` and the open-incident list (nothing is polling it to resolve them); the summary
counts it under `targets.disabled`, not in `total`. Switching it back on clears `last_polled_at` and sets the
status to `unknown`, so it is polled at the next tick and the old reading is not mistaken for a current one. The
overview greys the card and says "Disabled"; the host page greys its last readings and shows a banner.

**Infra overview host filter** (`/monitoring/infra`, `host-filter-card.tsx`, rules in `apps/web/src/lib/host-filter.ts` with a test): switches for
down, disabled and up hosts, a tile on the summary row, remembered in this browser. They filter the host cards only, never the summary
tiles. Degraded and unknown hosts have no switch and always show. The "Targets up" figure is green when all are up, amber while at
most 3 are down (degraded or unread alone is amber) and red beyond that (`lib/targets-up-tone.ts`).

**Maintenance mode:** the `monitoring.maintenance_mode` boolean setting silences
alert *notifications* across infra thresholds, service up/down, UniFi
device-offline, DNS, cluster-node and Cisco switch alerts — incidents are still recorded, only the
in-app/email fan-out is paused. (UPS has no alert fan-out; IPAM none either.)
**It can carry an end time** (`monitoring.maintenance_until`, ISO timestamp, blank = none; at most 7 days at once,
`MAINTENANCE_MAX_MINUTES`) so a pause nobody remembers ends by itself. **Never read the boolean on its own to decide
whether to notify:** ask `readMaintenance(settings)` / `maintenanceActive(settings)` (`monitors/maintenance.ts`), and in the
probe worker `maintenanceState` (`packages/shared/src/maintenance.ts`, unit-tested), which judge the end time against the
current time on each call. The `maintenance-expiry` cluster job (`monitors/maintenance-expiry.ts`) then flips the stored
switch off so the settings page stays truthful; nothing depends on it. `POST /monitors/maintenance` takes
`{enabled, minutes?}` (no `minutes` = no end, which the Security overview flags as a warning). Presented as
an inverted "Enabled" switch (on = alerts fire, the default; off = a menu asking for 1/4/8/24 hours or "until I turn it
back on") right-aligned on the Monitoring tab row (`maintenance-control.tsx`, rendered
inside `MonitoringTabs`), which shows when alerts resume and lets the time be changed, via `GET`/`POST
/api/v1/monitors/maintenance` (Monitoring > Settings leaves the two keys out and points at the switch).

**Flapping, acknowledging, escalation and the status page** (migration 0064; pure rules in `packages/shared/src/alert-rules.ts`,
unit-tested; the probe worker cannot import the API, so the rules live in shared). (1) *Flapping* is the worker's
(`services/monitor/src/main.ts`): when an incident opens and `monitoring.flap_incidents` have opened within
`monitoring.flap_window_min`, `monitors.flapping_since` is set, ONE `monitor.flapping` notice goes out, and the down/up
notices (and activity rows) for that monitor are held back; incidents are still recorded in full. It ends when the monitor has
stayed in one state for the whole window (judged on every check, after that check's own writes: `flapSettled`), then a
"stable again" notice, or a normal "is down" one if it is down. Never read `flapping_since` as "down". (2) *Acknowledging*:
`POST /monitors/incidents/:incidentId/ack` (`monitors:write:any`, audited, idempotent, 409 once resolved) sets
`monitor_incidents.acknowledged_at/by`; incidents are shared by monitors and infra targets, so one route serves both.
(3) *Escalation* (`monitors/alert-escalation.ts`, cluster job `alert-escalation`, 60 s): for open, unacknowledged incidents
started within 72 h, `escalationDue` picks the step (1 = remind the usual recipients after `monitoring.escalate_reminder_min`,
2 = also tell the group named in `monitoring.escalation_group` after `monitoring.escalate_group_min`; the highest due step wins
and a step is never repeated). A step is CLAIMED with one conditional UPDATE on `escalation_level` BEFORE sending (two nodes
never double-send; a crash loses at most that one notice). Nothing is sent in maintenance mode; a missing or empty group
degrades to reminders with one log line; saving a group name that does not exist is refused (`SettingsService.assertReferences`).
The second group's notice links to `/status` because they may have no Monitoring access. `escalation_level`/`escalated_at` and
`flapping_since` are `volatile` in the backup registry (a restore must not replay or inherit them). (4) *The status page*
(`GET /status`, any signed-in user, no permission string by design; `StatusService`) lists monitors with `show_on_status` (and
enabled) under `status_name` (and service groups with `show_on_status`, by name only), and carries NAME, STATE, SINCE, ACKNOWLEDGED, the maintenance window and the admin's
`monitoring.status_notice` only: **never add a target, address, error text or threshold to it**, a unit test asserts none
leaks. Tests: `alert-rules.test.ts`, `alert-escalation.integration.test.ts` (CockroachDB and YugabyteDB), smoke
`tests/smoke/alerts.mjs`, e2e `status.spec.ts`; the worker's flap behaviour was checked for real against a stopped and
restarted container (no automated test: `applyResult` lives in the worker's `main.ts`).

**AV and livestream probes, monitor schedules, option secrets** (`services/monitor/src/av-probes.ts`, `packages/shared/src/monitor-schedule.ts`;
tests `apps/api/test/av-probes.test.ts` run each probe against a fake device). (1) Read-only probes in each device's own protocol: `hls` (the
playlist, following a master to its first variant, must not be ended and must move: the last `#EXT-X-PROGRAM-DATE-TIME` within `maxAgeSec`,
else the media sequence advancing between two reads a target duration apart), `hyperdeck` (Blackmagic Ethernet protocol, TCP 9993: transport
status, recording space; `expectRecording`, `minRecordMinutes`), `pjlink` (class 1, TCP 4352, MD5 digest auth: power, ERST error/warning digits,
lamp hours; `expectOn`, `maxLampHours`), `shure` (command strings, TCP 2202: `BATT_BARS` per channel, 255 = no transmitter; `minBars`), `obs`
(obs-websocket 5, port 4455, sha256 auth; `expectStreaming`, `expectRecording`). Nothing here ever sends a command that changes a device.
`atem` (Blackmagic's UDP protocol, port 9910: hello, acknowledge every packet in order, read the state dump until `InCm`, leave;
model, program input, streaming status/bitrate/service, recording and disk problems; `expectStreaming`, `expectRecording`; **the
stream key arrives in `SRSU` and is never read**; a switcher has few client slots, so once a minute or less often), `vmix` (its web API, TCP 8088: only `GET /api/` is ever asked, the URL
is built from host and port so a `?Function=` in the target is dropped; streaming, recording, program input, master muted;
`expectStreaming`, `expectRecording`, `expectSound`; optional Web Controller `username`/`password`), `sennheiser` (EW-DX receivers:
`protocol` `ssc1` = JSON over UDP 45, one address per datagram so a missing transmitter's error 424 costs only its own answer, or `ssc2` =
HTTPS GETs as user `api`; transmitter battery %, time left, LowBattery and RF warnings per channel; `minPercent`, `failOnRf`; SSCv2's
optional `fingerprint` pins the receiver's self-signed certificate, checked when the handshake ends and BEFORE the request with the
password is written, which is why it uses its own small TLS client and not `https.request`; the SSCv2 paths come from a third-party
module, unverified on hardware). (2) **Any monitor may carry `options.schedule`** (`Sun 08:00-13:00; Wed 18:30-20:30`,
day ranges, windows across midnight, on `site.timezone`). Outside every window the worker does not probe and records a healthy
`outside its hours (not checked)`, so an incident open at the end of a service closes, silently (no "is back up"). The API refuses a schedule
`monitorScheduleProblem` cannot read; the worker treats an unreadable one as "always". (3) **Credentials in monitor options**
(`MONITOR_SECRET_OPTION_KEYS`: the HTTP probe's `authorization`, the `password` of PJLink/OBS) are stored for the worker but every monitor the API
returns carries `[saved]` instead (`redactMonitorOptions`; the Monitoring USER tier, every volunteer, reads monitors, and so do MCP tools); on an
update the placeholder, or a secret key left out, keeps the saved value and `""` removes it (`mergeMonitorSecretOptions`). Until 2026-10-25 the
Authorization header was returned to every reader, and editing the monitor in the form silently dropped it. **Printer and UPS credentials** (SNMP
community, Fiery API key) follow the same rule through `settings/device-secret.ts`: answers say `[saved]`, rows hold `enc:v1:`, the pollers seal
values still in plain text (older rows, older backups), and a Test with `[saved]` sends the device id (until 2026-11-13 GET /printers gave every
volunteer the Fiery key and community in clear). (4) **`options.alerts: false`
mutes a monitor** (`monitorAlertsOff`, the form's "Send alerts" box, "Alerts off" on its page): incidents, activity and the status page are
unchanged, but the worker sends no down/up/flapping notice and `alert-escalation` skips its incidents. **A test monitor that goes down on
purpose must set it** (smoke `alerts.mjs`, e2e `status.spec.ts`): until 2026-10-25 every run told the real monitoring recipients, and the
notices then linked to a deleted monitor. A link to a deleted monitor, host or switch shows `GoneNotice` ("no longer exists"), not a bare 404.

**Alert channels, the alert outbox, runbooks, the public status page** (migrations 0077, 0078; rules in
`packages/shared/src/alert-channels.ts`, unit-tested in `apps/api/test/alert-channels.test.ts`). (1) *Alert channels* (`alert_channels`,
`apps/api/src/alerts/`, page `/monitoring/alert-channels`, the "Alerts" tab; reads AND writes `monitors:write:any`, MCP-excluded) are
site-wide destinations: ntfy, Pushover, Slack, Teams (Workflows webhook), Discord, a JSON webhook (optional HMAC `X-Lampstand-Signature`
over `<timestamp>.<body>`) and Twilio SMS. `events` is `outages` (`OUTAGE_ALERT_KINDS`, each kind with its recovery) or `everything`
(also `OTHER_ALERT_KINDS`). The token or webhook URL is `secret` (encrypted `enc:v1:`, never returned: `hasSecret`). **Every request
is built by the pure `buildAlertRequests`; destinations go through `alertDestinationProblem`** (Slack/Discord/Teams only to their own
hosts over https; never credentials in the URL; never this machine, link-local or a container of this stack, checked on the address the socket connects to), no redirects, 10 s timeout. The reply's words go on the channel (`last_error`) only for the hosted services, never for ntfy or a webhook (their reply is whatever sits at an address the admin typed). A failure is
recorded on the channel (`last_error`), never retried per channel. (2) *The outbox* (`alert_outbox`, `skip` in the backup registry): the
**probe worker no longer writes bell rows**: `notifyAll` queues a `fanout` row and the API's `alert-dispatch` cluster job (5 s) tells the
monitoring recipients through `NotificationsService.createMany` (so email, push, quiet hours and urgent kinds apply; until 2026-10-25 a
service going down never sent an email or a push) and the channels. `NotificationsService.create/createMany` also queue every
`isAlertKind` notice (one row per distinct notice, not per recipient) for the channels; `alertChannels: false` opts out (the job uses
it). Rows are CLAIMED by one conditional UPDATE (`claimed_until`, database clock), at most 5 attempts, sent rows kept 7 days; a row older
than `ALERT_STALE_MS` (30 min) when picked up goes to the bell only. Maintenance mode silences at the source, as before. A fan-out with no
recipients sends nothing to the channels either. (3) *Runbooks*: `monitors.runbook_page_id` and `infra_targets.runbook_page_id` (FK to
`wiki_pages`, ON DELETE SET NULL; `checkRunbookPage` only checks the page exists). The web reads the title through the wiki's own route
(`RunbookCard`), so a person who may see the monitor but not the page sees "a runbook is linked" and nothing more. (4) *Public status*:
`monitoring.status_public` (off) publishes `/public-status` (a PUBLIC middleware path) from `GET /status/public` (`@Public`, 404 while off,
`publicStatusPage` drops monitor ids, 15 s cache because anyone can ask). It shows exactly what the signed-in page does; the rule
"never a target, address, error text or threshold" applies doubly. The Security overview shows it as `info`. Tests:
`alert-dispatch.integration.test.ts` (CockroachDB and YugabyteDB, a local HTTP receiver), smoke `tests/smoke/alert-channels.mjs` and the
alerts-off/runbook/public-status cases in `tests/smoke/alerts.mjs`.

**Service monitoring** (`apps/api/src/service-monitoring/`, rules and format in `packages/shared/src/service-monitoring/`, migration 0085;
design, decisions and what was verified in [docs/service-monitoring.md](../../docs/service-monitoring.md) section 0): services ON an infra host
(HAProxy, PostgreSQL, MariaDB, CockroachDB, YugabyteDB, Kea, Technitium, Apache, keepalived, plus generic Prometheus / JSON / systemd unit / SQL
number) read through **templates**: built-ins are code (`BUILTIN_TEMPLATES`, never stored, fork to change), custom ones are `service_templates`.
A template is collectors (closed list of transports: `http`, `prometheus`, `sql`, `ssh`, `tcp`, `snmp`), metrics, members and checks written in
our own closed expression grammar (`expr.ts`; never `eval`, never JSONata/CEL). Web: the host page's Services section, `/monitoring/infra/<host>/services/<id>`,
`/monitoring/infra/service-templates` (YAML editor, parsed with `yaml` in the web only; the API speaks JSON). Reads `monitors:read:any`, writes,
logins and Test `monitors:write:any`; Test, Check now and suggestions are `@OperationalOnly`; MCP read tools only. Rules: (1) **an `ssh` template
runs only with its exact commands confirmed** (`confirmCommands` equal to `templateCommands(body)`) to save, fork, add, test, change inputs or
switch back on (409 `confirm_commands` + the list); a confirmation, not a permission. ssh needs the host key pinned; `sudo` is only `sudo -n`.
(2) **SQL is read-only three ways**: `sqlReadProblem` (keyword allowlist, no `INTO OUTFILE`), PostgreSQL `BEGIN READ ONLY` + **`queryMode:
"extended"`** (the simple protocol ran `SELECT 1; COMMIT; CREATE TABLE` as the login), MySQL session + transaction READ ONLY with
`multipleStatements` off (MariaDB DDL commits implicitly). Pools only through `createPool`, never the app's own. (3) Addresses: no loopback,
link-local or one-word container names, also after DNS; no redirects; 5 MB cap. (4) Secrets and login passwords encrypted, `[saved]` keeps,
`""` removes, scrubbed from errors/raw output, and **never reachable from an expression** (`serviceExprInputs`). (5) A breaching check is a
`monitor_incident` on the host (`rule_id` `svc:<instance>:<check>`), notices `infra.alert.opened/resolved`, so ack/escalation/channels/maintenance
apply; switching a service off or deleting it resolves its incidents. (6) Jobs `service-poll` (10 s, max 4, CLAIMED `claimed_until`),
`service-rollup`, `service-prune` (raw 7 d, 5 m 90 d, 1 h 365 d); members and counters live on the instance row, not `infra_entities`.
(7) **Service groups** (migration 0087, `service-groups.service.ts`, pure rules `service-monitoring/groups.ts`, `/monitoring/infra/service-groups`):
services on different hosts judged together, a quorum (`min_healthy` working; stale = no reading in max(3 intervals, 3 min)) and an optional
role count ("exactly 1 MASTER") on a state metric EVERY member's template has. A breach opens a `monitor_incident` with `service_group_id`
(rule `group:quorum|role`); **one open per group and rule is a unique index on `(service_group_id, group_open_rule)`**, the rule id while open
and NULL once resolved (CockroachDB cannot build a partial index on a column added in the same migration); a 23505 is adopted silently. Job
`service-groups` (30 s) is the only writer of a group's status/alert state. Code that reads `monitor_incidents` must allow a row with
neither `monitor_id` nor `target_id` (escalation, week, meters and the assistant join `service_groups` for the name). Part two
(migration 0088): `role.byTemplate` reads the role per template (`roleFor`; every member's template must report its state,
`roleRuleProblem`), an optional `redundancy` WARNING after `redundancy_after_min` minutes of a lost spare (its own clock,
`groupCheckForSec`; never makes the group down), `show_on_status`/`status_name` (names only on the status page), search kind
`service_group`, and availability samples of kind `service_group` (no home area; the group page's day/week figures). (8) The home page has a
`services` area (`AREA_KEYS`) only when a service or group exists. (9) Wave two built-ins (`BUILTIN_TEMPLATE_VERSION` 2): Redis/Valkey, nginx,
RabbitMQ, chrony, Postfix, mdadm, ZFS, systemd failed units, Garage, Meilisearch. The `tcp` transport has `parse` and `redisAuth` (sent as RESP
`AUTH`, length-prefixed: never splice a secret into `send`), and unescapes the template's `\r\n` BEFORE filling values.
Tests: `service-monitoring.test.ts`, `service-monitoring.integration.test.ts` (CockroachDB and YugabyteDB), opt-in `service-sql-transport.test.ts`
(real PostgreSQL/MariaDB, `TEST_SVC_POSTGRES`/`TEST_SVC_MYSQL`), `service-groups.test.ts`, `service-groups.integration.test.ts` (both engines),
`service-templates-wave2.test.ts` (opt-in `TEST_SVC_REDIS`, `TEST_SVC_YUGABYTE`), smoke `tests/smoke/service-monitoring.mjs`, e2e `service-monitoring.spec.ts`.

**Renewals** (`apps/api/src/renewals/`, page `/renewals` in the IT menu, migration 0079; rules in `packages/shared/src/schemas/renewal.ts`,
unit-tested in `apps/api/test/renewals.test.ts`): licences, domains, warranties, subscriptions and certificates that lapse on a date. Monitoring
tiers like cabinets (reads `monitors:read:any`, writes `monitors:write:any`); MCP has list/get/create/update, no delete. `renews_on` is a
DATE-ONLY string on the site's calendar (never an instant; `siteToday` from `site.timezone`). The hourly `renewal-reminders` job asks
`renewalReminderDue` for the marker of the nearest reminder that has come due (`<date>:<days>` or `<date>:overdue`, the lapse once, and
nothing more than `RENEWAL_OVERDUE_NOTICE_DAYS` past), CLAIMS it with a conditional UPDATE of `reminded_for` and tells the owner, else the
admin group (kind `renewal.due`). Moving the date gives new markers, so the reminders start again; never an earlier reminder after a nearer
one. `remind_days` is jsonb because the backup codec writes back jsonb, not `integer[]`.

**Deferred: infra threshold actions.** `InfraThresholdRule` (`packages/shared/src/schemas/infra.ts`)
currently only alerts — a sustained breach opens/resolves a `monitor_incident` and fans out
notifications, nothing more. Executing something when a rule breaches (run a command on the
host, reboot it) was discussed 2026-09-24 and deliberately deferred; this stays monitoring-only
for now. If revisited, two shapes were considered:
- **In-app action**: extend `InfraThresholdRule` with an optional action, fired once on the
  open-transition in `evaluateThresholds` (`apps/api/src/infra/infra-collector.ts`) — not on every
  poll while still breaching. Host commands would reuse `sshExec`. Needs its own audit trail (the
  audit interceptor only covers HTTP-triggered mutations, not poller-triggered ones) and a cooldown
  independent of `forSec` so a flapping metric can't refire it repeatedly.
- **Webhook out**: fire a webhook on breach and let an external automation tool (with its own
  approval/safety story) do the actual host mutation — keeps risky command execution out of this
  app entirely.
No decision was made between the two; revisit only on an explicit ask.
