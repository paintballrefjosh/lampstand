---
paths:
  - "apps/api/src/{tickets,ticket-categories,wiki}/**"
  - "apps/web/src/app/{tickets,wiki}/**"
  - "apps/web/src/app/api/{tickets,ticket-categories,wiki}/**"
  - "apps/web/src/components/{wiki,ticket}*"
  - "apps/web/src/lib/wiki*"
  - "packages/shared/src/{helpdesk,inbound-mail,wiki-pages,wiki-access}.ts"
  - "packages/shared/src/schemas/{ticket,ticket-category,wiki}.ts"
  - "apps/api/src/db/schema/{tickets,ticket-categories,wiki}.ts"
  - "apps/api/test/{ticket,helpdesk,inbound-mail,wiki}*"
  - "apps/api/test/fixtures/import/**"
  - "tests/smoke/{helpdesk,wiki-import,wiki-upkeep}.mjs"
  - "tests/e2e/tests/{tickets,helpdesk,wiki}*"
---

# Helpdesk and wiki

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

**Helpdesk: waiting, SLA notices, saved replies, tickets from email** (migrations 0065 and 0066; rules in `packages/shared/src/helpdesk.ts`
and `inbound-mail.ts`, unit-tested). (1) *Waiting on the requester* is ticket status `waiting`, with `tickets.waiting_since` while it lasts and
`waited_ms` for finished waits: **SLA elapsed time is always `ticketSlaElapsedMs`** (creation to now minus the waits), never a bare
`now - createdAt`; `waitingTransition` does the bookkeeping on every status change (`TicketsService.update` and the reply path) and
`statusAfterRequesterReply` puts the ticket back to work when the creator posts a public comment (including by email). Staff-facing
counts (home section) leave waiting tickets out; the requester still sees theirs. (2) *SLA notices* (`tickets/ticket-sla.ts`, cluster job
`ticket-sla`, 60 s): `slaAlertsDue` picks warn (at `tickets.sla.warn_percent`, with the other SLA targets on `/tickets/settings`) and breach per clock; each is CLAIMED by one conditional UPDATE
on `tickets.response_warned_at/response_breached_at/resolution_warned_at/resolution_breached_at` before sending (volatile in the backup
registry); a notice more than `SLA_ALERT_STALE_MS` late is flagged silently (first run after upgrade must not announce history);
a priority change clears the flags, reopening a finished ticket clears the resolution ones; recipients are the assignee, else everyone in a
group with moderator/admin on Tickets plus the admin group. (3) *Saved replies* (`ticket_canned_replies`, `tickets/canned-replies`, list needs
`tickets:read:any`, writes `tickets:admin`): placeholders are filled by the web with `renderCannedReply`, an unfillable one stays visible.
(4) *Tickets from email* (`tickets/ticket-inbound.ts`, job `ticket-inbound` 60 s, `mutex:ticket-inbound`, settings category `helpdesk`,
`tickets.inbound.*`, edited in Tickets > Settings by a Tickets admin, routes `tickets/inbound/{status,test,check}` need `tickets:admin`, are `@SessionOnly` and MCP-excluded; **the host is refused when it is loopback, link-local, a container of this stack or a one-word name, at save time (`contactHostProblem`) and again after DNS (`assertMailboxHost`)**): read-only IMAP
(`imapflow`, `mailparser`: the only inbound-mail code; versions pinned and older than two weeks when added) that tracks `{uidValidity,
lastUid}` in `job_state` (first look = last 24 h only) and records every message by Message-ID in `ticket_inbound_log` (unique; the real
dedupe; `skip` in the backup registry; 90-day prune). **Never trust a From line**: a sender must be an active, approved account with
`tickets:write:own` AND pass `senderAuthenticated` (`strict` DMARC pass by default, `aligned`, or `off`), judged only on an
Authentication-Results header written by `tickets.inbound.auth_server` (`pickAuthResultsHeader`; a blank name believes nothing, and with sender
checks on and no name the job stops before reading, `inboundAuthServerProblem`, so waiting mail is read once it is set; until 2026-11-13 a blank
name believed the topmost header, which a sender can forge when the provider adds none). **The mailbox never
sends anything back** (no bounces, no auto-replies: no loops, no backscatter), skips auto-generated mail, the site's own address and a
sender over 30 messages/hour. A subject with `[#n]` comments on that ticket if the sender can read it (quoted text cut by
`stripQuotedReply`), otherwise a new ticket is opened (a forwarded message is the request, so new tickets keep quoted text). Ticket emails
get `[#n]` in the subject and `Reply-To` = the help address only through `CreateNotificationInput.ticketNumber`, and only for notices the
requester may see (never an internal note: a reply would publish it). `TicketEvents` is the one place that fans out ticket realtime and
notifications, shared by the routes and the mailbox. Tests: `helpdesk-rules.test.ts`, `inbound-mail.test.ts`, `ticket-helpdesk.integration.test.ts`,
`ticket-inbound.integration.test.ts` (DB tests on CockroachDB and YugabyteDB; with `TEST_IMAP=host:imapPort:smtpPort` it also runs against a
throwaway GreenMail), `notification-reply-to.integration.test.ts`, smoke `tests/smoke/helpdesk.mjs`, e2e `helpdesk.spec.ts`.

