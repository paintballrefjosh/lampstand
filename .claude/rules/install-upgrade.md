---
paths:
  - "install.sh"
  - ".env.example"
  - "scripts/{upgrade,upgrade-cluster,release}.sh"
  - "tests/{installer,upgrade}/**"
---

# Guided installer and upgrades

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

## Guided installer (`install.sh`)

`./install.sh` (repo root, bash 4+, no Node needed) is the supported way to install: it asks, writes
`.env` and runs the real steps (`scripts/compose.sh`, `scripts/cluster.sh`), so it never has its own
copy of a procedure. Operator docs: INSTALL.md "Guided installer". Rules for changing it:

- **A new bootstrap setting in `.env.example`, or a new install step, needs the installer updated** in the
  same change: a question (`ask_*`), `write_env`, and a case in `tests/installer/dry-run.sh`. Keep every
  question answerable from `--answers` (the keys are the `ANS[...]` names; `ENV_<NAME>` writes any `.env`
  key) so tests and unattended installs work; never read a prompt without going through `ask_*`.
- **Asking again offers the earlier answers as defaults** (`PREV`, filled by `load_prev` on "answer again" and by `forget` /
  the review-no loop; secrets keep the saved value on Enter). `PREV` is only ever a default: an answer from `--answers` or
  a resume is `ANS`, and nothing is asked. `CONFIRM` is never remembered (a "no" must not become the next default).
- **Read answers only through `read_line`** (used by every `ask_*`): on a terminal it uses readline (`read -e`), so
  Backspace/arrow keys edit the answer; a bare `read` stores the erase key as a literal `^H`. Saying no at the
  review re-asks everything that was asked at a prompt (`ASKED`); answers from `--answers` are kept.
  `tests/installer/pty-edit.py` types a typo and fixes it with both `^H` and DEL in a real pty.
- **The wizard's database test also checks the login may CREATE tables** (`test_one_host` line 3: schema `public` missing /
  no CREATE on it / no CREATE on the database), failing with the exact GRANT commands, because the migrations otherwise stop
  at their first statement ("permission denied for schema public") after a long build. `tests/installer/db-perms.sh`
  (PostgreSQL 16 container with a non-owner login; CockroachDB unchanged).
- **`sslmode` means something different in this app than in psql.** pg 8 treats `require`/`prefer`/`verify-ca` as
  `verify-full`; only `no-verify` skips the check. The wizard offers verify-full / no-verify / disable, its connection test
  translates the URL for psql so it behaves like the app (`test_url_for_psql`: a test that passes where the app fails is
  worse than none), and an untrusted certificate offers `no-verify` (never applied silently). An old saved `DB_SSL=require`
  becomes verify-full. `tests/installer/db-tls.sh` runs it against a PostgreSQL container with a self-signed certificate.
- **Values go into `.env` unquoted**, so `v_envsafe` rejects whitespace, quotes, backslashes, backticks, `#`
  and `$`; the database URL's user and password are percent-encoded (`urlenc`), because compose interpolates
  `$` in env files.
  Secrets never go on a command line (`docker run -e NAME`, not `-e NAME=value`) or into `.install.log`.
- **Steps are stages** (`run_stage name desc fn`, recorded in `.install-state`): idempotent, skipped on a
  re-run, and a stage that needs another machine uses `pause` (skipped by `NOWAIT=yes` in tests). A single
  server follows the cluster order, not `make up`: the API cannot start on an empty database, so it starts
  the database, runs migrate and seed in one-off containers (`run --rm --no-deps api`), then `up`.
- **Versions are checked, and a mismatch is offered a fix, never forced** (`offer_self_update`, `sync_to_commit`,
  `restart_installer`, `forget_stale_progress`): a newer upstream is offered as a fast-forward `git pull`; a `--join` whose
  commit differs from the package's is offered `git fetch` + fast-forward/checkout of THAT commit (not "latest": the first
  node's exact version); both refuse a checkout with uncommitted changes. After changing files the installer `exec`s
  itself again (`ORIG_ARGS`, `SELF`): never carry on running a script that was replaced under bash. A package records its
  commit, so packages are rebuilt on every first-node run and the code-dependent stages are dropped when
  `scripts/build-id.sh` changed since the state file's `buildid:` line. SSH installs set `JOIN_COMMIT_OK=yes` remotely
  because the files were copied and the build ids compared. `tests/installer/update.sh` uses real throwaway git repos.
