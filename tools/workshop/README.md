# Portable Workshop: Sources → Artifacts → Runtime → Profiles

> **Note:** This document and its scripts describe historical and internal maintenance procedures for assembling the DSH runtime from pinned source forks. They are not required for everyday plugin or companion usage.

The workshop describes how to assemble a fresh DSH installation without relying on npx
or active directories of another machine. It **does not** sync `.dsh`, does not import
credentials, does not assume dotfiles profiles are already installed, and does not restart services.

## Source of Truth

- `manifest.json`: DSH package/version, HTTPS repositories and full commit SHAs,
  package managers, TUI patch with SHA256, and reviewed strategies.
- `../task10-frontend/recipe.json` + `frontend.patch`: upstream base `c2eee952…`
  plus the complete delta up to `c4f040104e9d45955ed346ce0b1a2d8cb2fab779`.
  This patch replaces the legacy 13-file snapshot with 32 files, including
  grammar extensions and already committed plan contracts.
- pi-ai: `c043dedb60695f45fd9577ced676074f08d7f9b0` is the portable baseline containing the
  implicit reasoning fix, not the pin currently deployed on the host. Task 26
  promoted `f5a24c96d72732ba63aeca9a02295c320db04c2d` / artifact `206545bfd51e`;
  that promotion does not automatically alter the portable recipe or its pins.
- Antigravity: `7dcd24272a0897cb0698b24cc9edc0a587c3bea7`; `lib` is committed.
  Current strategy is **committed-prebuilt**, not a standalone source rebuild.
  A versioned/hashed patch marks optional the legacy peer `dsh-client-runtime`,
  used solely in types/tests/client injection, never imported by compiled JavaScript.
  The runner rejects any bundle referencing it in JS. This allows installing the
  host/TUI provider without pulling incompatible npm runtime `0.0.1-rc.1`;
  **it does not prove web client compatibility**.

Local checkouts remain distinct Git workshops. We perform no automated `reset`,
commit, push, or capturing of all untracked files. Updating recipe pins/patches is an
explicit decision, never an implicit side-effect of shifting HEAD.

`reproduction.status: ready` indicates a registered strategy exists, not a guarantee of
full compilation, remote access, or provider authentication. Read `reproduction.reason`
and doctor constraints.

## Modes and Effects

| Command | Effect |
| --- | --- |
| No arguments / `--doctor` | Metadata/hashes/prerequisites, read-only |
| `--plan --destination ABS` | Command plan and paths, without creating destination or executing commands |
| `--prepare --destination ABS` | Creates missing destination with snapshot, plan, seed, and `prepared` receipt; no install/build |
| `--bootstrap --destination ABS --allow-network --allow-build` | Installs/builds/packages **strictly** inside fresh staging |
| `--help` | Usage help, without inspection or writes |

`--json` preserves machine-readable output. The doctor imports no provider modules, mounts
no plugins, calls no DSH boot/dump-config, and reads no profile configs. `git`/`npm` are
checked on PATH via metadata; doctor executes none of their scripts.

Unknown flags, combined modes, absent consents, and locked/mismatched recipes fail before
reserving a destination. `--prepare` and `--bootstrap` **are not resumable stages of the same directory**:
both require a non-existent target. Preparation is for review; execution uses a distinct fresh target.

## Paths and Protection

The repository resolves from its own module location. HOME, XDG_DATA_HOME, and DSH_HOME
determine protected roots without hardcoded `/home/alex`. Destination requires absolute path,
existing canonical parent, and exclusive reservation (0700). Overwrites, occupied directories,
symlinks (including broken), non-canonical parents, traversal, and overlap with sources, `.dsh`,
active runtime, or HOME ancestors are rejected. Configs/caches (`.config`, `.cache`, `.npm`,
including npx), explicit environment equivalents, and any other Git worktree found in ancestors
via metadata are protected. The `.dumps` exception in this workshop does not authorize targets
inside nested Git repositories.

The doctor verifies names/versions/package managers against the three reviewed builders and
validates all TUI recipe pins, including the submodule. Changing only metadata to resemble a
newer version fails prior to installation; upgrades require corresponding recipe, implementation,
and tests.

Staging under `.dumps` is permitted for testing. **Do not activate output from `.dumps`.**
For fresh machine installations, use persistent storage, such as a new directory under
`$HOME/.local/share`. Do not target the active protected root `dsh-cli`: promoting/consolidating
that root is a distinct operation with backup/rollback procedures.

These are tooling guards, not a code sandbox for dependencies or a guarantee against concurrent
adversarial changes in parent directories. Do not run in unreviewed checkouts or modify staging
while commands are active.

## What Bootstrap Executes

1. Reserves new target and writes manifest/plan/receipt prior to installations.
   Before subprocesses, initializes private HOME/DSH_HOME/XDG and temp/cache paths inside target,
   configures npm/pnpm to use them, and applies empty npm/Git configs. Inherited redirects from
   package managers/Git are filtered; does not reuse personal hooks/configs or host caches.
   PATH retains system binaries and explicit proxies/CAs remain accessible; this is not a sandbox.
2. Installs runtime seed `@deepseek-ai/dsh@0.2.0-rc.2`, npm `12.2.0`, pnpm `11.21.0`, and official
   donor catalog `@earendil-works/pi-ai@0.87.1`, with install scripts disabled. Initial CLI
   uses machine npm; effective versions are recorded.
3. TUI: clone/base detached/submodule pin, `git apply --check` + apply, frozen/ignore-scripts
   install, reviewed compilation, UI smoke import, and `npm pack`. Does not run the large upstream
   test suite and does not touch `lib` of checkout in use.
