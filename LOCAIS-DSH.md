# DSH — Post-Cleanup Locations

Inventory of this machine on 2026-10-13, after the owner applied the migration cut and removed legacy runtimes. `~` means `/home/alex`; `repo` means `/home/alex/git/my/dsh-customs`.

## Summary

**One active executable installation:** `~/.local/share/dsh-cli`. Profiles resolve **404 links** into this runtime; one regular local package remains, `dsh-llm-llamacpp`, preserved. Web and reopened TUIs use the canonical runtime. The five preserved static SDK/Pi fingerprints were verified without importing providers.

Not everything containing “DSH” in its name was deleted: configs, sessions, sources, winning build proofs, and the still-required compiler are not trash. Auxiliary caches and backups are itemized below — they were not hidden under a claim of total cleanup.

## Where things are

Rounded sizes from `du`, without following profile links to avoid double-counting the runtime. Private data was inventoried by category/existence, not by content.

| Location | Purpose | Observed Size | Logical State / Owner |
|---|---|---:|---|
| `~/.local/share/dsh-cli/` | CLI, Cordis, SDK, Pi, peers, and launcher runtime | 550 MiB | **Canonical runtime**; managed by dsh-customs |
| `~/.local/share/dsh-cli/artifacts/` | Two Pi artifact sets used by installation/manifests | 1.7 MiB, already inside runtime | Preserve; not a separate installation |
| `repo/frontend/dsh-tui/` | TUI fork source | — | Canonical source, separate checkout |
| `repo/plugins/dsh-antigravity/` | Antigravity fork source | — | Canonical source, separate checkout |
| `repo/sources/pi-ai/` | Recovered and verified Pi source | 30 MiB | **Snapshot without Git HEAD**, not an updated clone |
| `repo/plugins/` | Custom sources and bundles, including self-heal/browser | 50 MiB | Source/artifacts; do not clean by name |
| `repo/tools/` | Recipes, promoters, validators, and maintenance | — | Canonical operational source |
| `repo/node_modules/` | Workshop tool dependencies | 15 MiB | Reproducible auxiliary, kept |
| `~/.dsh/profiles/` | Profiles, configuration, and module links | shared links: ~1.6 MiB before removing legacy dirs | **`.dsh` configuration**; ownership policy: dotfiles. 403 shared links + 1 TUI adapter point to canonical runtime |
| `~/.dsh/{sessions,storages,attachments,logs,cache,...}` | Operational data, history, and private files | not measured by category in this audit | **Preserved**, neither moved nor rewritten |
| `~/.config/fish/functions/dsh.fish` | `dsh` command | small | Points to `$XDG_DATA_HOME/dsh-cli`, fallback `~/.local/share/dsh-cli`; regular file |
| `~/.config/systemd/user/dsh-web.service` | Web service | small | Runs canonical `bin.js`; active |
| `~/.cache/dsh-browser/playwright-1.64.0/` | Browsers used by current plugin | 681 MiB | **Required**, explicitly configured path |
| `~/.cache/dsh-browser/runtime/` | Browser temp/host files | 14 MiB | Operational auxiliary; private content uninspected |
| `~/.cache/dsh-browser/task05-stable/` | Test browsers | 681 MiB | **Still referenced** in `plugins/browser/browser.test.mjs`; kept |
| `~/.cache/dsh-browser/task05-spike/` | Earlier browser experiment | 674 MiB | Candidate for additional cleanup; absence of usage/references not certified |
| `~/.local/share/dsh-customs-backups/` | Previous backups and preservation area | 5.0 GiB | Kept; no new trash backup created in this cleanup |
| `/tmp/alex-dsh-trash-*/` | Discarded items from this session | see list below | Temporary disposal; may clear on reboot |

The policy is that dotfiles owns the `.dsh` configuration, while dsh-customs owns sources, builds, artifacts, and recipes. **It was not verified whether current fish/systemd files are already tracked in dotfiles Git**: local files were inspected, no Git migration was faked.

There is no DSH installation in `~/.local/state`, no `dsh*` launcher in `~/.local/bin`, no other `dsh*` repo in `~/git/my`, and no other npx root with a direct DSH dependency in discovered public manifests. Of the 22 existing npx roots, 19 had direct manifests and 3 were empty; others belong to distinct tools and were not deleted. This is not an unrestricted scan of every file under home.

## What was removed now

Each removal used `trash`, with verified copy to `/tmp` and removal of origin. The legacy paths below **no longer exist**.

| Removed Origin | Temporary Destination | Regular Bytes Copied |
|---|---|---:|
| `~/.npm/_npx/1e7f6d9597241db0` | `/tmp/alex-dsh-trash-1e7f6d9597241db0-znAnfK/item` | 446,890,778 |
| `repo/.dumps/pi-ai-fork/runtime-cc0c4b95b7145f89` | `/tmp/alex-dsh-trash-runtime-cc0c4b95b7145f89-cSEFI0/item` | 61,685,888 |
| `repo/.dumps/pi-ai-fork/runtime-030fcab313c8f8df` | `/tmp/alex-dsh-trash-runtime-030fcab313c8f8df-Wjq0Yp/item` | 61,308,940 |
| `~/.local/share/dsh-tui-cli` | `/tmp/alex-dsh-trash-dsh-tui-cli-acxnhV/item` | 0; empty directory |
| `repo/.dumps/pi-ai-fork/manager-check.mjs` | `/tmp/alex-dsh-trash-manager-check.mjs-DW8Qts/item` | 1,045; retired synthetic probe |

