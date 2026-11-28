---
paths:
  - "apps/api/src/{cisco,unifi,ipam,dns,ups,racks,switch-models}/**"
  - "apps/web/src/app/monitoring/{network,network-cisco,ups}/**"
  - "apps/web/src/app/{ipam,dns,cabinets,device-profiles,print}/**"
  - "apps/web/src/app/api/{cisco,unifi,ipam,dns,ups,racks,switch-models,port-sheets}/**"
  - "apps/web/src/components/{switch,port,rack,module-placement,stencil}*"
  - "apps/web/src/components/{follow-card,device-picture}.tsx"
  - "apps/web/src/lib/{faceplates,stencils}/**"
  - "apps/web/src/lib/{poe,unifi,rack,use-switch}*"
  - "packages/shared/src/{port-sheet,rack-layout}.ts"
  - "packages/shared/src/schemas/{cisco,dns,ipam,ups,rack,switch-model}.ts"
  - "packages/shared/src/schemas/unifi*.ts"
  - "apps/api/src/db/schema/{cisco,dns,ipam,ups,unifi,racks,switch-models}.ts"
  - "apps/api/test/{cisco,dns,unifi,switch-models,port-sheet,rack-layout}*"
  - "tests/smoke/{cisco,cabinets,device-pictures}.mjs"
  - "tests/e2e/tests/{cisco,cabinets,device,switch,unifi}*"
---

# Network: Cisco, UniFi, IPAM, DNS, UPS, cabinets

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

The `monitoring` module is a single section covering tabbed views under
`/monitoring`: **Services** (uptime probes run by the `services/monitor` worker —
`http`/`tcp`/`icmp`/`dns`/`tls`, and the AV kinds `hls`/`hyperdeck`/`pjlink`/`shure`/`obs`/`atem`/`vmix`/`sennheiser` (see "AV and livestream probes" below); per-kind config lives in the monitor's freeform
`options` blob, no migration to add a kind. The `tls` probe (`probeTls`) judges certificate
expiry only (down once expired or `warnDays` or fewer days remain), not chain trust, so private-CA
services work. A kind in `MONITOR_KINDS` needs a case in the worker's `runProbe`, or it reports
`unknown kind` (down). The
worker fans incidents out to the monitoring recipients like infra alerts), **Infrastructure**
(`/monitoring/infra` — host/Docker/Proxmox; the per-host detail page charts
CPU/mem/disk plus load/temperature — persisted into rollups — and network/disk-IO,
which are raw-sample-only so they populate at the ≤2h range), **Network (UniFi)**
(`/monitoring/network`),
**Network (Cisco)** (`/monitoring/network-cisco` — the `cisco` module: an SSH
poller for Cisco IOS/NX-OS switches with config backups, drift, MAC/ARP/VLAN
caches; ported from the standalone `cisco-switch` app. Port drift (`driftFieldsFor` in `cisco.poller.ts`) compares admin
state, mode, VLANs, **description, speed and duplex** with the running config. Speed is held as the switch writes it
(`1000`, `auto`) and every path goes through `normaliseSpeed` (shared), so `1G` and `1000` agree; a description is compared
exactly and must be one CLI line (the push refuses control characters). **VLANs (layer 2)** work the same way
(`cisco-vlans.service.ts`, `vlan-drift.ts`, `push-commands.ts`): the wanted list per switch is `cisco_vlans` (migration 0061;
`cisco_vlan_db` stays what the last poll saw), taken from the switch once per switch (`cisco_switches.vlan_baseline_at`, so
removing the last wanted VLAN is not "never seeded"), then compared on every poll and right after each edit as drift events
with `port_id = vlan:<id>` and field `vlan_exists` (`1`/`0`) or `vlan_name`. VLAN 1 and 1002-1005 are never managed
(`isManagedVlan`). Edits are `PUT /cisco/vlans/:vlanId` (name + the switches that should have it; others lose it) and
`DELETE`; a removal is refused (409) while a wanted or live access port, a trunk native VLAN or an `interface Vlan<id>` in the
latest backup uses it, and the push re-checks that. Nothing reaches a switch except through the drift push, which creates and
renames VLANs first, then ports, and removes VLANs last (`buildPushCommands`); the port editor picks its VLANs from the
switch's list (`GET /cisco/switches/:id/vlans`) and a port cannot be put in a VLAN the switch does not have. A trunk's allowed
list is compared as a set (`normaliseVlanList`). Per-switch VLANs assume VTP transparent/off (all three switches are): a
switch in VTP server/client mode would propagate edits, so do not add that without detecting it first. The push also reads the
session output and fails on `Invalid input` / `ERROR:` lines instead of reporting success. Reads gate on
`monitors:read:any`, writes on `monitors:write:any`), and **IPAM**
(its own page, `/ipam` in the IT menu, not a Monitoring tab since 2026-10-04;
`/monitoring/ipam*` redirects there via `next.config.mjs` — the `ipam` module: a
lightweight IP-address manager. A
background scanner (`ipam/ipam.scanner.ts`, same self-rescheduling `setTimeout`
shape as the Cisco poller) sweeps managed subnets ICMP-first with a TCP-connect
fallback — ICMP is `spawn`ed `ping`, so the api container has `cap_add: NET_RAW`
in compose — and records live hosts in `ipam_hosts` with names from reverse
DNS / NetBIOS (nbstat) / the UniFi controller's client list (alias or DHCP
hostname) as each is toggled on. (Bonjour/mDNS was dropped: it is link-local
only, so an off-subnet scanner's queries are never answered — UniFi already
holds those friendly names, including phones/IoT.) Ranges are added
manually or discovered from Cisco SVI config lines + ARP and UniFi
`rest/networkconf` (`IpamService.discover`), each candidate labelled from its
source name (UniFi network name, or the matching switch's VLAN name from
`show vlan brief`/`cisco_vlan_db`) when adopted. Every scanner tick also calls
`IpamService.syncLabels()` — unconditionally, not gated by the scan-enable
toggle, since it's just a metadata read — to refresh that label from the
source system for any subnet still flagged `label_auto`; editing a label by
hand (`PATCH /api/ipam/subnets/:id`) clears that flag so a manual rename is
never overwritten. Scan knobs — enable, interval,
concurrency, timeout, DNS/NetBIOS/UniFi-name toggles, TCP ports — live in the
`ipam` settings category (`/ipam/settings`); reads gate on `monitors:read:any`, writes on
`monitors:write:any`). The old
standalone `network` module was merged into `monitoring` (migration 0031); the
UniFi `unifi:read:any` / `unifi:admin` permissions are now granted by the
`monitoring` tier, and the UniFi controller settings are the `unifi` settings
category (`/monitoring/network/settings`). The API endpoints stay at
`/api/v1/unifi/*` — only the module/UI grouping changed.

