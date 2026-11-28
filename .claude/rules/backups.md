---
paths:
  - "apps/api/src/backup/**"
  - "apps/api/src/db/schema/**"
  - "apps/api/migrations/**"
  - "apps/api/src/scripts/rehearse-restore.ts"
  - "apps/web/src/app/admin/backups/**"
  - "packages/shared/src/backup*.ts"
  - "packages/shared/src/schemas/backup.ts"
  - "apps/api/test/{backup,unreadable-secret}*"
  - "tests/smoke/backups.mjs"
  - "tests/e2e/tests/backups*"
  - "tests/cluster/{backup-restore,verify-restore}*"
---

# Backups and restores

Binding rules for this area, as binding as [CLAUDE.md](../../CLAUDE.md). Keep this current, and keep `paths` above covering the area's files.
A reference such as "see ## Search" means the section of that name in CLAUDE.md or in the rules file its index lists.

## Backups and restores (admin > Backups)

Admin > Backups (`apps/api/src/backup/`, pages in `apps/web/src/app/admin/backups/`, `site:admin`,
`@SessionOnly`) makes logical backups of the app's own data, schedules them, and restores them with a
comparison report. Operator docs: INSTALL.md "Backups and restores in the app". Rules for changing it:

- **Every table needs a decision in `backup/table-registry.ts`** (`data` = saved and restored, `skip` =
  neither). A unit test (`backup-registry.test.ts`) fails when a table is added without one, when a
  `data` table has a foreign key to a `skip` table (a restore could break it), or when a registry entry
  names a column that is gone. `volatile` columns (rewritten by pollers) are ignored by the comparison
  and left alone by a restore; `sensitive` ones are never shown; `sequences` are moved past restored
  values (`tickets_number_seq`). Never put the audit log, runtime state or the `backup*` tables in a backup.
- **The archive format is an order contract** (`archive.ts`): manifest, tables (parents first, every
  table at least one part), `files.json`, files, `summary.json`. Readers stop at the first file when they
  only need rows. Change the format only with a new `ARCHIVE_VERSION` and a reader for the old one.
- **A restore is a sync inside one transaction** (`backup-restore.ts`): `computeDiff` (stream the
  archive against the live tables, fingerprint rows) produces both the report and the plan; `applyRestore`
  follows the plan (delete children first, upsert parents first, self-referencing tables ordered, a
  cycle filled in afterwards). Any failure rolls everything back. Rows are written with typed casts from
  the Drizzle column types (`row-codec.ts`): timestamps and bigints travel as text, `jsonb` as JSON, and
  the session time zone is UTC for every read, or fingerprints would differ.
- **A restore can be limited to sections** (`restoreSections()` in the registry; the section is the table's `group`).
  A table whose group is not in `SECTION_ORDER` could never be restored on its own (a unit test fails). `computeDiff` takes
  a `scope` (tables + whether files) and only plans those tables; `backup-scope.ts` then reconciles the plan with foreign keys
  BEFORE the report and the apply (the report is exactly what happens): rows whose parent outside the scope no longer exists
  are SKIPPED (and so is what depends on them, also through self references) when the link is required; an optional link (a nullable column such as a creator or assignee) is written empty instead (`plan.nullify`, reported as "cleared", as ON DELETE SET NULL would); a REQUIRED owner/author of notes, tickets, ticket comments and wiki pages (`REASSIGNABLE_TO_UNKNOWN`) is written as the "Unknown user" placeholder (`UNKNOWN_USER` in `backup-scope.ts`, a disabled, soft-deleted user created by the restore only when needed, `plan.reassign`; never given personal data or assignments, which are skipped); and removals still referenced by backed-up
  tables outside the scope are KEPT (propagating to the parents of kept rows). Files (restore and stray cleanup) happen only
  when the Files section is in scope (`filesInScope`). All sections chosen = `scope: null` = the ordinary full rollback, same
  code path. It follows only foreign keys that reference the parent's whole primary key (a unit test asserts every FK does).
  The UI locks Restore until the report was made for the current selection. Integration test:
  `backup-scope.integration.test.ts` (run on CockroachDB and YugabyteDB, **one integration file at a time**: they empty the
  same tables, so running two in parallel makes both fail).
- **Sections follow the app's menus, not the table layout**: Monitoring holds everything under the Monitoring menu (services,
  infrastructure, UPS, Cisco, IPAM, UniFi acks); Printers is its own. A user looking for "the Cisco switches" ticks Monitoring.