Regular total of this removal: **569,886,651 bytes (~543.5 MiB)**. Prior rounded disk usage: npx 509 MiB + scratch 95 MiB + scratch 95 MiB, roughly **699 MiB**. File bytes and allocated blocks are not the same measurement. Discarded items still reside in `/tmp` (tmpfs); this is not persistent backup.

The two historical helpers `session-clone/{clone,discover}.mjs` now import from canonical. **They were not executed**: no session was cloned, read, or modified by them during the cleanup.

### Prior cleanup already performed

- 404 links were retargeted and 205 unresolvable links were removed in the cut applied by the owner; receipt `/tmp/dsh-finish-7RjVD8/receipt.jsonl`.
- 597 disposable fixture directories were moved to `/tmp/alex-dsh-trash-obsolete-test-fixtures-20261013-9GeRg9/` and `/tmp/alex-dsh-trash-obsolete-test-fixtures-20261013-more-LiwJkg/`.
- `workshop-build-20261012` and `workshop-build2-20261012` were moved out of the workspace into persistent quarantine in the earlier step: ~3.9 GB removed from workspace, **not freed disk bytes in that step**.

## What remains in `.dumps` and why

The workshop still contains development artifacts. It is not another live installation, but neither is it an entirely disposable directory:

| Preserved Location | Observed Size | Reason / Boundary |
|---|---:|---|
| `.dumps/workshop-build3-20261012/` | 2.8 GiB | Compiler/dependency donor and workshop baseline; do not delete wholesale |
| `.dumps/pi-ai-fork/ws-review/` | 445 MiB | Original snapshot, dependencies, and provenance; old `.git` is unhealthy |
| `.dumps/pi-ai-fork/206545bfd51e-34a0a629dac6/` | 17 MiB | Winning Pi artifact / tarball / provenance |
| `.dumps/codex-failure-categories-20261013-candidate{1,2,3}/` | ~16 MiB each | Winning candidate3; earlier ones are part of chain/evidence, not marked for discard in this round |
| `.dumps/self-heal-persistence-20261013/` and published self-heal bundles | hundreds of KiB | Current persistence improvements and publication proof |
| `.dumps/antigravity-resilience-20261013/` and other AG proofs | variable | Sources/receipts of current improvement and previous chain |
| `.dumps/tasks/` | 233 MiB | Task evidence/artifacts, internal classification pending |
| `.dumps/workshop-tui-replay-20261012/` | 68 MiB | Replays/evidence, not inspected internally in this round |
| `.dumps/overnight-audit-20261013/` | 67 MiB | Evidence, not classified as disposable |
| `.dumps/antigravity-search-tools/` | 58 MiB | Scripts/fixtures/evidence, additional classification needed |
| `.dumps/workshop-bootstrap-tests/` | 36 MiB | Remaining fixtures, not reclassified in this round |
| `.dumps/task10-artifacts/` | 18 MiB | Validation artifacts, preserved |
| Other `.dumps` test/proof groups | generally KiB to a few MiB | Kept without reading private content |

**Reproduction limit:** `sources/pi-ai` preserves source, but lacks `.git` and `node_modules/.bin/tsgo`. `tools/pi-ai-fork/prepare.mjs` still requires both for standard build. That is why donor `workshop-build3` was kept; no claim is made that a clean clone reproduces all host overlays. The historical baseline is also not equivalent to the current runtime.

Browser stable/spike caches, workshop snapshots/artifacts, and the 5 GiB of backups form the primary remaining volumes outside the runtime. Additional cleanup requires separating needed compiler/evidence and test references — do not delete everything simply because it is large.

## Quick Post-Cleanup Validation

```fish
cd /home/alex/git/my/dsh-customs
node tools/installation-consolidation/status.mjs
systemctl --user is-active dsh-web.service
```

Expected: `state: "complete"`, `canonicalLinks: 404`, `localPackages: 1`, `codeProofs: 5`, `blockers: []`; service `active`. `status.mjs` does not depend on retired npx/scratch, does not import providers, and does not terminate TUIs. `finish.mjs`/`cold.mjs` remain historical procedures and fixtures, **do not re-run their application/preview on this clean machine**.

The reference audit covered profiles, public launch surfaces, canonical runtime, workshop tools/plugins, TUI dependencies, and selected candidates/artifacts/compiler. No active consumer or external link to the three removed roots was found. A broad scan of `.dumps` hit entry limits; inspection was then scoped to relevant groups and completed. No environment variables, credentials, or session contents were read; no inference or full testing across all providers was run. No claim is made to inspect modules already closed in memory.

**Out of scope:** external/mobile frontend, Android/toolchains, and companion prototypes; services `dsh-companion.service` and `dsh-mobile-companion.service` exist locally, but were not migrated, deleted, or validated. None of their contents was used to certify this installation.