**Cisco pushes and stored configurations were reviewed 2026-10-19.** Rules: (1) **`buildPushCommands` is the one place a CLI line is made, and it
validates every value** (interface name pattern, VLAN numbers, allowed-VLAN list, speed, duplex, mode, host name, VLAN name, no control characters)
whatever route the value came by: `interface range Gi1/0/1-48` or `speed 1000 ; reload` is a command, not a setting. The port schema checks the same
shapes at the door. (2) **A push is apply, check, save**, never one session ending in `write memory`: `pushNow` keeps a copy of the running config first
(backup type `pre-change`; no copy = nothing is changed), runs the lines with `save: false`, looks for refusals (`findCliError`, which includes
authorization failures), and only then writes the startup config in a second short session. A refused line leaves the startup config alone (a reload
undoes the rest). (3) **SSH algorithm lists are strongest first** (`ssh.ts`): the client's order decides, and the old order made a switch that offers
curve25519 and AES-GCM negotiate `diffie-hellman-group1-sha1` and CBC for the password (measured). The old algorithms stay, last, for old IOS boxes.
**Leave `serverHostKey` order alone**: the pinned fingerprint is of the key type the switch presents, and reordering could make a switch with several host
keys look like an interception. (4) **Stored configurations are readable by every volunteer** (`monitors:read:any` is the Monitoring USER tier), and they
hold SNMP communities, local-user and enable hashes and AAA/routing keys, so `GET .../backups/:id` and `.../diff/...` redact those lines
(`config-redact.ts`, `<hidden>`, same line count) unless the caller has `monitors:write:any`. Redact before diffing; a new route that returns config text
must do the same. Tests: `cisco-push-validation`, `cisco-push-safety`, `cisco-ssh-algorithms` (a fake switch that offers old and new), `cisco-config-redact`,
smoke `tests/smoke/cisco.mjs` (a volunteer account reads a real stored config; read-only, pushes nothing). Never push to the real switches to test.

**Port-state check** (`cisco_switches.check_port_state`, and `check_port_channels` from migration 0073, off by default): the switch list's "Port down" status and the port-change alerts count enabled ports that are not up; a port-channel (`Po*`, `isPortChannel`) counts only when the switch has `check_port_channels` on, because a bundle is down when its members are. `parseInterfacesStatus` reads the status column by the header's offsets (NX-OS has many words: `xcvrAbsen`, `noOperMem`), and `parseRunningConfig` matches `shutdown` exactly (`show run all` prints `no shutdown lan` on every NX-OS port). The desired ports are seeded once from that parse, so after a parser fix re-import the switch's ports (`POST /cisco/switches/:id/discover`).