**Wiki upkeep: templates, backlinks, review, history** (migration 0067; rules in `packages/shared/src/wiki-pages.ts`, unit-tested in
`apps/api/test/wiki-pages.test.ts`). (1) *Backlinks are computed, never stored*: `WikiService.backlinks` finds bodies containing
`/wiki/<id>` with a `LIKE`, then confirms with `extractWikiLinks` (code is ignored; `/edit`, `/revisions` are not page links) and
filters by `readablePredicate`, so there is no link table to drift, back-fill or restore and an edit shows on every node at once.
A page the caller cannot read is never named. Fine for a church-sized wiki; if it ever grows to thousands of large pages,
that is the moment for a table (maintained in `create`/`update`/`revertToRevision`/import). (2) *Review*: `wiki_pages.last_reviewed_at/by`,
`review_interval_days` (null = the `wiki.review.default_days` setting, edited at `/wiki/settings`, default 180; 0 = never) and `review_notified_at`
(volatile in the backup registry). **A page is due when `wikiReviewState` says so: the clock starts from the LATER of `updated_at` and
`last_reviewed_at`**, so editing counts as looking and confirming (`POST /wiki/:id/review`) is not an edit: no revision, `updated_at`
untouched, no "page updated" notices (`WikiWritesService` also skips them for an interval-only PATCH). Changing the interval needs
owner or wiki admin (`canManage`), like visibility. The `wiki-review` cluster job (hourly) notifies owners with kind
`wiki.review_due`, one message per owner per run; each page is CLAIMED by a conditional UPDATE on `review_notified_at`, and the flag
only counts while newer than the page's last edit/review (`wikiReviewNotice`), so nothing needs resetting. A page already
overdue by more than `WIKI_REVIEW_NOTICE_WINDOW_MS` is flagged silently (turning the check on must not announce history).
(3) *Templates*: built-ins are code (`WIKI_STARTER_TEMPLATES`, ids `starter:*`), saved ones are `wiki_templates` (list needs
`wiki:read:own`, writes `wiki:admin`, audited `wiki.template.*`); `{{date}}`/`{{author}}` are filled in the web. (4) *History*:
the diff model is `apps/web/src/lib/wiki-diff.ts` (unit-tested in the web package: line diff, word marks inside paired changed
lines, folded unchanged runs; both texts are given a final newline first, or the last line always differs). The page picker
(`components/wiki-page-picker.tsx`) renders in a portal: inside the editor, `fixed` is relative to the editor box. MCP: three
hand-written read tools; confirming a review and saving templates are not tools (a person's claim / admin curation, rules in
`route-rules.ts`). Tests: `wiki-upkeep.integration.test.ts` (CockroachDB and YugabyteDB), smoke `wiki-upkeep.mjs`, e2e
`wiki-upkeep.spec.ts` (a page can only become due by time, so only the integration test covers that).

