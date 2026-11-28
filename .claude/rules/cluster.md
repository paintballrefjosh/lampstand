---
paths:
  - "apps/api/src/{cluster,cluster-admin,realtime,db,health}/**"
  - "apps/api/src/attachments/s3*"
  - "apps/api/src/backup/object-store.ts"
  - "apps/api/src/scripts/migrate.ts"
  - "packages/shared/src/db/**"
  - "packages/shared/src/builds.ts"
  - "packages/shared/src/schemas/cluster.ts"
  - "services/monitor/src/{claim,db,main}.ts"
  - "apps/web/src/app/admin/cluster/**"
  - "apps/web/src/lib/{consistency-cookie,use-poll,use-realtime,api}*"
  - "infra/docker-compose*.yml"
  - "infra/garage/**"
  - "scripts/{cluster,compose,release,rebuild,build-id,db-s3,s3-copy}*"
  - "tests/{cluster,db}/**"
  - "apps/api/test/{cluster,db-,read-your-writes,realtime,s3-config,health}*"
  - "tests/smoke/cluster.mjs"
  - "tests/e2e/tests/cluster*"
---

# Cluster coordination (multi-node)

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

## Cluster coordination (multi-node)

The app runs as several peer nodes behind an external load balancer
(`DEPLOY_MODE=cluster`); the plan, status and decisions are in
[docs/multi-node.md](../../docs/multi-node.md). Shape C (bundled database on every node) and shape D
(your own database and object store) have both run end to end on one host, D on CockroachDB and on
YugabyteDB (`tests/cluster/`); real multi-host behaviour (latency, partitions) is untried. New code
must keep a second node working:

- **Periodic work goes through `ClusterJobs.register(...)`**
  (`apps/api/src/cluster/`), never a bare `setInterval`/`setTimeout` loop. Every
  node runs every timer; only the node holding the job's `job:<name>` database
  lease does the work. On one node it is always the leader, so behaviour is
  unchanged. `schedule: "fixed-delay"` replaces a self-rescheduling
  `setTimeout`; the default `fixed-rate` replaces `setInterval`. Per-node work
  (rebuilding that node's own search index) is the exception and is not leased.
- **"Only one of these at a time" is a lease, not a boolean field.** A unit of
  work any node may start (a button press, an edit trigger) uses
  `LeaseService.acquireMutex` / `withMutex`; the DNS sync is the example.
- **State a job must keep across a handover** (alert baselines, failure
  counters) goes in `job_state` via `JobStateService`, not a `Map` on the
  service. Small JSON only.
- **Leases are judged by the database clock** (`now()`), never `Date.now()` on a
  node. Node identity is `NODE_ID` (compose defaults it to `main`); it must be
  unique per node.
- **Migrations must work with the previous release** (expand/contract): nodes
  upgrade one at a time, so for a while the old code runs against the new
  schema. Add columns and tables first; remove or rename in a later release.
  `migrate.js` holds the `migrate` lease, so concurrent runs serialise.
- `main.ts` enables shutdown hooks, so `onModuleDestroy` runs on SIGTERM; the DB
  pool closes in `onApplicationShutdown`, after it. Put cleanup that needs the
  database in `onModuleDestroy`. `ClusterJobs` waits (up to 6s) for jobs that
  are mid-run before the pool closes, then releases the leases.
- **Realtime across nodes** goes through `RealtimeGateway` (`toUser`, `toRoom`,
  `toRoomSnapshot`), which emits to this node's sockets and, through
  `ClusterBus` (`realtime_events`, polled about once a second), to the other
  nodes'. User-room events always go out; resource rooms go out only while
  another node has a viewer (`realtime_presence`). Ask "is anyone watching?"
  with `realtime.hasViewers(room)` (any node), never a local socket count. A
  payload too big to send on every change (the UniFi snapshot) goes through
  `toRoomSnapshot`: stored once in `live_snapshots`, other nodes get a pointer.
  Delivery is best effort, like the Redis pub/sub it replaced; nothing stored
  may depend on it.
- **In-memory caches** (user permissions, settings) are dropped on other nodes
  by publishing on `CACHE_ROOM`; do the same for any new per-process cache that
  a write must invalidate.
- **Outgoing email** goes through `MailQueue` and the `mail_outbox` table (any
  node claims, 5 attempts with backoff, at-least-once). Call
  `MailerService.sendBestEffort`; do not send inline.
- **Strict rate limits** (sign-in, TOTP, password change) set
  `config.rateLimit.shared`, which counts in `rate_limit_buckets`; the general
  per-IP limit stays per node.
- **Open database pools only with `createPool` from `@lampstand/shared/db`**, never
  `new Pool(...)`. It adds the `error` handler (a plain pool exits the process when
  a database node dies and an idle connection breaks), named connections
  (`application_name`), timeouts, a 30-minute connection lifetime, TLS from the
  URL, and automatic retry of statements that are safe to repeat. `@lampstand/shared/db`
  is a separate entry point (not the main index) so browser bundles never pull in
  `pg`; classic-resolution packages find it through `packages/shared/db/package.json`.
- **`DATABASE_URL` may list several hosts** (`postgresql://u:p@h1:5433,h2:5433,h3:5433/db`, libpq syntax): `createPool`
  then uses `HostSet`/`multiHostClient` (`packages/shared/src/db/pool.ts`): each new connection goes to the host with
  the fewest open from this process, a host whose connect failed is left out for 5 s (doubling to 60 s), and the
  failed attempt is a "never reached the database" error, so `withRetry` (and the same retry wrapped around
  `pool.connect()`) tries the next host. A one-host URL takes the old path untouched. Nodes are not discovered:
  they are the ones in the URL. Parse URLs with `parseDbUrl`, never `new URL()` (it rejects the host list).
  **Do not add the YugabyteDB smart driver (`@yugabytedb/pg`)**: it was built in, tested against a real three node
  cluster and removed (global connect state and a lock; its retry after a failed host left a connection attempt
  that never finished or timed out in 3 of 5 runs of the unwrapped driver, see docs/multi-node.md).
- **Every statement has a client-side timeout** (`DB_QUERY_TIMEOUT_MS`, default 60 s, `queryTimeoutMs` per pool, 0 for
  migrations): a host that hangs or loses power keeps its connections open and silent, and without it the statements
  on them wait minutes for TCP. A timed-out statement drops its connection and counts as "ambiguous" (retried only if
  it is a read). Statements that may legitimately run longer need their own pool with a larger value.
- **What the pool retries:** anything that never reached the database or that the
  database rolled back (40001, 40P01), and a plain SELECT/SHOW/EXPLAIN whose
  connection broke. **An ambiguous write is never retried** (it may have applied):
  it fails and the caller or user retries, so make a write that matters idempotent.
  A `WITH` counts as a write. Wrap a whole idempotent operation with `withRetry`
  if it needs more.
- **Database TLS:** `?sslmode=verify-full&sslrootcert=/path/ca.crt` in the URL, with a
  **host name, not an IP** (pg treats `require`/`verify-ca` as `verify-full`;
  `HostCheckingClient` checks the certificate against the real host even for an IP, but
  names are what certificates carry).
- **The `monitor` worker shares work through claims:** `claimDueMonitors`
  (`services/monitor/src/claim.ts`) takes due monitors with `monitors.claimed_until`;
  the claim is cleared when the check is recorded. Anything new the worker does that
  must happen once per cluster needs a lease (`acquireLease`, as its prune does).
  `scripts/rebuild.sh` rebuilds `monitor` as well as `api` and `web`.
  Each check records the node that made it (`NODE_ID`, passed to the `monitor` service in both compose files;
  `monitor_checks.node_id`, `monitors.last_checked_by`, migration 0055). `GET /api/v1/monitors/workers`
  (`MonitorsService.workers`) gives per-node figures for the last 10 minutes; the Services page shows a "Probe
  workers" strip, a "via <node>" line on each row, and on a monitor's page a "Checked by" card and a "By node"
  table that points out a node failing far more than the others. All of it is hidden unless `clustered` (more
  than one `full` node registered, or checks from more than one node), so a single node looks as before.
  Each probe-worker card also shows the node's build (`cluster_nodes.version`, i.e. `BUILD_ID`); `checkBuilds`
  (`packages/shared/src/builds.ts`, tested in `apps/api/test/cluster-builds.test.ts`) turns the cards that differ from
  the majority of live nodes red (all of them when there is no majority), with a banner naming the builds.
- **Every node must run the same build.** The web app's static files and (in other
  setups) Server Action IDs are named by the build, so a page from one node and a
  request answered by another must come from the same one. `scripts/build-id.sh`
  gives the id (the commit, or `<commit>-<hash of uncommitted changes>`); compose
  passes it as `BUILD_ID` to the api, web and monitor images; `next.config.mjs`
  uses it as the Next build id and `deploymentId`; `scripts/release.sh` builds the
  images once for a cluster to share. Builds of the same clean commit are
  byte-for-byte alike.
