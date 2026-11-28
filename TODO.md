# To do

## Upgrade NestJS to version 12

Added 2026-11-28; planned for the week of 2026-11-30.

Move every `@nestjs/*` package together. Do **not** merge Dependabot PR #30: it bumps only
`@nestjs/platform-socket.io`, and the API then fails to start (`Cannot find module '@nestjs/common/internal'`)
although every CI check passes.

### Steps

- [ ] Bump `common`, `core`, `platform-fastify`, `platform-socket.io`, `websockets`, `testing`, `cli` and
      `schematics` in `apps/api/package.json`, each to the newest version published at least two weeks earlier
- [ ] Raise the root `engines.node` (now `>=20.11.0`): version 12 needs 20.19+ or 22.12+
- [ ] Decide about `@nestjs/schematics` 12 wanting TypeScript 6 (peer warning only in the trial)
- [ ] Read the migration guide: https://docs.nestjs.com/migration-guide
- [ ] Build the Docker images, rebuild the dev stack, run the smoke and browser suites
- [ ] Check live updates (WebSocket) for a signed-in user
- [ ] Try YugabyteDB, or say that it was not tried
- [ ] Group `@nestjs/*` in `.github/dependabot.yml` so future majors arrive as one pull request
- [ ] Close PR #30

### Trial on 2026-11-28

On a copy of `master` at 29e4430: the six libraries at 12.5.0, `cli` and `schematics` at 12.0.13, no code changes.

- Passed: typecheck, build, API unit tests (1249), CockroachDB integration tests (296, 9 skipped)
- The API started, `/api/v1/readyz` answered ok, 542 routes mapped (same as version 11)
- A WebSocket connection without a session was refused by our own sign-in check
- New peer warning: `@nestjs/schematics` expects `typescript >= 6`
- Not tried: Docker image, smoke and browser suites, signed-in realtime, YugabyteDB

## Infra host detail page: movable, resizable cards

Added 2026-11-28. Page: `apps/web/src/app/monitoring/infra/[id]/infra-detail-client.tsx`. Today the fixed
layout leaves awkward gaps.

- [ ] Let each person move cards and change their sizes; close the gaps automatically
- [ ] Hide cards (proposed, not yet confirmed): a list to bring hidden cards back and a "Reset layout";
      hiding never changes what is collected or alerted on
- [ ] Decide where the layout is kept. Proposed: per person, saved in the database, one layout for all hosts
      (a host without a card's data leaves it out)
- [ ] Single column on phones; moving, resizing and hiding must also work from the keyboard
- Starting point: the home tiles already use `react-grid-layout` 1.5.4 (`apps/web/src/app/dashboard-tiles/`)

## Temperature unit as a site setting

Added 2026-11-28. Temperatures show in Celsius only, which is not useful in North America.

- [ ] Admin > Settings: site-wide Celsius / Fahrenheit switch (proposed default: Celsius, so upgrades change nothing)
- [ ] Keep storing Celsius and convert only where shown
- [ ] Apply it everywhere a temperature appears: the host page's value and chart, the signage device page and
      its "Running hot" warning; search for others

## Infra host detail page: real memory and disk figures

Added 2026-11-28. A percentage alone is hard to judge, especially for memory.

- [ ] Show used and total next to the percentage in the Memory and Disk headers (text is enough)
- [ ] Show the same figures in the graphs' hover popups
- [ ] Disk is the busiest filesystem: name the mount the figures belong to
- [ ] Decided: going forward, bytes (used and total) are what is read and stored, and percentages are derived
      from them
- [ ] Linux samples already hold `memory.usedBytes` / `totalBytes` and per-filesystem `usedBytes` / `sizeBytes`;
      check that the Windows, macOS, Docker and Proxmox collectors provide bytes too
- [ ] Add bytes to the rollups (longer graph ranges), which keep only percentages today. Older data stays
      percentage only, so graphs and popups must handle that

## Monitor mdadm software RAID in more detail

Added 2026-11-28; one real server uses mdadm. A built-in template already exists, "Linux software RAID (mdadm)"
(`packages/shared/src/service-monitoring/builtins.ts`): it reads `/proc/mdstat` and shows each array's level,
disks working, disk map and rebuild progress, and alerts when working disks are fewer than the total.

Gaps. The first two were seen by running the template's pattern (in Python) over a made-up `/proc/mdstat`:

- [ ] An **inactive** array is not read at all, so it drops off the list without an alert
- [ ] RAID 0 (and linear) arrays are not read at all
- [ ] A disk marked failed `(F)` while the array still counts as complete raises nothing (a spare took over)
- [ ] Alert when an array that was there before is gone
- [ ] Without root, show each member disk from `/proc/mdstat` (name, spare or failed), rebuild speed and time left
- [ ] **Wanted:** show the detail from `sudo mdadm --detail /dev/mdX` for every array: state, array size, active,
      working, failed and spare disk counts, rebuild status, last update time, and the table of member disks
      with each one's state
- [ ] It needs root, and templates can only use `sudo -n`: the host login needs passwordless sudo for it (document
      the narrowest sudoers rule that works). Without that, keep showing the `/proc/mdstat` figures and say what
      is missing
- [ ] Consider `mismatch_cnt`, and find where the last consistency check time can be read (`--detail` does not
      report it)
- [ ] Consider disk health (SMART) as its own template: needs `smartmontools` and root
- [x] Real `mdadm --detail` output of a healthy 5-disk RAID 5 saved (host name and UUID replaced):
      `apps/api/test/fixtures/service-monitoring/mdadm-detail-raid5-healthy.txt`
- [x] Real `/proc/mdstat` of the same array saved: `mdstat-raid5-healthy.txt` (same folder). Members are listed
      out of order, and the number in brackets matches `Number` in `--detail`, not `RaidDevice`
- [ ] Still needed for tests: degraded, rebuilding, spare and failed examples (make those on a throwaway array,
      never on the real server). `State` can read `active` or `clean`
- [ ] Device names like `/dev/sdd` can change between boots: consider showing each disk's serial number, so the
      right physical drive is replaced
- [ ] Changing a built-in template's commands: bump `BUILTIN_TEMPLATE_VERSION`, and check what happens to
      services already added (SSH commands must be confirmed)

## Search the templates in "Add a service to monitor"

Added 2026-11-28. Finding a template in the drop-down is hard. The popup is in
`apps/web/src/app/monitoring/infra/services/services-ui.tsx`.

- [ ] Add a search box that narrows the templates as you type, matching name and description (so "raid"
      finds mdadm); likely a searchable list in place of the plain drop-down
- [ ] Keep custom templates marked, and keep the "What runs on this host?" suggestions
- [ ] Works from the keyboard with a labelled field (see the accessibility rules); update the browser test
      `service-monitoring.spec.ts`
