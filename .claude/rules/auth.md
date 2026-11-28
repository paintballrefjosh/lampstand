---
paths:
  - "apps/api/src/{auth,auth-tokens,api-tokens,users,groups,security-posture}/**"
  - "apps/web/src/lib/{auth,db,db-schema,signin-failure,signin-failure.test}.ts"
  - "apps/web/src/middleware.ts"
  - "apps/web/src/app/{signin,change-password,forgot-password,set-password,pending,me}/**"
  - "apps/web/src/app/admin/{users,groups,permissions,api-tokens,security}/**"
  - "apps/web/src/app/api/{auth,me,users,groups,admin}/**"
  - "apps/web/src/components/{api-tokens,sessions-panel,linked-signins-panel,require-module}.tsx"
  - "packages/shared/src/{oauth-policy,client-ip,request-origin,security-posture,user-agent,modules,permissions}.ts"
  - "packages/shared/src/schemas/{api-token,user,group}.ts"
  - "apps/api/src/db/schema/{users,groups,sessions,api-tokens,auth-tokens,roles}.ts"
  - "infra/caddy/Caddyfile"
  - "apps/api/test/{auth,api-token,oauth,session,client-ip,request-origin,security-posture,user-agent,must-change}*"
  - "tests/smoke/api-tokens.mjs"
  - "tests/e2e/tests/{00-auth,security,tokens}*"
  - "apps/api/src/main.ts"
---

# Auth, API tokens, sessions, account lifecycle

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

## Auth flow

Sign-in providers are configured at runtime in the `settings` table (toggles +
OAuth credentials), so they change without a redeploy:
- **Local credentials** (argon2id) — `auth.local.enabled`
- **Google** (OAuth/OIDC) — `auth.google.enabled` + `google.oauth.*`
- **Microsoft Entra ID** (OAuth/OIDC) — `auth.microsoft.enabled` + `microsoft.oauth.*`

1. User hits `/signin` (renders only the enabled providers)
2. Google / Microsoft OAuth, or local credentials (argon2id verify)
3. If the user has TOTP enabled, the credentials flow also requires a 6-digit code
4. On success, Auth.js issues a signed JWT session cookie
5. `web` calls `api` with the session cookie; `api` validates it with the shared
   `AUTH_SECRET` in `SessionGuard`