- **Server Action IDs are salted by a fixed build-time key** (the web Dockerfile), so
  they are identical in every build. The key that really encrypts action closures
  is derived from `AUTH_SECRET` at start (`apps/web/entrypoint.sh`); do not add a
  separate secret for it. Never remove the fixed build key: Next otherwise makes a
  random one per build and two nodes stop agreeing (measured: no IDs in common).
- **Realtime is WebSocket only** (gateway and clients), so the load balancer needs no
  sticky sessions. Do not add `polling` back.
- **Load balancer contract:** `/healthz` on the proxy (200 with `X-Lampstand-Node` while
  the API reaches the database, 503 otherwise, 503 `draining` while
  `data/caddy/drain` exists; `scripts/cluster.sh drain|undrain|status`).
  Which forwarded address is the client's is decided by the API from the admin settings
  "Trusted proxies" / "Strict proxy mode" (see "The person's address" under ## Auth flow), never by Caddy.
  The API's `/api/v1/readyz` answers 503 when degraded; keep it that way.
- **`scripts/rebuild.sh`** rebuilds api, web and monitor and recreates/restarts the
  proxy when its config changes. A new service or a new config file needs adding
  to it, or `make rebuild` will silently not apply it.
- **Object storage is configured through `resolveS3Config`** (`attachments/s3.config.ts`) and
  `getS3()`; never read `MINIO_*` / `S3_*` directly. `S3_*` names win, `MINIO_*` are the
  fallback. `S3_MODE=bundled|external` (decided in `scripts/compose.sh`) controls the bundled
  Garage profile (`bundled-s3`). Only path-style addressing is tested. **Never use `mc` with the
  keys in a URL** (`MC_HOST_*`): it does not decode percent-encoding and keys contain `/+=`;
  `mc` also compares only name and size, so verify content by hash (`scripts/s3-copy.cjs`).
- **The bundled store is Garage** (`infra/garage/`: a small image that adds a shell to the
  static binary, a config, an entrypoint, an idempotent `garage-init`). MinIO was dropped
  because `minio/minio` and `minio/mc` can no longer be pulled from Docker Hub or quay.io. Rules:
  (1) Garage accepts only its own key format (`GK` + 24 hex, 64-hex secret), so
  `scripts/compose.sh` **derives the key, secret and RPC secret from `AUTH_SECRET`** (explicit
  values must match the format); nothing for the operator to set, and every node of a cluster
  gets the same ones. A key from before an `AUTH_SECRET` change stays valid. (2) Its metadata
  is LMDB and **must not be on NFS/SMB**: the entrypoint refuses to start there; `GARAGE_META_DIR`
  moves it. This repo's `./data` IS on NFS on the dev host, so `.env` sets `GARAGE_META_DIR`
  to a local folder. (3) The app region for the bundled store is `garage`. (4) Compose
  interpolates inactive-profile services too, so any `${VAR:?}` in a profile service needs a value
  exported by `compose.sh` in the other mode (see `GARAGE_RPC_SECRET`). (5) Use
  `scripts/compose.sh --s3-env` to learn what the app uses; do not re-derive it elsewhere.
- **Cluster mode is a compose overlay, chosen by `scripts/compose.sh`.** `DEPLOY_MODE=cluster`
  (production stack only) adds `infra/docker-compose.cluster.yml` (publishes Garage's RPC
  port), `docker-compose.cluster-db.yml` when `DB_MODE=bundled` (one secure `cockroach` service,
  profile `cluster-db`, plus the CA mounted into api/monitor/web) and
  `docker-compose.cluster-s3-api.yml` when `CLUSTER_S3_API_PORT` is set. compose.sh validates
  (NODE_ID, NODE_ADDR, CLUSTER_PEERS, role/mode combinations) and prints what it resolved with
  `--cluster-env`: scripts use that, never re-parse `.env`. Only the shell environment's and
  `.env`'s values reach compose interpolation, so a new knob is read with `conf` in compose.sh
  and `export`ed there. `CLUSTER_PEERS` entries may be `host:dbport:rpcport` (several nodes on one
  host, as in tests).
- **Bundled cluster database is secure Cockroach.** The app signs in as user `lampstand` (password
  `derive_ns db/password` from `AUTH_SECRET`, created by `cluster.sh init-db`) over
  `sslmode=verify-full` against `data/certs/ca.crt`; each app talks to its own node's database. The
  CA key (`data/cluster-certs/ca.key`) never goes on a node (`install-certs` refuses a bundle that
  has it). The admin UI is not published. The cockroach healthcheck is unhealthy until `init-db`,
  by design, so a new node's first start is `cluster.sh start-data` (not `up`), then `init-db`,
  `garage-bootstrap`, `migrate`, `seed`, `up`. **`derive`/`derive_ns` strings never change** (they
  are live credentials).
- **Migrate and seed in a cluster use a one-off container** (`cluster.sh migrate|seed`, i.e.
  `run --no-deps api ...`): the app cannot start on an empty database, so `exec api` is not
  available on a first install.
- **Readiness must touch a range.** `/api/v1/readyz` reads a real table under a server-side
  `statement_timeout` (on CockroachDB `SELECT 1` is answered without any range, so a node that lost
  its quorum would pass it). `SettingsService.get` serves a stale cached value when a refresh is slow
  (one refresh in flight per key): the rate limiter reads a setting on every request, and without
  this a stalled database stalled the liveness endpoint too.
- **Garage's config is a template** (`infra/garage/garage.toml.tpl`, rendered by
  `garage-render.sh` from `GARAGE_RPC_PUBLIC_ADDR` / `GARAGE_REPLICATION_FACTOR`); run the CLI as
  `garage -c /tmp/garage.toml`. The copy count is fixed at creation (3 with 3+ nodes, else 2). The
  layout across nodes is formed by `cluster.sh garage-bootstrap`, never by `garage-init` (which in
  cluster mode only does key and bucket). Replacing a dead node is **one** layout change
  (`garage-join ... --replace <old id>`: assign the new node, remove the old, apply, then
  `skip-dead-nodes --version N`); doing it in two steps leaves versions the dead node can never
  acknowledge and writes fail with "Could not reach quorum". A restore replaces the database for all
  nodes, so `db-s3.sh restore` refuses while another node's app is up, and hands the restored tables
  to the `lampstand` user.
