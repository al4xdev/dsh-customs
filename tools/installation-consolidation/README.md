# Installation consolidation

## Post-cleanup status — TASK7 revision 10

The owner applied the cut successfully (404 retargets, 205 obsolete links removed). The obsolete npx installation and both scratch runtimes have now been retired to `/tmp`, along with the empty `dsh-tui-cli` directory. The original `finish.mjs`/`cold.mjs` remain historical transaction tools and fixture tests: their old-root provenance checks no longer describe an available machine layout. **Do not rerun their apply/preview commands on this cleaned host.**

Current read-only verification does not require those roots or a closed TUI:

```fish
node tools/installation-consolidation/status.mjs
node --test tools/installation-consolidation/status.test.mjs
```

Expected: `state: complete`, 404 canonical links, one local regular package, five static code fingerprints, no blockers. This checks selected graph/code identity, not inference, every profile dependency, or full reproducible source builds. See [the user-layout inventory](../../LOCAIS-DSH.md) for retained compiler/provenance/cache/backups.

The following sections document the historical cut, **not current execution instructions**.

## Current finalizer — TASK7 revision 9

`finish.mjs` implements the **approved classified cut**, unlike the original strict r7 executor below. It is prepared and fixture-tested, **not applied here**. No TUI is ever killed, and prototype/config/provider/model/private data are not inspected or changed.

After manually closing all relevant TUIs (including this controller and launcher), run from the repository in a separate terminal:

```fish
node --test tools/installation-consolidation/finish.test.mjs tools/installation-consolidation/cold.test.mjs
node tools/installation-consolidation/finish.mjs --preview
# Continue only if preview is complete:true with the exact initial classification below.
node tools/installation-consolidation/finish.mjs --apply
node tools/installation-consolidation/finish.mjs --preview
```

Default/`--preview` is read-only: **zero files/directories and zero processes spawned**. It returns exit 2 on blockers; successful preview/apply returns exit 0. It reads only symlink metadata, public manifests/code, the two public origin locks and own-user proc selectors. The real TUI3033 and Node launcher3025 block before all apply writes or service queries; companion prototype is explicitly excluded without an availability promise. Complete argv, prompts, environment, auth, YAML and sessions are neither reported nor used.

The only own-process unreadable-exe exemption requires **EACCES/EPERM**, kernel `comm` exactly `systemd` or `(sd-pam)`, and the exact own-UID user-manager `init.scope` cgroup. Accessible Node executables still undergo normal argv classification even if their `comm`/cgroup resemble a manager. Other own-process selector failures remain blockers; comm alone never bypasses the TUI gate.

### Exact approved initial classification

- **401** live direct N links retargeted to existing C packages, preserving name/realpath checks. Only the four exact approved version pairs in `VERSION_PAIRS` differ: Babel runtime7.29.7→7.29.10, OTel resources2.11.0→2.12.0, native custom loader/require-builtin0.1.7→0.1.9. The separately intentional Pi baseline→`0.87.1+alex.codex-default.206545bfd51e` transition retains observer38.
- **203** direct obsolete links removed **only** while both old N and new C package paths are absent. Names are compiled from the audited public snapshot, guarded by the supplied sorted-name digest `0463e4aa…` (join with newline, no trailing newline). Unexpected names, regular paths, appeared targets and inode edits block; no arbitrary broken-link cleanup occurs.
- **2** exact nested aliases (`@tanstack/react-virtual`, `react-dom` beneath the former N trajectory package) removed only with both targets absent and confined ancestry.
- **2** exact Express-nested aliases (`debug`, `ms`) repaired to C. The missing nested module identity is explicitly **UNKNOWN**. Repair is justified by approved **hoisted** N package name/version metadata plus both pinned public lock hashes, not a claim that absent nested modules were identical. Required versions are2.6.9/2.0.0.
- **1** scratch adapter retargeted after comparing all**18** public package files with C:14 package/lib files plus LICENSE and three public README files. Canonical SDK/session50 and Pi observer38 are checked against the five reused code hashes without imports. SDK/Pi context changes are intentional, not fake equivalence. The public package's README translation YAML is byte-hashed only, never parsed as private configuration.

Initial totals: **404 retargets + 205 link removals**, with all regular/local paths (including llamacpp12files), HMR, YAML and runtime C content untouched. Shared scopes are inspected only as real directories; symlink scope roots are not followed. No install/download/rebuild/root deletion occurs.