- **Image builds are retried when Docker's image store is damaged** (`build_images`, `BUILD_STORE_ERROR`: "failed to
  prepare extraction snapshot ... parent snapshot ... does not exist", a containerd race with parallel builds or an
  interrupted build/prune): one image at a time, then an offered `docker builder prune -f` (build cache only; never
  images or volumes), and any other build error is shown untouched, never retried. `tests/installer/build.sh` uses a fake
  compose/docker with the real error text. A new build step must go through `build_images`, not a bare `compose build`.
- **Every connection pins `search_path=public`** (`createPool`: `options: "-c search_path=public"`, unless the URL sets
  `options` itself). Migrations create unqualified tables and six foreign keys (0026, 0027, 0044) name `"public"."..."`
  explicitly, so tables landing anywhere else break them with 42P01. PostgreSQL's default `"$user", public` does exactly
  that when a schema is named like the login (reproduced on YugabyteDB: login `lampstand_app` + schema `lampstand_app` = 43
  tables in the wrong schema, then `relation "public.users" does not exist`). Never add schema-specific code paths.
- **A migration that fails halfway must be re-runnable** (YugabyteDB applies statements one by one, not in one transaction):
  `migrateStepwise` writes a marker (`drizzle.__lampstand_migration_progress`) before a migration's first statement and removes
  it once the migration is journaled; a run that finds the marker is RESUMING and skips statements whose effect is already
  there (`ALREADY_DONE` SQLSTATEs), a run without one gets no such leniency, so a genuine error is never hidden. All the DDL
  of a YugabyteDB migration runs on ONE connection (a backend always sees its own changes, wherever in the host list it
  landed). `[migrate] failed: <message>` is printed FIRST and the failing statement named. The installer's one-off steps
  (`oneoff_api`) retry only on "database not reachable" output (`TRANSIENT_DB_ERROR`): any other error stops at once and the
  FIRST failure is shown, because a retry on a half-applied migration buries the real cause under a second, confusing error.
  `tests/installer/oneoff.sh` (fake compose); the resume was tested by killing a real migration on a 3-node YugabyteDB.
- **Missing requirements are offered, never silently installed** (`ensure_requirements`, `FACTS_SCRIPT`, `priv_exec`):
  one facts script (package manager, root/sudo state, what is missing) runs locally or over ssh; make/git/tar go in
  through the package manager after a yes/no (`AUTO_INSTALL_DEPS`), Docker only through Docker's own script after a
  default-no question (`AUTO_INSTALL_DOCKER`), the docker group after a yes (`AUTO_DOCKER_GROUP`). Root runs it, passwordless
  sudo uses `sudo -n`, a sudo password needs a terminal (`ssh -t` remotely, so the prompt reaches the person) and otherwise
  fails with the reason. A group change needs a new login session: locally the installer stops and says so, remotely it
  closes the ssh master and reconnects. Answers are loaded BEFORE the preflight (it asks). `tests/installer/deps.sh`
  runs it in clean Ubuntu/Debian/Fedora/Alpine containers, as a sudo user and over ssh to an sshd container; the Docker
  script itself is not run in tests.
