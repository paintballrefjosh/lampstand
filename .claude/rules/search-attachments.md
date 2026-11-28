---
paths:
  - "apps/api/src/{search,attachments}/**"
  - "apps/web/src/lib/{search-kinds,use-global-search}.ts"
  - "apps/web/src/components/{search,attachment}*"
  - "apps/web/src/app/api/search/**"
  - "packages/shared/src/schemas/attachment.ts"
  - "apps/api/src/db/schema/attachments.ts"
  - "apps/api/test/{search,attachment,content-disposition}*"
---

# Search and attachments

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

## Search

Global search ("Search everything…" in the top bar + the Cmd/Ctrl-K palette) is
one Meilisearch index, `content`, holding every searchable kind with a `kind`
discriminator — **not** an index per resource type. Filterable attributes
(`kind`, `ownerUserId`, `visibility`, `aclGroupIds`, `tagIds`) let one query
scope results per request; searchable attributes are `title` + `body`. Every doc
carries an explicit `url` for deep-linking (set at index time), so kinds whose
link target differs from their `resourceId` (an infra entity → its parent host,
a Cisco MAC → the lookup page) route correctly without the frontend hard-coding
cases. The web side shares one `apps/web/src/lib/search-kinds.ts` for
labels/icons/colours/routing across both search surfaces.

**One Meilisearch per node, derived from the database.** Meilisearch cannot be
clustered, so each node runs its own and keeps it in step; nothing in the index
is the only copy of anything, and any node can rebuild its index from the
database (admin **Reindex**, or the reconcile at start). Code is split across
`search.service.ts` (the service), `search-types.ts` (kinds, `SearchDoc`,
`searchDocId`; re-exported from the service), `search-sources.ts` (where
documents come from: `DbSearchSources`, plus the ticket/note/wiki doc builders),
`search-helpers.ts` (`docRev`, `diffDocs`) and `live-search.store.ts`.

Every document carries `rev`, a hash of its content (not its `updatedAt`). A
**reconcile** compares each indexed doc's `rev` with the desired one and writes
or deletes only the difference, so documents never vanish and reappear.
**Never write to Meilisearch directly from a feature**; go through the service.

Indexed kinds (see `SearchKind` in
[apps/api/src/search/search-types.ts](../../apps/api/src/search/search-types.ts)):

- **Content:** `ticket`, `note`, `wiki`. After the database write, a service
  calls `search.changed(kind, id)` (deleting counts as "changed" too). That node
  re-reads the resource from the database and updates its index at once, and
  tells the other nodes over the cluster bus (internal room `__search`), which
  re-read it themselves, so a change always lands as the current database
  content, never as a payload. A full reconcile of the content kinds also runs at
  start and every 10 minutes (`SEARCH_CONTENT_RECONCILE_MS`) to heal anything the
  bus missed.
- **Monitoring (DB-backed):** `monitor`, `infra_target`, `infra_entity`,
  `cisco_switch`, `cisco_port`, `cisco_mac`, `cisco_arp`, `cisco_vlan`,
  `ipam_subnet`, `ipam_host`, `service_instance`, `service_group` (and, the same way, `asset` and the signage kinds,
  each behind its own module permission). Each node reconciles these from the database
  itself (`syncMonitoringDbSources()`): on startup, on a timer
  (`SEARCH_MONITORING_SYNC_MS`, default 120s, so poller churn is picked up
  without a manual reindex), and from Reindex. Not event-driven, so two nodes
  can differ by a poller's latest changes for up to that long.
- **Live kinds, not in the database** (`LIVE_KINDS`): `dns_record` and
  `unifi_device`/`unifi_client`. The one node that reads the source publishes
  the current set with `syncDns()` / `syncUnifi()`, which writes only changed
  rows to the `live_search_docs` table and tells the other nodes; every node
  indexes from that table, so a node never needs to reach Technitium or the UniFi
  controller to search them, and a new node has them straight away.
  `DnsSearchIndexer` does a full read of every zone on a timer
  (`DNS_SEARCH_SYNC_MS`, default 300s) and shortly after each dashboard write; an
  unconfigured server clears the kind, an unreachable one keeps the last set. The
  `UnifiPoller` pushes on each poll and self-refreshes on an idle cadence
  (`UNIFI_SEARCH_SYNC_MS`, default 300s). Right after upgrading from a version
  without the table, these documents are absent until the next poll (under a
  minute for DNS, one poll for UniFi).