All entries must classify before any mutation. Apply repeats the complete snapshot after pausing only the fixed `dsh-web.service`; before each action it checks process gates, original link inode/target, source/destination metadata, absent-both conditions, origin proofs and code pins. New links are staged beside the old link and atomically renamed. Web previously active is restarted even after a partial failure; inactive web remains inactive. No other service/command is controlled.

### Progress, idempotence and limits

Apply creates only a unique **0700 `/tmp/dsh-finish-*`** directory and **0600 `receipt.jsonl`** containing the exact selected old/new targets and per-action progress. This is temporary evidence, **not a new backup/rollback plan**, and finish has no rollback command. A failure retains its truthful partial receipt; no rollback is silently attempted.

After success, preview verifies **403 shared canonical links + 1 canonical adapter =404**, the same frozen401 live-name set against retained N, both repaired aliases and all205 obsolete paths absent. It returns `complete:true`, stage `completed`, **zero actions**. A repeated apply in that completed state also performs no service/file writes. A partially changed initial state is **not** accepted by weakening counts or membership: blind retries are rejected; use the retained progress receipt for explicit reconciliation rather than deleting unrelated paths.

Root N and scratch remain in place. The tool does not certify helper/candidate/compiler references absent and does not quarantine either root; `safeNextCleanup` states that boundary. Removing roots beforehand also removes source provenance needed for post-cut verification. Selected hashes/metadata do not certify whole-runtime behavior, HTTP availability or model/provider behavior. Inode checks are not an OS-wide lock or kernel compare-and-swap: a genuinely exclusive maintenance window remains necessary.

Core exports accept full synthetic layouts/proofs/alias/baseline/count/service/gate seams for tests. CLI accepts only `--preview`/`--apply`, no arbitrary shell or machine-root overrides. Fixtures never read actual private roots; they cover idempotence, partial-count refusal, missing-both guards, approved version pairs, alias provenance/confinement, drift/conflicts, regular/HMR preservation, process gates and web restoration.

## Historical cold executor — TASK7 revision 7

Prepared under **TASK7 revision 7**, not applied to this machine. Only these three tool files are implementation deliverables. No configuration, YAML, SDK, provider, live profile, prototype, source checkout or runtime is modified by preparation/tests.

## Read-only default

```fish
node tools/installation-consolidation/cold.mjs
# Equivalent: node tools/installation-consolidation/cold.mjs --preview
node --test tools/installation-consolidation/cold.test.mjs
```

Preview creates **zero directories/files and zero processes**; it reads symlink metadata, public package manifests/code and `/proc` process selectors. It does not invoke systemctl, import runtime/provider packages, inspect environment/prompts/configuration, install, fetch, call models or activate helpers. Complete argv is never reported; process output is limited to PID and blocker kind. Importing the module is inert. All fixture tests pass a complete synthetic layout and explicit proofs/gate/service seams; they never use actual private roots.

`DEFAULT_LAYOUT` fixes home, canonical CLI, profiles, exact npx root, exact scratch adapter, persistent backup root and procfs. Exported core functions accept a complete alternate layout for tempdir fixtures. CLI does **not** accept arbitrary roots or shell commands.

The exact intended mapping is:

- Shared `profiles/node_modules/<package>` links whose literal target is the same package in the approved npx root → same package in canonical `cli/node_modules`.
- `dsh-tui/node_modules/@deepseek-ai/dsh-llm-pi-ai` pointing at the approved scratch package → canonical adapter.
- All regular paths (including the existing 12-file `@deepseek-ai/dsh-llm-llamacpp` package) remain untouched. Existing canonical links remain untouched. Other symlink targets are blockers, not opportunistic migration candidates.

Scanning is limited to module entries and real scope directories; scope-directory symlinks are not followed. No arbitrary recursive runtime scan, root deletion, npx quarantine or broken-link removal exists here. A byte inventory is limited to the two public adapter packages.

## Deliberate refusal on the current installation

The recorded layout has **401 resolved npx links + 207 broken links + 1 scratch adapter**. Counts are guards, not a license to remove missing packages. Every candidate requires both old and new public package identities, matching names and exact versions; missing old/new targets, mismatches or escaped realpaths defer that entry and reject **the entire apply** before any write/service query.

A broken old target cannot supply trustworthy version/identity metadata merely because its link basename looks plausible. Consequently the known 207 broken links mean this first pass cannot finish consolidation; it must report blockers. Resolve their provenance in a separately reviewed revision rather than fabricate identity, skip incomplete entries or delete npx. Root N remains referenced and retained even after a successful fixture transaction.