4. Pi: detached clone of portable baseline, `npm ci --include=dev --ignore-scripts`, telemetry/AI
   build, and packaging using the **fresh seed catalog**. Third positional argument of
   `../pi-ai-fork/prepare.mjs` selects artifact root.
5. Antigravity: detached clone of pin, optional peer patch check/apply, tracked `lib` unchanged
   without JS import of legacy peer, then `npm pack --ignore-scripts`. Does not call `npm run bundle`,
   whose upstream workspace is not present.
6. Verifies tarball names, versions, and hashes. Installs pi override **scoped to adapter**
   `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2`, keeping host peers, and the Antigravity package into
   new runtime. Does not use legacy-peer-deps to conceal host discrepancies.
7. Validates manifests/runtime and shared Cordis/scope identities via paths, without importing
   providers or authenticating. Seals package-lock hash.

Manifest `build.commands` provide readable documentation. The runner accepts only the three
implemented/reviewed strategies; it does not execute arbitrary shell commands passed via manifest.
Placeholders `<...>` are documentation, not interpolation strings. Pi strategy encapsulates its
staging commands in its helper.

Upstream donor catalog does not automatically reproduce local models added on this machine, such
as custom aliases/metadata. That delta belongs to configuration or an explicit catalog recipe; we
do not silently copy files from active runtime. Even with pinned sources and direct dependencies,
initial npm install resolves transitives: receipts/locks attest to the generated installation,
not future bit-for-bit equivalence.

The Pi helper bundles upstream MIT `LICENSE` into new tarballs and records its SHA256 in provenance.
Rejects any existing source/catalog output directory, full or partial, prior to staging/build.
Re-running preparation requires another explicit artifact root. Historical tarballs/receipts and
installed binary `206545bfd51e` remain immutable; this packaging fix applies strictly to new
preparations and does not alter legacy evidence.

## Structure and Receipts

```text
DEST/
  manifest.json        recipe snapshot
  plan.json            reviewed commands and destination
  receipt.json         state/provenance/hashes/results
  runtime/             package.json, lock, and installed dependencies
  sources/{tui,pi-ai,antigravity}/
  artifacts/{tui,pi-ai,antigravity}/
```

Status `prepared` does not imply installed. `bootstrapped` means this tool's artifact/install
contracts passed; `profileActivated` remains false. Failure yields `status: failed`, command ID,
exit code, and partial files for inspection. The runner stores no arbitrary dependency stderr
that might leak sensitive data; it neither deletes nor attempts repairing the target. Do not
treat a failed directory as complete.

Artifacts and receipts of a maintained installation belong in durable storage. Do not move staging
after installation: absolute `file:` paths and locks form part of the graph. Promotion requires
recalculating/reinstalling in final destination and revalidating everything, not just `mv`.

## Fresh Machine and Dotfiles

```fish
# In workshop checkout, after restoring configs via dotfiles:
npm ci --ignore-scripts
npm run workshop:doctor
set WORKSHOP "$HOME/.local/share/dsh-workshop-rc2"
node tools/workshop/bootstrap.mjs --plan --destination "$WORKSHOP" --json
node tools/workshop/bootstrap.mjs --bootstrap --destination "$WORKSHOP" --allow-network --allow-build --json
```

Then review receipt and TUI tarball in `artifacts/tui/receipt.json`. Runtime resides at
`$WORKSHOP/runtime`; CLI is `runtime/node_modules/.bin/dsh`. The recipe does not alter PATH,
fish aliases, or web service. Launchers must be configured in dotfiles targeting chosen
installation, without floating npx.

Prior to launching, installing TUI bundle into restored profile is an explicit step: review
pinned CLI command `plugin --profile dsh-tui add` with appropriate tarball, lock/peer identity,
and external configs. Bootstrap does not invoke this command as it could mutate an existing
personal profile. Only then generate wiring via `node tools/activate.mjs --check --profile dsh-tui`
followed by deliberate `--write`. Non-`alex-*` references (Antigravity login, local models/paths)
remain under dotfiles control and require review on the new machine.

OAuth/login credentials are not included in tarballs. Configure them via standard separate
flows; no bootstrap test validates Google login or Codex inference.

## Updating the Recipe

- TUI Fork: select commits, generate delta from base to approved fork, and review files;
  update SHA in `task10-frontend/recipe.json` and manifest simultaneously. Do not run `git diff HEAD`
  in a clean checkout assuming it captures local commits.
- Pi: promote validated fresh fix with explicit pin; avoid selecting branch/HEAD in review.
  Catalog and provenance must be chosen and recorded.
- Antigravity: source may be packaged from current pin, but source rebuild requires dedicated
  task to resolve missing workspace. Do not label this a compilation.
- Modified recipe or hashes invalidate prior preparation receipts. Never manually edit old
  receipts to force them to pass.
- For a remote clone to obtain this foundation, changes, tests, lock, and recipes must be
  committed and pushed by the owner.

## Validation

```fish
npm run test:workshop
```

Persisted fixtures exercise manifest/pins/hash/paths, concurrent reservation, subprocess-free
defaults, exclusive preparation, simulated commands, mismatched tarballs, partial failures,
and divergent peer identities. They do not confuse simulation with actual installation. Evidence
of live trials resides in `.dumps` and is reported separately; does not constitute production backup.

Task 7 cleanup follows workshop validation, persistent backup, migration of links/scratch
adapter/web service, and approval to retire npx root. Active runtimes and private data remain
untouched during this phase.