Search is **eventually consistent across nodes** (about a second): a ticket
created on one node can be missing from a search answered by another for a
moment. A freshly started node answers searches only after its first reconcile
(up to 8 seconds' wait, then it answers anyway). Admin **Reindex** rebuilds this
node's index and asks every other node to rebuild theirs (bus event `reindex`).

**Permission gating happens in the query filter, never at index time** (so a
permission change takes effect immediately): monitoring kinds require
`monitors:read:any` (as does `dns_record`), UniFi kinds require `unifi:read:any`, tickets/wiki apply
their own read scoping. A user without a permission simply never gets those
kinds in the filter — nothing leaks through the index. When adding a new
searchable resource: add the `SearchKind`, a doc builder in `search-sources.ts`
(with `url`) and the code that calls `search.changed` (or, for a source outside
the database, a publisher through `live_search_docs`), the query gate, and an
entry in `search-kinds.ts`.

## Attachments (allowed types)

Which file types may be uploaded (wiki, notes, tickets share `AttachmentsService`) is the admin-editable setting
`attachments.allowed_types` (Site settings > Attachments, `attachment-settings.tsx`). **The choices are a closed catalogue,
`ATTACHMENT_TYPE_CATALOGUE` in `packages/shared/src/schemas/attachment.ts`, never free text**: the stored list is cut down to the
catalogue on read (`resolveAllowedAttachmentTypes`) and on save (`validateSettingValue`), so HTML, SVG and
`application/octet-stream` can never be switched on. Each entry has a `check` that `reconcileMime`
(`attachments/magic-bytes.ts`) applies to the file's own bytes: `magic` (sniffed type must equal the declared one), `zip`
(docx/xlsx/pptx/OpenDocument), `ole` (legacy doc/xls/ppt), `none` (plain text formats). To add a type, add a catalogue
entry with a check that can verify it (a new signature goes in `sniffMime`); defaults are `DEFAULT_ATTACHMENT_TYPES`
(unchanged from before the setting existed). Only images are served inline; everything else is `attachment` + nosniff.
**Custom extensions** (`attachments.custom_extensions`, "Other file extensions" in the same section) are the deliberate
exception to "verified": matched by the file NAME only (they win over the browser's declared type), stored and served as
`application/octet-stream` (download-only, nosniff), and `normaliseCustomExtension` refuses `BLOCKED_ATTACHMENT_EXTENSIONS`
(html, svg, xml, js, exe, bat, sh, php ... anything that runs in a browser, on a computer or on a server) and any extension
the checklist already covers (so unticking a type there cannot be undone here). The same function runs in the UI, in
`validateSettingValue` and when the setting is read (`resolveCustomAttachmentExtensions`). Settings are cached 60 s per node,
so editing the row in SQL (instead of the UI, which invalidates) takes up to a minute to apply. The upload size cap is still the fixed `MAX_ATTACHMENT_BYTES`. **A file over it is refused with 413 and nothing is stored**:
@fastify/multipart cuts the stream at the limit and only sets `truncated` (it does not fail the request), and until 2026-10-19 `upload`
ignored that and stored the first 10 MiB of a larger file as if it were whole. `upload` buffers the file (bounded by that cap) and judges
its type on its own bytes before anything reaches S3; it is NOT streamed to S3, because minio holds a whole part in memory before sending
it (no saving at 10 MiB) and every refusal would then leave an object to delete. Downloads already stream; presigned redirects are out
because the object store is never exposed outside the stack. Tests: `apps/api/test/attachment-types.test.ts`, `attachments-upload.test.ts`,
smoke "an upload over the size limit is refused".