**PoE on the switch page** (migration 0074, `cisco_port_live_state.poe_*`): on IOS and IOS-XE (never NX-OS) the poller also reads `show power inline`
and `show power inline module N detail` (`readPoe`, best effort: a failure or a switch with no PoE just stores nothing; `parsePoeDetail`,
`parsePoeModules`) and the ports list returns it as `poe` (`CiscoPortPoe`, milliwatts). A port with `status: "on"` gets a lightning bolt on the picture,
and the hover window gets the PoE kind, class, power measured and power set aside (`apps/web/src/lib/poe.ts`). **The summary table's `Power` column is
what was SET ASIDE for the device, not what it draws** (every class 0 device reads 15.4 W); the real figure is `Measured at the port` in the detail. The
kind is the larger of what the IEEE class and the power set aside imply (class 0-3 PoE af, 4 PoE+ at, 5-8 PoE++ bt). `power inline never` reads `Inline Power
Mode: never` (3850) or `off` (3750-X) and becomes status `disabled`.

Cisco SSH **pins the switch's host key** (`cisco_switches.known_host_key`, migration 0059): trust on first use,
then a different key is refused before the password is sent (`SshHostKeyMismatchError`, shown on the switch
page with a "Trust new host key" action: `POST /cisco/switches/:id/reset-host-key`). Changing a switch's IP
clears the pin. Writes to a switch (`pushToSwitch`, manual backup) refuse to run until a key is recorded
(`pinnedConn`). Test: `apps/api/test/cisco-host-key.test.ts` runs a real in-process ssh2 server.