- **A restore writes a NEW row without its volatile columns** (`insertColumns` in `backup-restore.ts`: the database default
  applies, e.g. status `unknown`, no last reading) when the column has a default or is nullable: a poller's last reading from the
  backup is stale the moment it is restored, and a host that cannot be polled must not look alive on it.
- **Credentials saved under another `AUTH_SECRET` fail loudly**: read them with `decryptStoredSecret(enc, what)` (throws
  `UnreadableSecretError`, whose message says to enter it again), never bare `decryptSecret`, and show the error on the device
  (`infra_targets.last_error`, `cisco_switches.last_error` via `markUnreachable`). Rows are still restored; the report says how many
  hosts/switches need their password again.
- **Anything that writes in the background must honour the restore gate**: a restore holds the
  `mutex:restore` lease (`RestoreGate`, `restoreInProgress` in `@lampstand/shared/db`). The API refuses
  non-GET requests (`RestoreWriteGuard`), `ClusterJobs` skips runs and the monitor worker pauses. A new
  poller or worker outside those must check it too. The gate opens, and its one-second cache is waited
  out, before the operation reports success.
- **One operation at a time, cluster-wide** (`mutex:backup`), with progress in `backup_operations`; a
  running row that stops updating belongs to a dead node and is failed by the scheduler job. Steps after
  the restore's commit are best effort (warnings), never a failure of a committed restore.
