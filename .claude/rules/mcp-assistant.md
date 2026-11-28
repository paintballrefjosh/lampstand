---
paths:
  - "apps/api/src/{mcp,assistant}/**"
  - "packages/shared/src/assistant*.ts"
  - "apps/web/src/app/assistant/**"
  - "apps/web/src/components/assistant*"
  - "apps/api/src/db/schema/assistant.ts"
  - "apps/api/test/{mcp,assistant}*"
  - "tests/assistant/**"
  - "scripts/assistant-eval.mjs"
  - "tests/smoke/{mcp,assistant}.mjs"
  - "tests/e2e/tests/assistant*"
---

# MCP server and Assistant

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

## MCP server

`/api/v1/mcp` (`apps/api/src/mcp/`) is a Streamable HTTP MCP server for agents,
e.g. a Claude Code session documenting systems in the wiki. Stateless: each POST
builds a fresh low-level SDK `Server` + transport bound to the caller and answers
with plain JSON (GET/DELETE 405). **API tokens only**: the controller refuses a
request without `user.apiToken` (i.e. a browser session). Every call is a POST,
so the route carries `@ReadOnlyPerOperation()` to let read-only tokens past
SessionGuard's method check, and `McpToolsService.call` refuses any tool not
annotated `readOnlyHint: true` for them. Module-limited tokens need nothing
extra: SessionGuard already narrowed `user.permissions`. Tools
(`mcp.tools.ts`) call the same services as the REST routes (`WikiService`,
`WikiWritesService`, `WikiFoldersService`), so permissions, page ACLs, revisions,
search, realtime and notifications match the UI; each tool also checks a
permission string against `user.permissions`. Audit entries carry the token id
like every other token request. `wiki_update_page` requires
`expectedUpdatedAt` (WikiService.update refuses with 409 if the page changed).
No delete tool by design. The SDK sees hand-written JSON Schemas; inputs are
validated with zod in the tool (the SDK needs zod >= 3.25, hence the workspace
pin). Tests: `apps/api/test/mcp-tools.test.ts` (incl. the SDK client over HTTP).
When adding a tool: JSON Schema + zod args + permission + `recordAuditEntry`
for writes.

**The rest of the app is reached through a route bridge, not through services**
(plan, phases and rules: [docs/mcp.md](../../docs/mcp.md)). A catalogue tool
(`apps/api/src/mcp/bridge/catalogue/*.tools.ts`, `defineTool`) names one REST route,
reuses the route's Zod schema for its input (the JSON Schema is generated, never
hand-written), and `ApiBridge` calls the route in-process with `inject` carrying the
caller's own bearer token. That keeps guards, token limits, audit (with the token id),
and the controller's own side effects (realtime, notifications) identical to REST;
never call a service from a new tool when a route exists. **Every route must be a tool or
named in `route-rules.ts` with a reason** (`mcp-coverage.test.ts` fails otherwise): add
a tool and delete its `pending` rule, or add an `excluded` rule. `tools/list` shows a
caller only the tools its permissions allow (read-only tokens: reads only). Read-only
admin, no delete tools for tickets/wiki/accounts, and a future "operational" token level
for equipment-touching tools are decided (2026-10-12). A tool whose route returns a credential
sets `redact` (values become `[hidden]`) or `transform` (settings, audit: `bridge/scrub.ts`); devices with logins (hosts, printers, UPS, switches)
are registered in the web app only.
Files on tickets, notes and wiki pages are tools too (`catalogue/attachments.tools.ts`, `bridge/attachments.ts`): a tool with `binary: "download"` answers with
content blocks (an image as an image, text as text, other types described only) and `binary: "upload"` sends `text` or `contentBase64` (1 MiB) to the route as
multipart. No delete tool.

## Assistant