**Switch view** (Cisco switch page): the ports open as a picture of the switch from the front with a hover popover per port, and a
"Switch view | List view" toggle (remembered in this browser) beside the Rows selector. On the switch LIST, hovering a row with the mouse
shows a card that follows the pointer with that switch's picture, ports coloured by state (`switch-hover-preview.tsx`, the static `FacePreview`,
ports read on first hover and reused 30 s; no card for a switch with no picture; port items from the shared `ciscoFaceItems`). The UniFi devices list and the infra overview do the same (`components/follow-card.tsx` `useFollowCard`, shared by all three), but
**only for a device profile**, never a built-in drawing: UniFi by its choice or model text (ports coloured from the list's own `port_table`, or the plain
picture for a profile with no ports), an infra host by its chosen profile (picture only). `DataTable` takes `rowProps` for this. **Device profiles** (called switch models in the
code and database, and "switch models" in the UI until 2026-10-25) are admin data
(`switch_models`, migration 0070, `apps/api/src/switch-models/`, `/api/v1/switch-models`; their own page **`/device-profiles`** in the IT menu, from the shared `components/switch-models-page.tsx` and `switch-model-editor.tsx`; the old `/monitoring/{network-cisco,network,infra}/models*` addresses redirect there in `next.config.mjs`; reads
`monitors:read:any`, writes `monitors:write:any`): a front and back picture (stored as `attachments`, parent type `switch_model`, size read
from the file's own bytes), match strings, which side has the ports, and a box per port as a fraction of that picture, placed in a drag
editor with an Auto option (find sockets / even grid / rename in order). **Import from a file** (`apps/web/src/lib/stencils/`,
`components/stencil-importer.tsx`) takes a vendor stencil zip, `.vss/.vssx/.vsd/.vsdx`, `.ppt/.pptx` or a plain picture and lets the admin pick
the front and back: all reading and EMF drawing happens in the browser and the pictures go through the ordinary image upload route, so
the server is unchanged (the binary Visio reader was checked byte for byte against libvisio; see the docs). Which model draws a switch is `resolveSwitchView` (an admin's per-switch pick or "off", `cisco_switches.switch_model_id` / `switch_view_off`,
migration 0071, `PUT /cisco/switches/:id/switch-view`; else the model text matched against the models' match strings; else a built-in), and the
page shows which one it was ("matched on C3064PQ"); the choice is made in the Edit switch form (shared `SwitchFormModal`). A matching model wins over the three rough built-in layouts in
`apps/web/src/lib/faceplates/layouts.ts`; `SwitchFaceplate` is generic and not Cisco-specific (the UniFi device page, `/monitoring/network/devices/<mac>`, reuses it
and the profiles: ports matched by number, `apps/web/src/lib/unifi-ports.ts`; read-only, no new API route). Rules (name-to-port matching, cage aliases, colours never alone, popover behaviour, how Auto works):
**Add-on modules** (migration 0072: `switch_models.kind` `switch`|`module`, `switch_models.modules` placements) are models too, placed on a host's picture; a module is drawn only while the switch reports one of its ports (`layoutFromSwitchModel(host, all)`), see the docs. [docs/switch-faceplates.md](../../docs/switch-faceplates.md). The routes are MCP-excluded (picture curation).

There is also a **UPS** tab (`/monitoring/ups` — the `ups` module: an SNMP poller
over UPS-MIB / RFC 1628, mirroring the `printers` module — `ups_devices` table, a
`setInterval` poller in `ups.service.ts`, per-device SNMP creds falling back to
`monitoring.ups_*` settings (category `ups`, `/monitoring/ups/settings`); battery %, runtime, load, in/out voltage. Reuses the
`monitoring` permissions like cisco/ipam — reads `monitors:read:any`, writes
`monitors:write:any`, no dedicated module/permission strings).

There is also a **DNS** page (`/dns` in the IT menu, like IPAM not a Monitoring
tab; `/monitoring/dns*` redirects — the `dns` module: a client for a
Technitium DNS Server cluster running *outside* this stack, so port 53 never
touches compose). `dns/technitium.ts` calls the Technitium HTTP API with the token
as `Authorization: Bearer` (never in the URL); only the cluster **primary** is
configured (`dns.primary_url`, `dns.api_token`, `dns.verify_tls` in the
`dns` settings category, `/dns/settings`) because it alone accepts zone edits and
aggregates cluster stats (`node=cluster`). Summary (primary
unreachable = critical, a non-connected cluster node = degraded), cluster nodes,
query stats, zones and records, plus audited record create/edit/delete
(A/AAAA/CNAME/PTR/MX/TXT/SRV) on Primary zones. Technitium records have no id,
so writes address a record by zone + name + structured `data` and re-read it
first: that read is the audit "before", supplies the current TTL/disabled flag
(an update that omits them resets TTL to 3600 and re-enables the record), and
refuses (409) records whose comment carries `DNS_MANAGED_MARKER`. An A record write may ask for its **reverse record**
(`createPtr`, the form's "Create reverse DNS record" switch, off by default): the service writes the PTR itself
(`planPtr`/`writePtr`), not with Technitium's `ptr` flag. **Nothing is overwritten or created without a yes**: a PTR that
points to another name, or a missing reverse zone, answers 409 with a `DnsPtrRefusal` and writes nothing, until the call
repeats with `replacePtr` (exactly the names shown) or `createPtrZone` (a primary /24 zone in the forward zone's
**catalog**, so cluster secondaries get it); the form shows the current value and asks. The record's own PTR follows a
rename without asking. A sync-owned PTR pointing elsewhere or a non-primary reverse zone is refused outright; an address
change removes the old address's hand-made PTR only if it pointed at the edited name; a PTR failure after the A record is
saved comes back as `ptr.error`, not an error status. **Deleting an A record: Technitium itself removes a PTR that points
back at it** (verified; no parameter stops it), so `removePtr: false` (the delete dialog's switch, on by default) writes it
again with its TTL, comment and disabled flag; a sync-owned one is always kept. `GET /dns/ptr?ip=` is what the dialog shows
(`dns-ptr.test.ts`). Same `monitors:*` permissions as cisco/ipam/ups.

**IPAM→DNS sync** (`dns/dns.sync.ts`, `dns_*` settings, migration 0048): hosts
in subnets with `ipam_subnets.dns_sync` on get an A record in `dns.sync_zone`
(plus a PTR when a matching in-addr.arpa zone exists; missing reverse zones are
reported and created only on request). The name is `ipam_hosts.dns_name`
(override) → UniFi name → NetBIOS name, cleaned to one DNS label; **never** the
scanner's reverse-DNS `hostname`, which would read back the sync's own PTRs.
Collisions: an override wins, then the most recently seen host; others get
`-<last octet>`. All the diffing is the pure `computeSyncPlan` in
`dns/sync-plan.ts` (unit-tested in `apps/api/test/`); the preview, runs and tests
share it. Ownership is the `DNS_MANAGED_MARKER` comment on the Technitium
record, never the ledger: the sync only changes or removes marked records, and a
hand-made record at a wanted name is a conflict (the host's PTR is skipped too).
`dns_managed_records` is a ledger rebuilt each run for the UI; `dns_sync_runs`
is the audit trail for background runs (the interceptor never sees them).
Removals run after adds/updates because Technitium deletes the PTR pointing at
an A record when that A is deleted; a remove that finds nothing counts as done.
A run that would remove >20 records (or >25% of the managed set past 5) stops
unless forced. Triggers: end of each IPAM scanner pass and IPAM edits
(debounced), a 15-minute timer, and "Sync now"; background runs only while
`dns.sync_enabled` is on. One run at a time across all nodes via the `dns-sync` lease
(`LeaseService.acquireMutex`, 120 s, renewed while it works); a second
request gets `AlreadyRunningError`.

**DNS health** (`dns/dns.health.ts`): "Create health monitors" on the Overview
adds one `dns` uptime monitor per node (cluster node IPs, or typed in) that
resolves the TXT canary `_dashboard-canary.<zone>` through that node, so a dead
node or a secondary that stopped receiving zone transfers opens a normal
incident. The canary carries the managed marker so it can't be hand-edited.
`dns.alert_unreachable` adds a notification-only alert (kind
`dns.primary_unreachable`, like UniFi's, since the primary's API isn't a monitor
row) after 3 failed 60s polls of the primary, plus a recovery notice; silenced
by maintenance mode. The dashboard monitoring tile has a DNS row (nodes up/down).

**UniFi device acks:** an offline UniFi device can be acknowledged
(`POST /api/v1/unifi/devices/:mac/ack`, gated on `monitors:write:any`) to
suppress it from the Network (UniFi) tab problem badge. Acks live in
`unifi_device_acks` (keyed by MAC) and cover only the *current* offline episode:
`UnifiService.reconcileAcks` runs on every controller read (`summary`/`snapshot`/
`devices`) and deletes the ack the moment the device is seen online again, so a
later re-offline counts (and alerts) afresh. `summary().devices.acked` carries
the count; the badge shows `offline - acked`. `DELETE .../ack` clears it
manually. Web sub-pages under `/monitoring` can dispatch the
`monitoring:health-refresh` window event (see `section-tabs.tsx`) after a
mutation to refresh the tab badges immediately instead of on their 20s poll.

**Cabinets and printable port sheets** (`apps/api/src/racks/`, `/cabinets` in the IT menu, `/print/cisco/<id>`, `/print/unifi/<mac>`; migration 0075;
design and the planned follow-up in [docs/cabinets.md](../../docs/cabinets.md)). A cabinet (`racks`, 1-60U) holds items (`rack_items`) that point at a Cisco switch,
an infra host, a UniFi device (by MAC) or are custom; **U1 is the bottom**, and all placement arithmetic is the pure `rack-layout.ts` in shared. Rules:
(1) **an item stores a pointer plus a snapshot, never a foreign key to the device**, and the page shows the device's own name/IP/status (`withLive`); a
UniFi controller that is down is not "device missing". (2) Placement checks and writes run in one transaction that first updates the cabinet row, so two
nodes cannot both pass the overlap check. (3) A device sits in one cabinet only. (4) Pictures are **device profiles** (`pictureModelFor`): any profile can be
picked for any item, else the device's own choice applies (`resolveSwitchView` for every kind); a new kind of device that gets pictures goes through that function.
**Each device chooses its own picture** (migration 0081): a Cisco switch on `cisco_switches` (0071), an infra host on `infra_targets.switch_model_id`
(the host form; a host reports no model text, so a profile or none, never "automatic"), a UniFi device in `unifi_device_views` keyed by MAC (auto = no
row; `PUT /unifi/devices/:mac/switch-view`, `monitors:write:any`, audited `unifi.device.view`, MCP-excluded, works without the controller), all through
`checkDeviceProfile` (exists, not a module); deleting a profile clears every choice (ON DELETE SET NULL). `UnifiService.devices()`/`snapshot()` carry
`switchModelId`/`switchViewOff` on each device; cabinets and the UniFi port sheet read `deviceViews()` live, not through the cached device list. (5) The printable pages carry no top bar, stay white in dark
mode, and the cabinet table's rows share the cabinet's grid so they line up (tested). (6) **Subnets on the Cisco sheet come from IPAM by VLAN number**, UniFi's
from `rest/networkconf` + `rest/portconf` (read-only, `null` when unreachable: say so, never guess). Reads gate on `monitors:read:any`, writes on
`monitors:write:any` (like IPAM/DNS/UPS); MCP has read tools only (`racks_list`, `racks_get`, `port_sheet_*`). Tests: `rack-layout.test.ts`, `port-sheet.test.ts`,
smoke `tests/smoke/cabinets.mjs`, e2e `cabinets.spec.ts`.
