# Pi AI fork for DSH Codex compaction

The fork is [al4xdev/pi](https://github.com/al4xdev/pi/tree/fix/codex-implicit-reasoning-none), based on Pi 0.87.1, not the newer 1.x API. The source checkout is separate: `/home/alex/git/my/pi`.

## Portable workshop versus historical host operations

For clean-machine preparation use [the workshop recipe](../workshop/README.md),
which selects a detached source pin and an isolated official catalog donor.
It does not follow the checkout's moving HEAD or deploy the reviewed upgrade below.
`prepare.mjs` now accepts three positional paths:

```fish
node tools/pi-ai-fork/prepare.mjs /absolute/isolated-pi-source /absolute/seed-runtime/node_modules /absolute/durable-artifact-root
```

Arguments are source, donor node_modules and optional output root.
Omitting paths retains the
historical checkout/scratch workflow: checkout defaults under HOME, installation
root uses DSH_INSTALL_ROOT or XDG_DATA_HOME/HOME, and output defaults to `.dumps`.
Preparation **builds by default** and compiles telemetry in its source checkout;
it is not a read-only doctor. Never pass an active checkout/donor accidentally.
The workshop uses new clones and a new donor, so it does not copy the live machine's
locally amended catalog. Other activation/install/rollback tools below retain
their reviewed machine-specific guards and are not generalized by this change.

## Current host status

Task 26 subsequently deployed source `f5a24c96d72732ba63aeca9a02295c320db04c2d`
as `0.87.1+alex.codex-default.206545bfd51e`, together with the bounded
`alex-codex-transient-close` normal-step recovery plugin. Compaction/title and
permanent failures remain outside that retry seam. The workshop still pins the
reasoning-only portable baseline `c043dedb…`; the Plan 22 versions and receipts
below describe historical operations, not the current installed artifact.

New preparations include the complete upstream MIT `LICENSE` and record its
SHA256 in provenance. Existing completed or partial source/catalog output
directories are refused before staging or compilation. For another preparation,
choose a fresh third positional output root; never overwrite or repackage a
reviewed historical artifact. This packaging correction does not alter the
installed `206545bfd51e` binary, its receipts, or existing tarballs.

## Why

DSH's summarizer omits `reasoningEffort`. Pi AI previously translated that absence into Codex `reasoning.effort = "none"`, rejected by `gpt-6.1-sol`. The fork leaves the field absent so the backend chooses its default. Explicit effort choices and explicit off retain their existing translation contracts. This does not change context thresholds or fix unrelated authentication, overflow, or transport errors.

DSH's manual error `manual compaction could not produce a smaller summary` is a generic wrapper for summary-stage failures, including provider rejection; it does **not** prove that a summary was actually too large. Inspect the durable `compaction/end.data.error` instead.

## Build and validation

Prerequisites: the exact official DSH 0.2.0-rc.2 installation and a Pi v0.87.1 checkout with development dependencies. Lifecycle scripts are not necessary for the focused fix.

```fish
# In the Pi checkout:
npm ci --include=dev --ignore-scripts
# In this repository:
node tools/pi-ai-fork/prepare.mjs
```

Preparation compiles telemetry and AI using the pinned compiler, copies the catalog from the **active** DSH installation at `~/.local/share/dsh-cli/node_modules` rather than an older npx cache, and packs a versioned local tarball with provenance. The active catalog has local model additions with stale manifest hashes; preparation refreshes only the scratch manifest and preserves every model JSON byte. It never edits the installed catalog. It does not publish to npm. Artifacts and the isolated runtime live under `.dumps/pi-ai-fork/`; **do not clean that directory while the profile links to its runtime**.

Run the focused upstream tests from `packages/ai`:

```fish
node ../../node_modules/vitest/dist/cli.js --run test/openai-codex-reasoning-default.test.ts test/openai-codex-stream.test.ts
```

The new regression had 19 expected baseline failures; the corrected adapter and existing Codex transport tests pass together (78 tests). Full `npm run check` also passes after catalog hydration and telemetry compilation.

`runtime.mjs` installs an unmodified official DSH adapter with an exact override to the local tarball. `verify.mjs` proves ESM resolution, official peer identity, provider lazy loading, and payload behavior using fake credentials and no paid API requests. `live-check.mjs` is the opt-in synthetic compaction check, using existing credentials read-only. Consult each script's usage; no real session history is replayed or rewritten.

Validated runtime: `.dumps/pi-ai-fork/runtime-cc0c4b95b7145f89`. Live validation made two requests with effort omitted and completed official `compactNow`: **38,844 → 3,540 estimated tokens**, with checkpoint flush and durable replay validated and credential hashes unchanged. Read-only verification also passed against the real `~/.dsh/profiles/dsh-tui` after activation.

A separate user-requested clone `c_test2` (`a2342e81-a4d7-46ef-b892-1c28ef764035`) preserves all 2,538 events of `c_teste` (`88e490b9-9b17-405d-b737-4279e14b71d1`). At cloning time, original hash, size and mtime were unchanged. Subsequent user activity appended failed attempt markers to the original while preserving its entire previous event prefix; our tests do not operate on it. The clone is reserved for the user's manual test in a new TUI process.

## Activation and rollback

## Important: the profile-only integration did not reach TUI OAuth

The initial direct dependency link reached the base adapter but **not** `CredentialGatedAdapter` registered by the TUI OAuth bundle. Linked bundles resolve their adapter peer through the host installation; the TUI then finds pi-ai relative to that host adapter's manifest. Consequently, the initial profile-parent resolution proof and base-adapter live test were insufficient for the real TUI path. A new-process attempt in `c_test2` still rejected `none`.

Plan 22 implemented the user-approved host solution: an npm override scoped to `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2` in `~/.local/share/dsh-cli/package.json`. The installed pi-ai is `0.87.1+alex.codex-default.7f8948d3c423`. The initial profile dependency override was removed through the official manager; Gemini remains separate.

The host installation changed exactly one package. All 609 other lock entries and all 290 protected host package trees remained identical. The artifact is stored durably under `~/.local/share/dsh-cli/artifacts/pi-ai-fork/ffebfb3695822db02a70d3b6a58519afc03db8537afa5fdcdabe1e4dd5f830c7/`, not in ephemeral `.dumps/`. Its SHA-512, version and installed bytes were revalidated after promotion.

`host-install.mjs` provides rehearsal/install/promote/rollback guarded by receipts. The active receipt and original backups are `.dumps/pi-ai-fork/host-1791830410026-164006/receipt.json`; retain them if you need the exact rollback, including the original locally amended model catalog. npm uses its original peer policy: `--legacy-peer-deps` was rejected during rehearsal because it would remove 27 framework peers.

`tui-oauth-check.mjs` exercises the real linked OAuth importer, `CredentialGatedAdapter`, host `PiAiAdapter` and its anchored provider catalog. The pre-install baseline reproduced `none`; post-install absence, low and medium passed. A live test through that same class completed official `compactNow`: **38,808 → 3,512 tokens**, two requests, durable checkpoint/replay, zero credential writes. The final offline check passed after removing the redundant profile override and promoting the durable artifact.

```fish
node tools/pi-ai-fork/tui-oauth-check.mjs --offline
# Guarded rollback rehearsal only (does not undo the installation):
node --experimental-import-meta-resolve tools/pi-ai-fork/host-install.mjs rollback-dry-run .dumps/pi-ai-fork/host-1791830410026-164006/receipt.json
```

Existing processes retain old modules. Start a new dshtui, resume `c_test2`, and run `/compact` while idle to test the actual large history. Its compaction is not claimed as completed by these synthetic checks. A future DSH adapter upgrade requires reviewing the version-scoped npm override rather than assuming the pin automatically follows it.

## Reviewed managed-fork upgrade (plan 26)

The supported upgrade is **only** the durable managed `7f8948d3c423` fork above → `0.87.1+alex.codex-default.206545bfd51e`, built from reviewed commit `f5a24c96d72732ba63aeca9a02295c320db04c2d`. This includes the Codex WebSocket/SSE fixes already validated in the fork checkout. It does not introduce adapter retries or change OAuth's existing normal policy (five retries); the separate transient-close plugin delegates retry to the official harness. Updating `llm-pi-ai` settings alone cannot change the linked `CredentialGatedAdapter`'s policy.

The installer retains the initial `c043ded`/published-0.87.1 installation path. An existing override is accepted for upgrade only when its exact durable path, version, full source hash, artifact SHA-256/SHA-512, provenance and installed package tree match the reviewed previous fork. It rejects unmanaged overrides, arbitrary HEADs/builds, duplicate pi-ai instances, package additions/removals, dependency/integrity drift and every non-pi lock change. The upgrade source checkout must be clean on the reviewed branch and complete Git tree. Its **compiled tarball bytes and catalog snapshot are also pinned**, not merely a claim in provenance. A new build/catalog/version needs a new explicit pin review.

The new receipt snapshots the **previous fork and existing override**, not the older upstream baseline from plan 22. Keep both receipts, their private `.dumps` backups and both durable artifacts; do not substitute the old plan-22 receipt for this upgrade's rollback. Scratch npm may rebase only a local pi-ai artifact URL (and the anonymous lock name); a real rollback restores the original host input bytes, not a scratch-relative lock.

Durable tarballs and both provenance files must be **regular non-symlink files**. Promotion uses exclusive creation or identical-file reuse verified with `lstat` and a no-follow file descriptor; symlinks to an otherwise valid ephemeral artifact, directories and devices are refused. The canonical durable artifact path must equal the intended destination. The same regular-file guards protect the previous durable baseline.

The sequence below records the completed Task 26 rollout, not a command to
repeat on the current host. Its reviewed `206545bfd51e` tarball is immutable.
A new license-bearing build needs a fresh output root and a new artifact-pin
review even when its source-derived version is unchanged; do not regenerate
the historical tarball or substitute it into an old receipt.

```fish
cd /home/alex/git/my/dsh-customs
node tools/pi-ai-fork/host-install.mjs --self-test
node --test tools/pi-ai-fork/host-install-upgrade.test.mjs
node tools/pi-ai-fork/prepare.mjs /home/alex/git/my/pi /home/alex/.local/share/dsh-cli/node_modules
set artifact /home/alex/git/my/dsh-customs/.dumps/pi-ai-fork/206545bfd51e-34a0a629dac6/earendil-works-pi-ai-0.87.1+alex.codex-default.206545bfd51e.tgz
node --experimental-import-meta-resolve tools/pi-ai-fork/host-install.mjs dry-run $artifact
# Use the absolute NEW receipt printed by that dry-run:
set receipt /absolute/path/to/the/new/host-snapshot/receipt.json
node --experimental-import-meta-resolve tools/pi-ai-fork/host-install.mjs rollback-dry-run $receipt
node tools/pi-ai-fork/host-upgrade-rehearsal.mjs $receipt
# STOP here until all plugin/integration gates have been reviewed.
node --experimental-import-meta-resolve tools/pi-ai-fork/host-install.mjs install $receipt
node tools/pi-ai-fork/tui-oauth-check.mjs --offline
node --experimental-import-meta-resolve tools/pi-ai-fork/host-install.mjs promote $receipt
node tools/pi-ai-fork/tui-oauth-check.mjs --offline
# If an explicitly approved rollback is needed:
node --experimental-import-meta-resolve tools/pi-ai-fork/host-install.mjs rollback-dry-run $receipt
node --experimental-import-meta-resolve tools/pi-ai-fork/host-install.mjs rollback $receipt
```

`dry-run` and `rollback-dry-run` are **not read-only**: they create an exclusive host sentinel, scratch snapshots and receipt evidence; npm may read the registry/cache. Upgrade rollback rehearsal performs a full scratch installation of the previous fork and compares every package file against its durable tarball. `host-upgrade-rehearsal.mjs` runs full npm baseline → upgrade → reference-only promotion → rollback in a new private scratch host, proves model JSON bytes and all protected real-host trees unchanged, and rejects a simulated partial manifest as a successful upgrade. It never installs/promotes/rolls back the real host, mounts credentials or requests an LLM. Offline OAuth checks create local reports but block network and use fake credentials; their forced SSE/zero-retry fixture is an identity/reasoning proof, not a proof of the configured agent-recovery policy.

### Interrupted operations: inspect, never blindly retry

These operations are guarded, multi-stage transactions, **not filesystem-atomic** npm installs. Failures retain `installing`, `promoting` or `rolling-back` plus receipt evidence containing observed root hashes, package-resolution/tree fingerprints, protected-tree status and the failed stage. Concurrent package-manager changes still fail guards. A killed process may leave the exclusive sentinel; first establish that its PID is no longer active and inspect the receipt before an explicitly reviewed sentinel recovery.

```fish
node --experimental-import-meta-resolve tools/pi-ai-fork/host-install.mjs recover-inspect $receipt
# Choose ONE direction after inspection; neither reruns npm nor edits host packages:
node --experimental-import-meta-resolve tools/pi-ai-fork/host-install.mjs recover-before $receipt
node --experimental-import-meta-resolve tools/pi-ai-fork/host-install.mjs recover-complete $receipt
```

`recover-before` reconciles only the complete exact pre-operation state; `recover-complete` proves every post-operation invariant before recording success. They update receipt metadata only (plus scratch proof/sentinel files). A partial npm tree/lock, unexpected catalog, missing backup or foreign edit is **refused**, not overwritten or reclassified. Such a state requires a new reviewed recovery plan using the retained evidence; the tool will not silently repair it or retry a paid request.

Validated **pre-install** evidence: new artifact SHA-256 `796b9c3cd14936bd4c46a69ccf80fcdeafb7cdfa95477fddf4e2d58f16c7fd0c`; source SHA-256 `206545bfd51ee0284248e00b39fa5736e212d6b4ff8394bbf27013d1353c089b`; catalog SHA-256 `34a0a629dac6faaf21f5ba5729beec060c268693470f81d8e4f9491e6a0de7c7`. The rehearsal receipt is `.dumps/pi-ai-fork/host-1791835148431-217192/receipt.json`; the post-review full scratch cycle report is `npm-upgrade-proof-9aOF2s/report.json` beneath it. The original seven guard tests and 31 upgrade/promotion/recovery regressions passed. It preserved **609 non-pi lock entries**, all **290 protected real-host trees**, all model JSON bytes and restored the previous fork's **772-file** tree exactly. This evidence alone does **not** claim the new fork is installed in the real host.

The fish `dsh` launcher resolves `~/.local/share/dsh-cli/local-model-launch.mjs` (or `$XDG_DATA_HOME/dsh-cli`), then the host executable with `--profile dsh-tui`; it may inject a local-discovery fd overlay. New-worker OAuth bootstrap proofs are required instead of inferring loaded modules from profile symlinks. The separate web process launched through the old npx installation is outside this host deployment. Existing TUI processes must be reopened manually after successful promotion; do not stop busy sessions automatically.

The commands below describe the **initial profile-only integration**, retained for rollback/history rather than as the recommended final installation. It required a successful base-adapter `live-report.json`; that report alone does not prove TUI OAuth correctness. Plugin id, settings, credential scope, and `cordis.patch.yml` stay unchanged.

```fish
node tools/pi-ai-fork/activate.mjs install /absolute/path/to/runtime
# To undo only this override, preserving newer unrelated profile edits:
node tools/pi-ai-fork/activate.mjs rollback /absolute/path/to/runtime
```

The first real-profile installation completed in pnpm but the DSH manager timed out while waiting for subprocess termination. Independent read-only verification of the saved manifest, lock, generated map, router, peers and payloads passed; `activate.mjs verify-installed <runtime>` reconciled the receipt without reinstalling or changing the profile. Those checks were valid for the base adapter, **not sufficient for the linked TUI OAuth adapter**. Do not blindly retry `install` after such a timeout.

Both operations require a **new DSH process**; they do not restart or stop existing sessions. Reopen/resume the same session after restarting and retry `/compact` while the agent is idle. A process launched before activation still holds the old JavaScript modules.

Snapshots are local under `runtime/profile-backup`. The rollback deliberately removes only the linked dependency through the official manager instead of overwriting the whole profile with an old backup. No npx package, credential, session file, TUI source, or other profile is edited.

## Structured Codex failure candidate (Task38)

Problem: Codex already creates `CodexApiError` with machine code and event payload, but its final catch preserves only a display string. The installed host adapter therefore sees message-only overload as `PI_AI_ERROR`. HTTP error handling also used to label every 429 as a quota/usage limit. Native retry exists already; it needs trustworthy categories, not a phrase list or another retry engine.

The maintained recipe is `codex-failure-categories.mjs` plus portable source `provider-failure.ts`. It:

1. verifies the exact reviewed baseline Codex source hash `206545bfd51e…` before writing anything;
2. reserves a **fresh** output, copies historical source, adds the terminal observer/helper and public export, and compiles with the explicitly supplied cached native TypeScript compiler;
3. creates a package-like candidate from the active SDK and replaces only compiler-produced Codex/index/helper `.js`, `.d.ts` and maps;
4. records before/after SHA256 for all 12 possible generated targets (11 currently change; Codex `.d.ts` is unchanged) and hashes every protected non-owned SDK file;
5. preserves package metadata, catalogs, unrelated/OAuth output bytes and active installation. It performs no install, download, credentials lookup, API call, runtime/profile edit or promotion.

```fish
node tools/pi-ai-fork/codex-failure-categories.mjs /absolute/reviewed-source-root /absolute/cached-node_modules /absolute/installed-pi-ai /absolute/fresh-output
# Then run only offline fixtures against the exact candidate graph:
env CODEX_FAILURE_CANDIDATE=/absolute/fresh-output/package node --test tools/pi-ai-fork/codex-failure-categories.test.mjs plugins/codex-transient-close/failure-bridge.test.mjs
```

The source digest includes **all affected source files**: Codex implementation, portable helper and additive index export. The manifest's `proposedVersion` denotes the reviewed **feature variant identity only**, not a changed/published npm package version. Thin receipt rollout intentionally keeps `package.json.version`, manifest/lock and old artifact/receipt pins unchanged. The public observer version marker and content/source digest identify the new feature. The package-like candidate is not a published source pin, npm installation or proof of a loaded real daemon.

The candidate manifests/source copies are immutable evidence. Interrupted or superseded candidates are retained; use another explicit fresh output. Main promotion must compare all before hashes, back up only owned outputs, verify exact after hashes and observer module identity, and have guarded rollback. This recipe is not that promoter. Existing `prepare.mjs`/`host-install.mjs` historical pins and receipts are not repurposed.

The helper maps reviewed structured auth/quota/context/request/server/rate/transport/timeout facts; permanent facts have precedence. SDK event/HTTP display text never feeds category selection. Generic 429 without explicit quota is rate limiting; a named quota/billing code is quota. Retry-After facts are finite, timer-safe and detached; the official owner policy still decides whether the hint is acceptable. Unknown facts emit no DTO. Terminal observer callbacks are isolated and portable (browser helper bundle gate); no Node AsyncLocalStorage exists inside the SDK.

The root [Codex middleware](../../plugins/codex-transient-close/README.md#structured-terminal-failure-observer) owns request-local ALS and listener lifetime. `applyWithObserver(ctx, candidateSdk)` is the offline test seam. Typed SDK/source/bridge tests do not themselves prove actual agent recovery: separate native Loop tests must use real PiAiAdapter, the exact candidate Codex API and subscriber graph, and official retry scheduling. No new phrase fallback was added for the reported message-only overload; absence of a live machine code remains an honest unknown.

## Upstream references

- [Compaction fails with GPT-5 models, #3342](https://github.com/earendil-works/pi/issues/3342): same class of `none` rejection, fixed in Pi's coding agent by inheriting session thinking; DSH uses its own summarizer.
- [Codex adapter](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-codex-responses.ts): the omitted-effort fallback was still present when inspected.
- [Context ceiling, #9409](https://github.com/earendil-works/pi/issues/9409) and [compaction transport, #10781](https://github.com/earendil-works/pi/issues/10781) are separate Pi coding-agent reports, not additional diagnoses of DSH.