- **Cluster tests: `tests/cluster/`** (`sim.sh` builds N nodes on one host from copies of the repo,
  each with its own `.env`, `data/` and compose project; `cross-node.mjs`, `failover.sh`,
  `replace-node.sh`). **Never run the production stack from this checkout on the dev host**
  (`make prod-up`, `compose.sh --prod up`): it bind-mounts the same `./data` directories as the live
  dev stack. Use the simulator, or `compose.sh --prod config` to look.
- **A change must be visible on every node at once** (`cluster/read-your-writes.ts`). A per-process cache
  that a write must invalidate drops the other nodes' copies through `CACHE_ROOM` (see the cache rule
  above); the ordering guarantee is separate: in a cluster every mutating response first flushes the bus
  (`ClusterBus.flushNow`) and sets a 10 s `lampstand_rv` cookie, and a request carrying it makes its node run
  a poll first (`ClusterBus.syncSince`). Without that the smoke suite fails through a load balancer
  (password change then write: 403, settings, TOTP). The web relays the cookie in ONE place: `apiFetch` (and
  `streamToApi`, for the multipart upload proxies) sets it on the browser through `cookies()` after any API answer that carries
  it, so a route handler or server action using them needs nothing extra (until 2026-10-19 only `forwardToApi` did and about
  sixty other handlers dropped it). Proxy uploads with `streamToApi`, never a hand-rolled `fetch`: that also forwards the
  person's address and browser, which a raw fetch lost (uploads were audited as the web container, agent "node"). Cross-node
  test: "changes made through the web routes ... carry the consistency cookie". Cookie-less clients (API
  tokens) get "within about a second": write tests for them to allow for it.