Only the explicit Pi transition to `0.87.1+alex.codex-default.206545bfd51e` from known baseline versions is allowed. Canonical Pi observer38 and SDK/session50 code bytes are checked against five static SHA256 pins, without executing code. Adapter bytes must match, but its dependency context is intentionally **not** asserted identical: canonical Pi/observer38 and SDK/session50 differ from legacy/scratch context. Matching CLI or package version alone is not proof of identical module identity or whole-tree equivalence.

## Apply — future zero-TUI window only

```fish
node tools/installation-consolidation/cold.mjs --apply
```

**Do not run during the controlling session.** This implementation was tested only on fixtures; no real apply was run. The principal subsequently ran a read-only preview: 401 resolved npx links, 203 broken links, 1 scratch adapter, 398 planned and 207 deferred entries; blockers included 203 missing packages, 4 version mismatches and 4 unapproved targets. Inventory drift and incomplete mapping remain hard blockers.

Before any mkdir, receipt or systemctl operation, the gate checks proc-directory UID before inspecting executable/argv and considers only this user's processes. Foreign/root-owned processes are not user-service blockers. Actual Node processes selecting `dsh-tui`, native/default CLI TUIs, other canonical/npx/scratch consumers and unreadable own-process selectors block. PID3033 and its Node launcher3025 therefore block while alive. Subagent activity is not itself a user TUI; its owning real TUI still blocks. Leading known `--profile` selectors are parsed before the subcommand; prompt values cannot grant web/prototype exemptions.

The explicitly excluded `companion` prototype profile/subcommand is not a TUI or availability blocker, including `--profile companion web`. Optional `processGate(layout, { includeExcluded: true })` diagnoses it as `active-prototype-consumer`; apply/rollback do not enable that diagnostic option. Prototype availability is **not validated or preserved as a requirement**, and its backend is never stopped nor its code/config edited by this tool. An explicit `dsh-tui` selector always wins over a companion exemption.

Only after complete mapping and zero-TUI/consumer gates, fixed commands `/usr/bin/systemctl --user is-active|stop|start dsh-web.service` may run. Active web is stopped before link changes; proc selectors and mapping are rechecked afterwards and before each operation. Any other web process remaining after the stop blocks. Web previously inactive stays inactive; previously active is restarted even on partial failure. No arbitrary command execution, daemon-reload, service editing, TUI kill or session manipulation occurs.

Apply creates a unique **0700** directory beneath `~/.local/share/dsh-customs-backups`, with a **0600** saved receipt before the first change. Each entry records old target, mode, owner, inode/mtime, resolved referent, public manifest hashes and before/after state. The transaction is explicitly **not multi-entry atomic**. Each link is staged beside the old link, checked, and renamed atomically after target/old-inode guards. Post-edits and target-metadata drift are never intentionally overwritten. Final validation checks selected canonical resolutions and pinned code, without provider imports. No YAML/profile content, HMR activation, auth or helper behavior is changed.

## Explicit saved-receipt rollback

```fish
node tools/installation-consolidation/cold.mjs --rollback /home/alex/.local/share/dsh-customs-backups/cold-UNIQUE/receipt.json --approve-rollback=task7-r7
```

Use **only the exact reviewed receipt** printed by apply. Rollback requires explicit approval, the same zero-TUI gate, confined package paths, private owned receipt and unchanged old/new referent metadata. Applied links must still match their saved after-inode/target: even replacing a link with the same target after apply counts as a conflict. Regular paths and post-edits are not overwritten. Per-entry rollback progress is saved, supporting an interrupted partial rollback without silently bypassing conflicts.

If a crash happens between rename and recording the new inode, the entry remains `pending`; rollback refuses an uncertain current link instead of inferring ownership from target alone. Retain the receipt for manual, separately reviewed recovery. A prepared-but-unmodified receipt is not an approved applied/partial rollback candidate.

## Limits / evidence

- Procfs checks and inode checks narrow races but are not an OS-wide lock or compare-and-swap rename. A genuinely exclusive maintenance window remains mandatory.
- Static selected hashes, public metadata and adapter-byte checks do not certify the whole dependency graph or runtime behavior. No model/provider/UI smoke test is performed.
- The executor backs up link metadata only, not package bodies, sessions or private configuration. TASK7's separately verified durable runtime backup remains necessary; this tool does not read or print its private receipt.
- No npm/npx/install, network/Git operation, root move, cleanup or prototype inspection is implemented.
- Fixture suite covers readonly preview/HMR preservation, live-TUI refusal, ancillary consumers, regular packages, broken/missing/mismatched identities, intentional Pi delta/hash drift, adapter mismatch, scope symlinks, partial failure, conflicts, rollback approval/path/inode guards and consumers appearing after web stop.
