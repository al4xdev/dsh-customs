# DSH Plans 1–4 delivery and Plan 5 registration

## Delivered

- Plan 1: Codex-format exact-context adapter, observation/version/coverage checks shared with native edit/write, recoverable receipts and conflict-aware undo. Official source revision/license and adapter differences recorded in `plugins/apply-patch/REFERENCE.md`. Native tools remain enabled as agreed.
- Plan 2: native machine section and runtime path context, worktree/canonical-path/error semantics tested. Global AGENTS.md machine facts deduplicated after persistent activation.
- Plan 3: clipboard_copy, exact stdin transfer, empty-clear, explicit failure/lifecycle handling. Separate-runtime live round trip verified. Probe refuses clipboard formats it cannot safely restore.
- Plan 4: private temporary trash recovery, symlinks-as-entries, protected paths, batch/partial results, cross-filesystem copy/hash-verify/remove, expected-version and ancestor topology rechecks, cancellation checks.
- Plan 5: `.plan/tasks/05-browser-experimental.md` remains experimental; no browser implementation was authorized or added.

## Activation and verification

Plugins are enabled in web, headless, tui and dsh-tui profile patch files. All four compose successfully with `dsh --profile NAME --dump-config`; byte comparisons after removing the new rows confirmed existing settings are preserved. No installed core package was edited. Private pre-activation backups: `/tmp/alex-dsh-activation-backup-Rmu4Pb/manifest.json` (lost on reboot).

The parent reproduced the complete suite: 67 cases, 66 passed, zero failures, one opt-in live unit case skipped. The actual separate DSH web integration probe on 8081 exercises native dispatcher, standard tools, observation/conflicts, apply/undo, trash, fresh prompt assembly and real clipboard copy/clear/restore. Local timestamp/PID evidence: `.dumps/runtime-probe.json`.

Practical dispatcher comparison for an equivalent two-file title/config change: edit 5 total calls, apply_patch 3, write 4, including two prerequisite reads; final text identical. This is not an LLM token benchmark or a new decision to disable standard tools.

## Explicit limitations and scope

No multi-file atomicity, automatic rollback or atomic compare-and-remove. External writers can race between the last path/version check and a syscall; ancestor revalidation is bounded hardening, not fd-relative hostile-sandbox containment. Shell/MCP writers are not intercepted. Automatic undo is same-session/runtime; temporary receipts and trash are not durable backup. Git discovery is a documented local heuristic rather than a full Git process invocation. The native preset's cwd line minimally overlaps the path tuple; retained runtime snapshots suppress unchanged repeated blocks.

Plans 6 (model route discovery) and 7 (installation cleanup) remain separate. No guessed Luna route or installation removal was performed. See `plugins/README.md` for usage, deactivation and migration details.