- **The admin Cluster page** (`apps/api/src/cluster-admin/`, `/admin/cluster`) reads the same tables the
  coordination uses (`cluster_nodes`, `cluster_leases`) plus a database and object-store probe and, for the
  bundled Garage, its admin API (`GARAGE_ADMIN_URL`/`TOKEN`, set by `compose.sh`). What counts as a problem
  is the pure `findProblems` (unit-tested); a new background job appears there by registering with
  `ClusterJobs` (its name lists the job). The `cluster-watch` job notifies admins when a node stops
  checking in and when it returns (baseline in `job_state`, silenced by maintenance mode).
- **Cluster tests live in `tests/cluster/`**: `sim.sh` (shape C), `shape-d.sh up|test|down` (shape D:
  a throwaway database, a standalone Garage, two nodes, a Caddy load balancer; runs smoke and the browser
  suite through the balancer, which is what found the read-your-writes gap), `failover.sh`,
  `replace-node.sh`, `witness.sh`, `restore-node-death.py`, `node-watch.mjs`, `backup-restore.{sh,mjs}`,
  `compose-config.sh`. Address the balancer as `localhost` for browser tests (the clipboard API needs a
  secure context). Never `tee /dev/stderr` into a log (it truncates the file); never `pkill -f` a pattern
  that appears in your own command.
- **Raw `pool.query` returns timestamps as strings.** `drizzle()` replaces pg's
  timestamp parsers for the whole process. In raw SQL return epoch milliseconds
  (`extract(epoch FROM ts) * 1000`) instead of relying on `Date`. The
  integration test calls `drizzle(pool)` for the same reason.
- **Search changes** go through `SearchService.changed()` (content) or
  `syncUnifi`/`syncDns` (live kinds); see ## Search. Do not add a node-local
  update path for the index.
- **Database failover test**: `tests/db/yb-failover.sh` builds a three node YugabyteDB cluster, runs steady traffic
  through `createPool` with all three hosts in the URL and makes nodes hang, refuse and stop underneath it through
  `tests/db/tcp-fault-proxy.mjs` (a container frozen with `docker pause`, or reattached to its network, breaks
  YugabyteDB itself and tests nothing about the pool). `apps/api/test/db-multihost.integration.test.ts` runs with
  `TEST_DATABASE_URL`.
- **Real-database tests**: `test/db-stores.integration.test.ts` runs the stores'
  SQL against a real engine when `TEST_DATABASE_URL` points at a migrated
  scratch database (it empties the cluster tables). Run it on Cockroach and
  YugabyteDB when changing that SQL.