- **The other nodes can be installed over SSH from the first** (`REMOTE_MODE=ssh`, the `remote_*`/`rsh` helpers and the
  `remote-prepare`/`remote-start`/`remote-finish` stages): the first node copies its checkout (WITH `.git`, so
  `scripts/build-id.sh` gives every node the same build id; it is compared before anything is built), the node's package
  (under the git-ignored `data/`, a stray untracked file would change the build id) and an answers file, then runs
  `./install.sh --join` over ssh in two phases (`INSTALL_STOP_AFTER=node-id`, or `build` with an external database and
  store, then the rest), all remote nodes in parallel. ssh connection sharing (`ControlMaster`) carries it: the one
  interactive moment (a password or host key prompt) is `remote_connect`; everything else is `BatchMode`. **The installer
  never reads or stores a password.** Every remote stage starts with `remote_connect_all`: a run that RESUMES skips
  `remote-prepare`, so it has no shared connection, and the prompt-free `rsh` would fail with "Permission denied" on a
  machine that needs a password; `ssh -O check` finds missing connections and `remote_connect` reopens them (asking again;
  with no terminal it says to use a key). A remote `--join` has no terminal, so anything it would ask must be in its answers
  (`NODE_<n>_ANS_<KEY>`); a network file system for Garage's metadata is refused with a clear message instead.
- **A cluster's other nodes get a package** (`data/cluster-packages/`, mode 600: that node's `.env` with the
  secrets, its certificates, the commit) and run `--join`. The package never contains `ca.key`. The join
  refuses a different commit unless told otherwise: every node must run the same build.
- **Tests**: `tests/installer/dry-run.sh` (fast, no docker: shapes A-D, validation, the real prompts through
  a pipe) and `tests/installer/deps.sh` (requirements), `tests/installer/update.sh` (versions), `tests/installer/ssh-password.sh` (a password-only machine, resumed), `tests/installer/db-tls.sh` (a self-signed database), `tests/installer/oneoff.sh` (migrate/seed retries), `tests/installer/build.sh` (a damaged image store), `tests/installer/db-perms.sh` (a login that cannot create tables) and `tests/installer/e2e.sh single|external|external-cluster|cluster|cluster-ssh|down` (real installs in `~/lampstand-wiz`, own ports,
  project names and images, the live dev stack untouched; `single` ends with the smoke suite, `cluster` with
  `tests/cluster/cross-node.mjs` against all three nodes).
  Run `shellcheck -S warning install.sh` (`koalaman/shellcheck` in docker).

## Upgrading a deployment (`scripts/upgrade.sh`)

`scripts/upgrade.sh` (operator docs: INSTALL.md "Upgrading"; test: `tests/upgrade/upgrade.sh`, a fake compose in throwaway
git repos) upgrades the node it runs on. The order is the contract: look (fetch, plan, refuse a dirty tree) -> backup
(single node, bundled database) -> build the new images while the old containers keep serving -> migrate with the NEW
image in a one-off container -> swap only `api web monitor` (`up -d --no-build --no-deps`; everything, plus a proxy restart,
only when `infra/` changed; in a cluster `cluster.sh drain` before and `undrain` after the node is healthy) -> verify
inside the containers (`/readyz`, web answering, `BUILD_ID` of api and web equals `scripts/build-id.sh`) -> otherwise
roll back by itself. A failed build or migration puts the code back before anything was swapped. Rules:
- **Do not skip rebuilding a service because its sources did not change.** `BUILD_ID` is baked into every image and every
  node of a cluster must run the same build; Docker's layer cache already makes the unchanged parts cheap.
- **Build once, pull everywhere (`IMAGE_REGISTRY`, 2026-10-24)**: with `IMAGE_REGISTRY=<prefix>` (`.env` or environment; the prefix
  `scripts/release.sh --push` publishes to, images `<prefix>-api|web|monitor:<build id>`) `upgrade.sh` PULLS the target's three images
  instead of building (`pull_images`/`get_images`), and `upgrade-cluster.sh` looks them up first (`docker manifest inspect`) and stops
  before touching a node if they are not all there (`--publish` builds and pushes the target from this checkout, which must be on it
  and clean; `--build` = every node builds). Rules: (1) **the tag is the build id, which is the commit, so a dirty or untracked tree can
  neither push (`release.sh` refuses) nor pull** (`pull_images` refuses ids with a `-`). (2) A tag is only a name: every pulled image's
  baked-in `BUILD_ID` must equal the id asked for, else it is not used. (3) **All or nothing**: nothing is tagged until all three are
  here and verified; then each is `docker tag`ged with the name compose already uses (`image_of`, from `compose config`:
  `lampstand-prod-api` ...), so `up --no-build`, a later plain `compose up` and `--rollback` find it where a local build would have left it
  and `.env` is never edited. (4) A failed pull FALLS BACK to building on the node with a warning (`--pull` makes it an error); the
  automatic rollback and `--rollback` go through the same `get_images`, pulling the older id when it is still published. (5)
  `IMAGE_REGISTRY` together with `API_IMAGE`/`WEB_IMAGE`/`MONITOR_IMAGE` is refused (two ways to choose images). (6) Registry credentials
  are `docker login` on each node, never stored by these scripts. Tests: `tests/upgrade/upgrade.sh` (a fake registry in the fake
  `docker`) and `tests/upgrade/upgrade-cluster.sh` (stub `release.sh`, fake `manifest inspect`).