`/assistant` (`apps/api/src/assistant/`, rules in `packages/shared/src/assistant.ts`, unit-tested in `apps/api/test/assistant.test.ts`; design
[docs/assistant.md](../../docs/assistant.md)): a chat answered by an EXTERNAL model the Assistant admin chooses (`assistant.provider` `anthropic` through
`@anthropic-ai/sdk`, or `openai_compatible` for any `/v1/chat/completions` server), settings category `assistant` (managed by `assistant:admin`, the Assistant module's admin tier, which a site admin also has; the moderator tier sees usage only; **no tier reads another person's conversations**), migration 0080. Rules:
(1) **Off until ready**: `SettingsService` refuses `assistant.enabled = true` unless `assistantReadiness` is all green (provider + model, a
passing Test connection whose `assistantFingerprint` matches the CURRENT provider/URL/key/model, a group with the `assistant` module, a budget or
both prices 0, the privacy notice acknowledged for the current destination). Test results and the acknowledgement live in `job_state`
(`ASSISTANT_STATE`), never in settings. (2) **It acts as the person, read-only**: its lookups are the MCP catalogue's READ tools (`BRIDGE_TOOLS`)
called through `ApiBridge` with the person's own session cookie, filtered by `assistantMayUseRoute` (no admin, audit, settings, backups, accounts,
tokens, sessions, alert channels, Cisco config backups, Planning Center) and by their permissions, plus `search`. Never give it a write tool or a
service call that skips the route. (3) Lookup results go to the model wrapped as untrusted data and cut at 12000 characters; the web renders
answers as Markdown with images dropped and outside links labelled with their host. (4) Limits: per person per minute/day, a monthly budget from the
admin's prices (`assistant_usage_daily`, one row per day and person), and site-wide slots (`assistant-slot-N` leases, `assistant.max_concurrent`).
(5) The whole controller is `@SessionOnly` (an API token cannot spend the budget) and MCP-excluded; `POST /assistant/chat` answers with SSE over a
hijacked reply (Caddy has `flush_interval -1` for it), audited per question through `startDynamicAudit` (`assistant.chat`, counts only, never the
text). (6) Conversations are private to their owner (another person's id answers 404), kept `assistant.history_retention_days` (0 = deleted once
answered) by the `assistant-retention` job; the three tables are `skip` in the backup registry. Tests: `assistant.test.ts`,
`assistant.integration.test.ts` (CockroachDB and YugabyteDB, a fake OpenAI-compatible server), smoke `tests/smoke/assistant.mjs` (closed doors
only: no model is called).
(7) **Proposed actions** (`packages/shared/src/assistant-actions.ts`, unit-tested in `assistant-actions.test.ts`): the model's one non-lookup tool
`propose_action` only RECORDS a proposal (`assistant_messages.actions`, at most 3 per answer), offered per kind by the permission its route needs
(`assistantActionsFor`). The browser makes the real call on Confirm (`proposalRequest`, as the person, through the normal audited route) and then
`PATCH /assistant/messages/:id/actions/:actionId` records done/dismissed ONCE. **Never execute a proposal on the server, and never take a card's
description from the model** (an incident's is read from the database). A new kind = a schema branch, a permission, a `proposalRequest` case, a
headline, tests. Pausing alerts is always 1-24 hours. (8) *Figures* are `assistant_answers` (migration 0086): one row per answer, no text, no person,
400 days, `skip` in the backup registry; the usage page is `/assistant/usage` and the setup page `/assistant/settings` (Assistant admins, with the readiness checklist and privacy notice). Feedback: `POST /assistant/messages/:id/feedback` (comment redacted from
audit). (9) Job `assistant-watch` (5 min, `job_state` `assistant/watch`) tells the admin group and the Assistant admins (`assistantAlertRecipients`) at 80%/100% of the budget and when the provider fails
three answers in a row (`assistantProviderDown`) and recovers; not silenced by maintenance mode. `/assistant/status` carries `health`;
`/health/services` has an assistant card (degraded only). (10) The slide-over (`components/assistant-panel.tsx`) has no button of its own (a third top-bar control
wrapped the bar at 1280 px): the user menu's "Ask the assistant" and the palette open it via `ASSISTANT_OPEN_EVENT`; while a question is typed the
palette shows the entry in its own LAST group (`paletteFilter` keeps it; cmdk does not reorder groups, so DOM order decides what Enter picks). (11) The evaluation set is
`tests/assistant/questions.yaml` + `scripts/assistant-eval.mjs`: expected facts are READ from the API as the asking account at run time, `--dry-run`
is free, `--yes` spends money; never run it from a test suite. e2e `assistant.spec.ts` never sends a question when the assistant is on.