**Wiki page access: reading and editing are two separate lists** (2026-11-12; rules in `packages/shared/src/wiki-access.ts`, unit-tested in
`apps/api/test/wiki-access.test.ts`). READ is `visibility`: `public` (everyone with the Wiki module) or `group` (the groups in `wiki_page_acl`, any
`can_edit`, plus the owner and `wiki:read:any`). EDIT is the owner, Wiki admins and every group whose row has `can_edit`, **on a public page too**, so
"everyone reads, a few groups edit" is a public page with edit rows; editing implies reading (on a restricted page the row is what lets the group
read). No migration: one table, two meanings. **`replaceAcl` saves through `normaliseWikiAcl`** (one row per group, last entry wins; a public page
keeps only its edit grants, a read-only row there means nothing). The page forms use one component, `wiki-access-editor.tsx` ("Who can read this
page" / "Who can edit this page"; add/remove go through the shared helpers, never by hand) and send the list through `normaliseWikiAcl`. The new-page and
import forms show it inline; **the edit form's 16rem menu column shows only a summary** (`wiki-access-card.tsx`, "Access": who reads, who edits) and an
"Edit access" button that opens the editor in a dialog working on a draft (Apply hands it to the form, which saves it with the page; Cancel and Escape discard;
Apply is disabled for a restricted page with no group). Every flex child and fieldset in the editor is `min-w-0`: a fieldset sizes to its content, and a
long group name pushed the Add button out of the narrow card and made the page scroll sideways (e2e `wiki.spec.ts` checks the form and the dialog). Only the owner
or a Wiki admin changes either list. Do not reintroduce a single "Visibility" control that hides the edit list inside "restricted".

**Wiki archive** (2026-11-13; migration 0095 `wiki_pages.archived_at/archived_by`; `POST /wiki/:id/archive` and `/unarchive`, audited `wiki.archive`/`wiki.unarchive`, MCP
`wiki_archive_page`/`wiki_unarchive_page`). An archived page is put away, not deleted: **left out of the menu, last in searches, still readable and editable by address.**
Rules: (1) *Who:* anyone who may edit the page (`canWritePage`; a reader gets 403, a page they cannot read 404), because it is reversible and not a delete. (2) *Not an
edit:* no revision, `updated_at` untouched, no "page updated" notice, and archiving twice keeps the first date and person. (3) *The menu:* `WikiService.tree` leaves archived
pages out **by default**, so the sidebar, both page pickers and MCP `wiki_tree` need nothing; `?archived=1` returns them flagged `archived: true` and the page view uses that
only to draw a breadcrumb through an archived parent (its menu goes through `withoutArchivedPages`). **A page under an archived page is not archived and stays in the menu,
at the top level**, like a page whose parent cannot be read, never hidden with its parent. (4) *Lists:* `GET /wiki` without `q` leaves archived pages out; with `q` (the
wiki search box, MCP `wiki_search`) they come LAST (`ORDER BY archived_at IS NOT NULL`, so the limit cuts them first) and carry `archivedAt`. (5) *Global search:* the
document has top-level `archived: true` only when archived (so turning it on re-indexed nothing), `archived` is a filterable attribute, and `SearchService.search` runs the
live query first and fills the rest with `archived = true` hits: a re-sort of one query would let well-matching archived pages push live ones out of the limit. The result
carries `archived` and both search lists badge it. (6) Review: an archived page is not "due" (`reviewList`, the `wiki-review` job). Tests: `wiki-archive.integration.test.ts`
(both engines, one integration file at a time), `wiki-pages.test.ts`, smoke `wiki-upkeep.mjs`, e2e `wiki.spec.ts` (whose cleanup now lists with `?q=` because browsing hides
archived pages).

## Wiki file import (.docx / .pdf / .txt)

`POST /wiki/import` (`wiki/import/`, any account with `wiki:create`, which is the baseline `user` group). **A .docx is a zip and a .pdf can hold
compressed streams: a stranger controls how big they inflate.** A 1.5 MB .docx (one picture of zeros) and a 0.5 MB .pdf each killed a 1 GiB process
(exit 137), and the unsandboxed importer also stored the inflated picture as a 1 GiB attachment, past the attachment cap. Rules:
(1) **docx and pdf are read ONLY by `convertInSandbox`** (`convert-sandbox.ts`, worker `convert-worker.ts`): a child process with an empty
environment, a 60 s clock, `--max-old-space-size=512` and an RSS ceiling (768 MiB, read from `/proc` every 100 ms; typed arrays are outside the heap, so
`--max-old-space-size` alone does not stop an inflating parser). Never call mammoth or pdf-parse from the API process. A killed child gives the
person a plain 400 and the API carries on; at most 2 conversions run per node and 6 wait, the rest get 429 (`ConversionLimiter`).
(2) The child holds no database or secrets; embedded images come back over IPC and the API stores them through `AttachmentsService`, at most 200 per
file, `MAX_ATTACHMENT_BYTES` each and 100 MiB together (extras are left out of the page, the import goes on).
(3) The converted markdown never keeps a link target outside http/https/mailto/tel/relative (`dropUnsafeLinks`), and text that merely looks like markup
(`<img onerror=...>` typed in Word) is escaped so it stays text. (4) A failed import deletes its page and attachments. pdf-parse 1.1.4 bundles pdf.js
1.10.100 (2018) and is unmaintained: that is the reason the sandbox exists, and a replacement is worth considering. Tests: `wiki-import-sandbox.test.ts`
(stand-in workers under `test/fixtures/import/`), `wiki-import-docx.test.ts`, smoke `tests/smoke/wiki-import.mjs` (builds the bombs in the test; a real
browser-made PDF is `tests/smoke/fixtures/small.pdf`). PDFs written by hand failed to parse in pdf.js 1.10 ("bad XRef entry") for a reason never found;
use a generated one.