6. Service-to-service / script calls use `api_tokens` (bearer header), not sessions
   (see ### API tokens)

`web` reads the provider config from the internal-only endpoint
`/api/v1/auth/providers/internal` (gated by an `X-Internal-Token` derived from
`AUTH_SECRET`, and 404'd by Caddy on the public proxy). A toggle can't be enabled
until its credentials are present — enforced by `TOGGLE_PREREQUISITES` in
`packages/shared/src/settings.ts` and the settings UI.

### API tokens

Personal bearer tokens (`cdt_` + 32 random bytes, base64url) for scripts and
agents; module `apps/api/src/api-tokens/`, shared schemas in
`packages/shared/src/schemas/api-token.ts`, migration 0049. Only the SHA-256
hash and the first 8 characters are stored; the plaintext is in the create
response once, and `@Audited({ redactKeys: ["token"] })` keeps it out of the
audit snapshot.

- **A token acts as its owner, narrowed:** `AuthService.findUserByApiToken`
  loads the owner through the normal `loadUserById` (so group changes apply at
  once and a disabled/deleted owner's tokens die), then `scopeUserToToken`
  (`auth/api-token-scope.ts`, unit-tested) intersects `permissions` with what the
  token's `modules` could grant and cuts `access` to them. It returns a copy: the
  owner record is shared through the user cache. `read_only` tokens get a 403 on
  any non-GET/HEAD/OPTIONS in `SessionGuard`.
- **Bearer is judged alone:** a request with `Authorization: Bearer` never falls
  through to the cookie. Unknown, revoked, expired, and "feature off"
  (`auth.api_tokens_enabled`) all give the same 401. Bearer requests skip the
  TOTP-enrolment gate (creating a token is session-only, so it already passed).
- **Three levels:** read-only, read and write, and `allow_operational` (migration 0058, off for every older token; needs a
  non-read-only token). `@OperationalOnly()` (`auth/operational-only.decorator.ts`) marks a route that acts on live
  equipment (switch ports and pushes, DNS record writes and sync, scans, polls, host OS updates, ProPresenter slides);
  `SessionGuard` gives a bearer request without the level a 403, a browser session is unaffected. The MCP `operational`
  tools are exactly these routes (`mcp-coverage.test.ts`), hidden from `tools/list` and refused for other tokens. A new
  route that touches equipment gets the decorator.
- **`@SessionOnly()`** (`auth/session-only.decorator.ts`) refuses bearer requests:
  token create/revoke (own and admin), password change, `PATCH /me` (email), and
  the whole TOTP controller. Put it on anything that would let a leaked token
  outlive revocation or take over the account.
- **Lifetime:** every token expires within `auth.api_tokens_max_days` (default
  365; 0 also allows "never"); default 90 days. Revoking sets `revoked_at`;
  tokens are never deleted, so `audit_log.api_token_id` keeps resolving (the
  audit list returns `apiTokenName`). `last_used_at`/`last_used_ip` are written at
  most once a minute.
- **Endpoints:** `GET|POST /me/api-tokens`, `DELETE /me/api-tokens/:id`;
  `user:admin`: `GET /admin/api-tokens?status=&userId=`,
  `DELETE /admin/api-tokens/:id`, `POST /admin/users/:id/api-tokens` (issue to a
  service account), `POST /admin/users/:id/api-tokens/revoke-all`.
- **UI:** `/me/api-tokens` (own tokens; linked from the user menu and the profile
  page), `/admin/api-tokens` (everyone's, filter by status), and an "API tokens"
  section in the `/admin/users` Manage drawer (count, issue to this user, revoke
  one/all). Shared pieces are in `apps/web/src/components/api-tokens.tsx`; the form
  reads `GET /me/api-tokens/policy` (enabled, max days) because non-admins can't
  read settings. The audit table shows "via token <name>". Docs: INSTALL.md
  "Using the API".
- **Not covered:** the Socket.IO handshake still reads the session cookie only.

### Sessions, sign-out and sign-in hardening

- **Sessions can be ended server-side.** `users.session_version` (migration 0060) is stamped into the cookie's JWT as
  `sv` when the web signs someone in (`jwt` callback in `apps/web/src/lib/auth.ts`, read from the database because
  OAuth users come from the adapter). `AuthService.revokeSessions(userId)` bumps it; `SessionGuard` and the realtime
  handshake refuse a cookie whose `sv` differs (`auth/session-version.ts`; a cookie without `sv` counts as 0, so
  the upgrade signed nobody out). It is bumped by: password change, password reset by link, admin password reset,
  admin 2FA removal. Everything that ends a session also needs the caller to sign in again: tests and scripts that
  change the password must sign in afterwards (smoke and `tests/cluster/*` do).
- **One browser can be signed out alone** (`user_sessions`, migration 0062; `auth/sessions.service.ts`). The web puts a random
  `sid` in the cookie's JWT at sign-in (`jwt` callback); the API creates the row the first time `SessionGuard` sees it
  (`SessionsService.touch`: at most one write per session per 5 minutes per node, never on the request path, address and
  browser from that request) and ending a session sets `revoked_at`. The revoked ids ride along with the cached user
  (`AuthenticatedUser.revokedSessions`, loaded by `loadUserById`; `invalidateUser` drops it on every node), so judging a
  cookie costs no query: `sessionIsCurrent` checks `sv` and `sid`, in `SessionGuard` and the realtime gateway. Routes
  (`@SessionOnly`, in `me.controller.ts`): `GET /me/sessions`, `DELETE /me/sessions/:id` (`current` = this browser; it
  upserts, so signing out right after signing in still ends the session), `POST /me/sessions/revoke-others`,
  `POST /me/sessions/revoke-all` (bumps `session_version`: also ends cookies that have no `sid`). Admin:
  `GET /users/:id/sessions`, `POST /users/:id/sessions/revoke`. The web's sign-out button calls `DELETE .../current` first.
  An ended row is kept 90 days and an idle one 30 (`sessions-prune` job), so a stray cookie never revives a session;
  never delete a revoked row sooner. Cookies from before the table have no `sid`: not listed, ended by "sign out
  everywhere". `apiFetch` forwards the browser's User-Agent (the audit log's `user_agent` used to say "node").
  `describeUserAgent` (`packages/shared/src/user-agent.ts`) turns it into "Firefox on Windows".
- **`POST /me/change-password` needs `currentPassword`**, except for a forced change (`mustChangePassword`) and for an
  account with no local password yet. The web profile form signs the person out after it.
- **The person's address** (`req.ip`: rate limits, failed sign-in counts, audit, sessions) is decided by the API, per request, from
  the site settings `auth.trusted_proxies` and `auth.trusted_proxies_strict` (Admin > Settings > Authentication; rules in
  `packages/shared/src/client-ip.ts`, the per-node holder `auth/client-ip.ts`, refreshed every 5 s; Fastify `trustProxy: trustProxyHop`).
  Caddy never picks: it keeps a trusted peer's `X-Forwarded-For` and appends the address it was connected from (**never `header_up
  X-Forwarded-For` in the Caddyfile**), and the web passes the whole chain on (`forwardedChain`, rightmost 20). Modes: `any` (no list, strict
  off: the leftmost entry, which anyone can forge; the default, so an upgrade changes nothing, and a Security overview warning), `strict` (from
  the right, the first address not in the list; with an empty list, whoever connected to Caddy), `standard` (the leftmost only when a trusted
  proxy connected). `TRUSTED_PROXIES` in `.env` (the older way) still narrows which peers Caddy passes on and is the API's list, read strictly,
  while the setting is blank. Until 2026-11-13 Caddy took the leftmost entry itself and a forged header stepped around every per-address limit.
  Tests: `client-ip.test.ts` (a real Fastify with the trust function), smoke.
- **Failed sign-ins are counted per account** (`RateLimitService.failures/recordFailure/clearFailures`, same
  `rate_limit_buckets` table, key `acct|<identifier typed>`, existing account or not): 10 failures in 15 minutes
  refuse further attempts with 429 `too_many_attempts`; a success clears it. **And per address**: 30 failures in 15
  minutes (`MAX_FAILED_SIGNINS_PER_IP`, key `acct|ip|<address>`, never cleared by a success). Failures, not attempts: a
  church's volunteers share one public address on the building Wi-Fi. `verify-credentials` always spends the
  time of one argon2 check (`verifyPasswordOrDecoy`) and says "deleted" only after the right password.
- **"Invalid credentials" is only for a refusal** (`apps/web/src/lib/signin-failure.ts`, unit-tested): the API's 400/401 to
  `verify-credentials`. A 5xx or any other status, no answer within 30 s or an unreadable one is `code=unavailable`, and the
  sign-in page says the server could not check the password. Until 2026-11-26 a database outage read as a wrong password.
- **`verify-credentials` is internal only** (Caddy `@internal_only` + `assertInternalCaller`), refused while
  `auth.local.enabled` is off, and the web's Credentials `authorize()` passes the person's address in
  `X-Forwarded-For` (until 2026-10-25 it sent none, so every sign-in counted against the web container's address).
- **The strict 10/minute limit** (TOTP, password change, reset request/consume; 60/minute for `verify-credentials`) is set
  by an `onRoute` hook in `main.ts` that **must be added before `@fastify/rate-limit` is registered**: the plugin reads
  `config.rateLimit` in its own `onRoute` hook, hooks run in the order added, and with ours second (until 2026-10-25)
  none of these routes had more than the general limit. The last smoke test proves an 11th try is refused.
- **Cookie writes must come from this site's pages** (`crossOriginWriteRefused`, `packages/shared/src/request-origin.ts`):
  `SameSite=Lax` still lets another origin of the same site (a sibling subdomain) post a form, multipart uploads
  included. `SessionGuard` refuses a non-GET carrying a session cookie whose `Sec-Fetch-Site` is cross-site/same-site or
  whose `Origin` is not the request's host (or the `APP_URL` list); a request with neither header (scripts, the web's
  own server-side calls) passes. The web middleware applies the same rule to its route handlers (they proxy server-side,
  where the browser's headers never reach the API), except `/api/auth/*` (Auth.js has its own CSRF token).
- **Public reset routes** (`/auth/tokens/request-reset`, `/consume`) share the strict 10/min/IP bucket. A reset email is
  sent at most once per account per 5 minutes; a link is claimed with one conditional UPDATE (single use under
  concurrency), refused for a disabled or deleted account, and spends the account's other outstanding links.
  The email's link comes from `site.url`/`APP_URL` only (never from the request); with neither set it logs a warning
  and the link is relative.
- **The realtime socket** refuses a handshake whose `Origin` is not this site (`handshakeOriginAllowed`: Host or
  X-Forwarded-Host, or the `APP_URL` list) and every 30 s re-reads each connected user (disconnect when gone, disabled
  or signed out; leave rooms the user lost access to).

### Security overview (admin)

`/admin/security` (`site:admin`, `@SessionOnly`, `GET /admin/security-posture`) lists how the site is set up as checks
(`critical` / `warn` / `info` / `ok`): the install password still in place, administrators without two-factor, Google and
Microsoft sign-in scope, pending approvals, API tokens that never expire or sit idle, Cisco switches with no pinned host
key, maintenance mode, Site URL, SMTP, backup age, offsite copies, audit retention. `SecurityPostureService` only gathers counts and
settings (never a secret); the rules are the pure `evaluatePosture` in `packages/shared/src/security-posture.ts`
(unit-tested), the page only draws them, and every row says its status in words and an icon. **A new security-relevant
setting or policy gets a check there** (a fact in `PostureFacts`, a rule, a test); it reads, it never fixes anything.

### TOTP / 2FA is optional, off by default

TOTP enrolment is **per-user** and **opt-in**. Two policy knobs in the settings
table can require it:

- `auth.require_totp_admin` — every member of the `admin` group must enrol.
- `auth.require_totp_all` — every signed-in user must enrol.

Both default to **off**. When on, the `SessionGuard` lets affected users
authenticate and read (GETs pass) but refuses all mutating requests until
they complete `/auth/totp/enroll` + `/auth/totp/confirm`. Recovery: a user with
recovery codes signs in with one (single use); an admin can remove someone's 2FA at
`/admin/users` (Manage > Two-factor, `POST /users/:id/totp/reset`, which also signs them out everywhere).
The TOTP secret is stored encrypted (`enc:v1:` like other secrets; a plaintext row is encrypted on first read), so a
backup restored under a different `AUTH_SECRET` leaves 2FA accounts needing that admin reset. A code is accepted once
(`totp_secrets.last_step`) and a recovery code is spent atomically (`AuthService.verifyTotpCode`/`consumeRecoveryCode`).

There is no "admin role implicitly requires TOTP" in the code — earlier
versions of these docs claimed there was; that claim was aspirational, not
enforced. The two settings above are the only TOTP gates.

### Account gating & lifecycle

`SessionGuard` enforces these gates; each blocks everything but a narrow
allowlist until cleared (and each throws a **403**, not a 401 — the enforcement
calls run outside the cookie-decode try/catch so the 403 isn't swallowed):

- **`must_change_password`** — set on the bootstrap admin, on admin password
  resets, and optionally on admin-created users. Blocks everything, reads
  included, except `GET /me` and `POST /me/change-password`
  (`enforceMustChangePassword`, unit-tested); the web force-routes to
  `/change-password`. Reads are blocked on purpose: the seeded `admin`/`admin`
  must not be able to browse the instance's data before a real password is set.
- **`approval_status = "pending"`** — an external OAuth account awaiting admin
  approval. Blocked from everything except `GET /me`; the web routes them to
  `/pending`.

**External-account approval (for volunteers):** when
`google.allow_external_with_approval` is on, Google accounts *outside*
`google.workspace_domain` may sign in but land `pending` with no
group/permissions until an admin approves them at `/admin/users` (Pending tab).
Workspace-domain accounts are auto-approved into the default `user` group. The
decision lives in `usersService.provisionOAuthUser`. (Microsoft accounts don't
use the pending gate.)

**Who may sign in through OAuth** is decided by the pure functions in
`packages/shared/src/oauth-policy.ts` (tested in `apps/api/test/oauth-policy.test.ts`), called from the
`signIn` callback in `apps/web/src/lib/auth.ts`: Google must report `email_verified`, and a Google
account counts as a workspace member only if its `hd` claim equals `google.workspace_domain` (the web
sends it as `hostedDomain` to `oauth-provision`; an absent field, from an older web build, falls back to
the address). Microsoft sign-in is refused when no allowed domains are set and the tenant is a shared
endpoint (`common`/`organizations`/`consumers`); the allowed-domain list is matched against the user
principal name, never the free `email` claim (only a single tenant also falls back to `email`).

**External identities: one person, many sign-in methods** (2026-11-14). `users` is the person, `accounts` (Auth.js's table, PK `(provider, providerAccountId)`) holds
each linked external login and `credentials` the optional local password; any mix is valid and every identity keys on the provider's own stable id, never the email,
after the first sign-in. **A first sign-in whose address matches an existing account attaches to it** (an admin-made account with no password is how a person is
pre-provisioned for Google or Microsoft; one with a password can be linked too), but only for a provider that `mayLinkByEmail` (`packages/shared/src/oauth-policy.ts`,
`OAUTH_EMAIL_TRUST`) believes: Google (`verified-claim`: the `signIn` callback has already refused an unverified address by the time Auth.js links), Microsoft only for ONE named
tenant (`single-tenant-only`: on `common`/`organizations`/`consumers` the `email` claim is editable by the account owner, the nOAuth takeover), any other provider `never`.
The provider config sets `allowDangerousEmailAccountLinking` from that function and nowhere else; **a new provider is added to `OAUTH_EMAIL_TRUST` on purpose** (unknown = never,
tested). The link is then made from the profile instead: **Security > Linked sign-in methods** (`linked-signins-panel.tsx`) runs the ordinary OAuth flow while signed in, which Auth.js
attaches to the current account whatever its address. Rules: (1) the `signIn` callback runs BEFORE the link, with a fresh random `user.id` that matches no row, so
`provisionOAuthUser` looks the person up by email too (`byEmail`): a soft-deleted account answers `deleted`, a disabled one `rejected`, and "already in a group: an admin's
decision stands" applies; that lookup is for the DECISION only, every write stays tied to a row under the given id. (2) Auth.js writes the `accounts` row itself, so the web's
`linkAccount` event (skipped when `createUser` fired in the same request) calls `oauth-provision` with `linkedNow` and the API records `user.identity.link` through the dynamic
audit (replacing that call's route row). (3) `IdentitiesService.unlink` (`GET /me/identities`, `DELETE /me/identities/:provider?id=`, `@SessionOnly`, MCP-excluded) is ONE
conditional DELETE that only runs while a password or another identity would remain, so two racing removals cannot lock a person out (409 otherwise, 404 when it is not theirs).
Unlinking does not end sessions made through that identity. (4) The approval rules are unchanged and differ by provider: Google can hold an outsider `pending`, Microsoft
admits whoever its tenant or allowed-domain list admits straight into the default group. Tests: `oauth-policy.test.ts` (`mayLinkByEmail`), `oauth-link.integration.test.ts`
(CockroachDB and YugabyteDB).

**Soft delete:** `DELETE /users/:id` tombstones the row (`deleted_at`,
`is_active=false`) but keeps authored content + audit attribution;
`POST /users/:id/restore` reverses it; `POST /users/:id/hard-delete` (SITE_ADMIN,
only after soft-delete) permanently removes the row and frees the email. The admin
users page has Active / Pending / Disabled / Deleted tabs and an `external` badge
for OAuth-linked accounts.
