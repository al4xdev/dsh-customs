# Alex's DSH machine tools

## Current delivery

Plans 1–4 are implemented as reversible local plugins; Plan 5 remains recorded as experimental in `.plan/tasks/05-browser-experimental.md`. No installed DSH core package is modified. Native `read`, `edit`, and `write` remain enabled. Which plugin is active in which profile is declared in `activation.json` — see Activation below.

- `apply_patch` / `apply_patch_undo`: contextual multi-file text changes, observed-version guards, per-file recovery receipts. This is an independent JavaScript adapter of the official Codex format, not the official Rust implementation. Exact matching is deliberately stricter. The TUI renders it as a native diff card (`presentCall`/`presentResult`/`presentationMeta`); the model still receives the untouched receipt text. See `apply-patch/REFERENCE.md`.
- Workspace context: absolute cwd, Git worktree root and relative directory, plus compact machine facts through the native prompt registry. See `workspace-context/README.md` for logical/canonical paths and the small unavoidable overlap with the preset cwd line.
- `clipboard_copy`: text via stdin to the local clipboard; empty text clears it. Plumbing is hidden from the model.
- `trash`: recoverable removal to private `/tmp/alex-dsh-trash-*` entries, protected broad paths, per-item batch results, cross-device copy/verify/remove fallback. No permanent-delete tool.
- `list`: bounded directory listing with `depth` (default `1`, immediate entries only), `limit`, and hidden entries included by default (opt out with `hidden: false`). Directories-first deterministic ordering, symlink-loop protection, a truncation signal, and the same `file_path`/`<path>/<type>/<content>` envelope as `read`.
- `shell-reconsider`: matches read-only commands (`cat`, `head`, `ls`, `find`, `grep`, `rg`) and destructive ones (`rm`, `unlink`) and requires a single-use permit before they run, steering toward the native `read`/`list`/`grep`/`trash` tools. Ordinary build and test commands pass through untouched. See `shell-reconsider/README.md`.
- `grammar-fix`: `Ctrl+G` in the TUI draft editor corrects grammar through the session model in a separate request (`reasoningEffort: off`, `temperature: 0`); the original language and technical terms are preserved. Declared with `"profiles": ["dsh-tui"]`, so it loads in no other profile. Behaviour port of Alex's Pi extension, not of its harness. See `grammar-fix/README.md`.
- `managed-plans`: implemented (tools, a `plan` command, plan store and TUI) but loaded by no profile. Recorded under `knownInactive` in `activation.json` so the sync never enables it implicitly.

## Activation

Activation is generated from `plugins/activation.json`; see the repository root
`README.md` for the model and the rationale.

```sh
node tools/activate.mjs          # report drift only
node tools/activate.mjs --write  # apply
```

The bootstrap rewrites only the contiguous run of managed `alex-*` rows in each
`~/.dsh/profiles/*/cordis.patch.yml` and copies every other byte through
untouched, so hand-written per-machine config and comments survive. It is
idempotent and resolves module paths against this repo's actual location.

- To deactivate one plugin, drop its row from `activation.json` and re-run with
  `--write`. To deactivate everything, empty the `plugins` list.
- To skip a profile, remove it from `profiles`; `--profile NAME` targets one
  profile in a single run.
- `plugins/cordis.patch.yml` is an optional `--patch` overlay for an unextended
  profile. It is generated from the same manifest — do not maintain it by hand.
  Do not add it again to a persistently enabled profile.
- Test-only policy overlays must not be added to normal profiles.

The former `tests/` directory was removed by the owner and was not reconstructed.
The automated-suite results recorded below are historical evidence, not a
present-day full-suite claim.

## Verification

The initial delivery passed 66 automated cases and a separate web-dispatcher/real-clipboard probe; that is historical evidence, not a present-day full-suite claim after the directory's deletion.

Follow-up validation used actual runtime probes, real model-led code changes, and finally this chat's native read/apply_patch/undo calls. Headless and tui services passed; dsh-tui also rendered its actual terminal UI. Plain tui has no frontend configured. Git discovery now uses bounded Git itself rather than a repository heuristic. The clipboard exit/close bug found during comparison was fixed in production.

Current evidence and explicit limitations: `.plan/tasks/08-dsh-acceptance-followup.md`, `.dumps/profile-validation/`, `.dumps/workspace-validation/`, and `.dumps/sol-tool-comparison/`. A local-model run passed before reboot; the repeat failed and is recorded, not hidden. Per the owner's correction, no further local-model calls were made. Cwd persona duplication was evaluated and retained to preserve user-authored content.

## Important limits

- No multi-file atomicity and no automatic rollback. Receipts identify partial and uncertain states. Undo refuses newer versions and recreated originals; automated undo requires the same session/runtime.
- `/tmp` recovery is temporary, not backup: reboot or cleanup can erase receipts and recovered files.
- Cross-device trash does a verified copy before removing the source. It cannot eliminate races from uncooperative external writers; source removal can partially fail. Recovery metadata reports this rather than claiming an atomic move. Consult returned metadata for preserved and unsupported attributes.
- Removal snapshots and revalidates ancestor identities/types/canonical paths before destructive boundaries; regression tests cover unchanged-inode parent-to-symlink swaps, including EXDEV source removal under workspace-write. Expected-version rechecks reject already-changed sources. Operations still use paths, not pinned directory handles: the remaining check-to-syscall window is not atomic or hardened against a precisely timed hostile writer. No race-free sandbox guarantee is claimed.
- Shell/MCP mutations bypass observation interception. Their changes invalidate the next guarded file mutation, but there is no global write interception.
- Read-only denies mutation. Workspace-write is limited to the runtime's writable roots; full access permits wider targets subject to trash protections. No custom escalation is supplied.

## Guidance migration and practical comparison

After activation, `~/.dsh/AGENTS.md` was migrated: machine facts moved to the native context, clipboard plumbing removed, and proactive copying/recoverable removal now reference `clipboard_copy`/`trash`. Behavioral instructions, comment style, goals and `.plan`/`.dumps` conventions remain. Legacy instances lacking tools retain explicit fallback guidance rather than a false claim that tools are always available.

The now-deleted `tests/patch-ergonomics.test.mjs` originally compared an identical title/config update across two files through actual DSH services. With two prerequisite reads: literal per-setting `edit` uses 5 total calls, `apply_patch` uses 3, and full `write` uses 4; exact final text matches in all cases. This is a dispatcher-level practical comparison, not a model/token-cost benchmark. Native tools stay enabled as originally agreed; no decision to disable them was inferred. Plans 6 and 7 remain separate and were not silently implemented.