- **Offsite copies** (`backup/offsite.service.ts`, `backup-offsite.ts` in shared, settings category `backup`, migration 0063):
  the archive is copied byte for byte to a SECOND S3 bucket (`backup.offsite.*` settings; the secret key is a `secret`
  setting; the switch has a `TOGGLE_PREREQUISITES` entry; a bucket equal to the app's own is refused). It goes through
  the same `ObjectStore` interface (`S3ObjectStore` takes its client and bucket; `makeS3Client`), so tests use
  `MemoryObjectStore`. Rules: (1) the `backup-offsite` cluster job (5 min) only picks up READY, `kind = scheduled`
  backups whose schedule has `offsite` on, within the newest `keep`, whose `offsite_dest` is not the current destination
  (a changed bucket re-copies); a manual or safety backup is copied only by the per-backup button. (2) Every copy runs as
  an `offsite` operation under the ordinary operation lease (`BackupService.beginOperation`), so it excludes restores and
  deletes of that backup; never copy outside it. (3) A copy is KEPT only after the size and the recorded SHA-256 match;
  failures set `offsite_error`, retry after `OFFSITE_RETRY_MINUTES`, and notify admins once until something succeeds.
  (4) Retention at the destination deletes only keys that `isOffsiteArchiveKey` accepts (our name pattern in our folder),
  never other files; deletes that are refused are warnings, not failures; pruned rows keep `offsite_at` (copied once) but
  lose `offsite_key`, so they are not queued again. (5) `fetch` brings a copy back through `importUpload` (an uploaded
  backup, checked like any upload) and only for keys that match the pattern. The copy is NOT re-encrypted: it holds
  everything a download holds. Tests: `backup-offsite.test.ts` (pure), `backup-offsite.integration.test.ts` (run on
  CockroachDB and YugabyteDB), smoke "offsite" tests, the Offsite tab in `backups.spec.ts`; the real round trip was run
  against a second Garage bucket.
- **Stored backups are re-read and checked** (`backup/verify.service.ts`, `backup-verify.ts`, migration 0069
  `backups.verified_at/verify_error/verify_tried_at`, rules in `packages/shared/src/backup-verify.ts`, unit-tested). Job
  `backup-verify` (10 min) checks the newest `VERIFY_RECENT` ready backups once and the newest again every
  `VERIFY_RECHECK_DAYS`; a failed one retries after `VERIFY_RETRY_MINUTES`. It runs as a `verify` operation under the ordinary
  operation lease (so it excludes restores and deletes of that file), reads only, and judges: size and SHA-256 recorded at
  write time (hash the whole stored file: drain the stream after the tar ends), `inspectArchive` (counts, file checksums),
  and `ContentChecker` (keys present and unique, required columns filled, every foreign key's parent in the archive; a backup
  is one serializable snapshot so a dangling link means a wrong file). Failure: one `backup.failed` notice, the Security
  overview (`judgeVerification`: newest failing = critical). **This proves a file is whole, not that it restores**: the
  restore rehearsal does (`tests/cluster/verify-restore.sh` / `make verify-restore`: restores a real backup of the dev
  stack into the throwaway cluster, then compares EVERY node with the file via `dist/scripts/rehearse-restore.js diff`,
  the app's own `computeDiff`; it cannot rely on signing in afterwards because a restore of a foreign backup replaces the
  asking account). Integration test: the "stored backup of real data" case in `backup.integration.test.ts`.
- **A backup file is untrusted input** (an admin may upload or restore a file from anywhere). Reviewed 2026-10-19; nothing is extracted to a
  filesystem (rows go to the database through typed casts and identifiers taken from the LIVE schema, never from the file; files go to the object
  store), so the risks were a hostile file turning into a denial of service or into writes to the wrong key. Rules: (1) **every file key from an
  archive must pass `isSafeFileKey`** (`archive.ts`: under `attachments/`, no `.`/`..` segment, no control characters or backslash, 1024 at most) in the
  tar entry name, `files.json` and the summary, because a restore puts each file at the key the archive names: before this a file entry
  `files/backups/<stored backup>` overwrote a stored backup, the safety copy taken seconds earlier included. (2) The tar reader refuses a header
  whose size is not a safe non-negative integer and an extended (PAX) header over `MAX_PAX_BYTES` (1 MiB): it used to hold whatever size was
  announced and re-copy the buffer for every chunk, so a 64 KB gzip announcing 64 MiB ran for minutes at full CPU while holding the backup lease
  (cost grows with the square of the size). (3) `gunzipped()` stops a stream that expands more than 250 times once past 2 GiB of output (gzip reaches
  1000:1; a check or restore would hash and parse terabytes for hours under the lease). (4) The manifest, `files.json` and the summary are shape-checked
  and bad JSON or a bad table folder name gives a plain "The backup is damaged" message, not a parser error. Accepted: a table part or JSON entry may
  still be read whole up to `MAX_JSON_ENTRY` (256 MiB; the writer cuts parts at about 4 MiB, so only a hostile file comes near it). Tests:
  `backup-archive-hardening.test.ts`, smoke "an upload that names a file outside the uploads folder ...", "an oversized extended header ...".
- **Failed backup rows do not pile up** (2026-10-24; 81 `junk`/`notes` rows had built up from the smoke and e2e "bad file" tests). An upload refused at the
  door (not gzip, empty, too big) deletes its row: the caller gets the reason in the 400 and never sees an id, so a row could not be opened or tidied. A
  file that fails the check AFTER the 202 stays as a failed row, because the UI shows it. The scheduler tick (`pruneFailed`) removes every failed backup, of any
  kind or schedule, after `FAILED_BACKUP_KEEP_DAYS` (7), taking the operation lease only when there is something to remove. Test:
  `backup-failed-rows.integration.test.ts` (one integration file at a time), smoke "a damaged or foreign upload is rejected".
- **Object store**: use `removeObject` per key. minio's `removeObjects` is refused by Garage ("Invalid
  delete XML query"), and swallowing delete errors had leaked archives; `removeBackup` keeps the row when
  the delete fails and `sweepOrphans` cleans up archives with no row.
- **Downloads are two steps** (an audited POST makes an HMAC-signed link, then a GET): the token is a
  query parameter because Fastify drops path parameters longer than 100 characters (404). Uploads use
  `req.file({ limits })` to lift the global 10 MiB multipart cap.
- **Never restore in the smoke or e2e suites against the live stack** (it rewinds data the rest of the
  suite uses). Restores are tested by `apps/api/test/backup.integration.test.ts` (run it on CockroachDB
  and YugabyteDB with `TEST_DATABASE_URL`), `backup.scale.test.ts` (`BACKUP_SCALE=1`) and
  `tests/cluster/backup-restore.sh` on the throwaway cluster.