- **Migrations are never undone by a rollback**: that is only safe because they are additive (expand/contract), which is the
  existing migration rule; a destructive migration breaks `--rollback` and the automatic one.
- **`scripts/upgrade-cluster.sh` upgrades all nodes** by running `upgrade.sh` on each in turn (local, or over key-only SSH
  as a detached job whose log it follows, so a dropped session does not stop an upgrade halfway). Node list:
  `data/upgrade/nodes` (`local` | `[user@]host[:port] [folder]`), else `CLUSTER_PEERS`. One commit for every node
  (resolved once, `--to <sha>`), a node must answer `/healthz` 200 before the next starts, `NODE_ROLE=data` nodes are
  skipped, and it STOPS at the first failure (that node rolled itself back; later nodes untouched). It runs from a
  copy of itself because upgrading the local node replaces its own file. Test: `tests/upgrade/upgrade-cluster.sh`
  (fake ssh/curl and a stub `upgrade.sh`; the real SSH path was also run against an sshd container).
- **Each node upgrades with the TARGET's `upgrade.sh`, not the copy on its disk** (`run_node`): the cluster script `git show <sha>:scripts/upgrade.sh`
  into `data/upgrade/upgrade.next.sh` (git-ignored, so the build id is unchanged; the node fetches the commit first) and runs it with
  `UPGRADE_ROOT` pointing at the checkout. Without this a bug fix in `upgrade.sh` only helps the upgrade AFTER the one that delivers it (a plan of
  more than 15 commits exited 141 on `git log | head` under pipefail, on nodes that already had the fixed script pushed). A node that cannot fetch
  the target, and `--rollback` (no target), use their own copy. Never pipe `git log` into `head` in these scripts; use `git log -n`.
- **"On the target commit" is not "running the target".** `git pull` moves the checkout and builds nothing, so the node you run the cluster script from
  looked current while its containers were old (the dashboard showed it on a different build from the others). `upgrade.sh` compares the running api/web
  `BUILD_ID` with `scripts/build-id.sh` before it says "nothing to upgrade" (and keeps the earlier `PREV_COMMIT` when it rebuilds the same commit);
  `upgrade.sh --status` prints `down|current|stale <build>` and the cluster script uses it for nodes whose checkout is already on the target.
- **Disk use is tidied by default after a verified upgrade** (`upgrade.sh`, step 5): `docker image prune -f` and `docker builder prune -f --keep-storage
  ${UPGRADE_CACHE_KEEP:-10GB}`; `--no-prune` skips. Until 2026-10-23 only `scripts/rebuild.sh` (the dev host) pruned, and `upgrade.sh --prune` was opt-in and
  skipped the build cache, so prod nodes grew 25-32 GB of unused cache each. Never use `image prune -a` or `system prune` here: they delete images of stopped or
  profile services (Garage, Cockroach) that the registries may no longer serve (MinIO was withdrawn).
- **Never swap the database or object store from here** (a cluster node's database restarting is not an upgrade step).
- It cannot run on the dev host's prod stack for the same reason nothing else can (shared `./data`): test with the fake
  harness, and `--dev` on the dev stack.
