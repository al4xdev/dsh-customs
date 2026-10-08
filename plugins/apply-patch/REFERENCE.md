# Official reference and adapter boundaries

Format reference: https://github.com/openai/codex/blob/8c818cbed4bc83d30f5d515674b809646fe2676d/codex-rs/apply-patch/src/parser.rs
Matching reference: https://github.com/openai/codex/blob/8c818cbed4bc83d30f5d515674b809646fe2676d/codex-rs/apply-patch/src/file_update.rs (`compute_replacements`)

Repository: https://github.com/openai/codex
Revision: `8c818cbed4bc83d30f5d515674b809646fe2676d` (resolved during implementation).
License: Apache-2.0; see https://github.com/openai/codex/blob/8c818cbed4bc83d30f5d515674b809646fe2676d/LICENSE

This is an independently implemented JavaScript adapter based on the official documented patch grammar, not a vendored Rust implementation or a guarantee of complete compatibility. It supports Add/Delete/Update File, Move to, @@ anchors, line context and End of File. It rejects environment preambles, heredoc wrappers, ambiguous/fuzzy context (Codex takes the first match and retries with trimmed whitespace; this adapter requires one exact match), and symlink/directory targets. Insert-only chunks append; use context for insertion elsewhere. Existing updates preserve final-newline presence; additions use a final newline.

## `@@` anchors

Same as Codex: the anchor line is located first and the chunk's old lines are searched strictly after it (`parser.rs`: "`old_lines` must occur strictly after `change_context`"; `file_update.rs` sets `line_index = idx + 1`). Repeating the anchor as the first context line (`@@ def f():` then ` def f():`) therefore finds nothing in Codex either; the error message says so.

## Paths and sandbox

Paths resolve against the session cwd through `ctx.fs.resolve` (DSH's own spelling and realpath identity, including physical `..` after symlinks). The session's sandbox mode is the first gate, before any `lstat`/stat of the target: `read-only` denies; `workspace-write` requires every target, destination and removal parent to canonicalize under DSH `writableRoots` (workspace, `/tmp`); `danger-full-access` is unfenced. There is no escalation; use native `edit`/`write` with `sandbox_permissions` for outside files. The per-call policy is also passed to `ctx.fs.writeText`, so the sandboxing backend fences each write with the session mode, not the deployment default.

## Read observation: why a layer over the official policy

`@deepseek-ai/dsh-fs-observation-policy` only records the last observed version per session and target (any partial read counts) and turns it into the provider's atomic CAS intent through the `fs/write-intent` / `fs/edit-intent` waterfalls; its state is private. Line coverage (which lines were actually shown, truncation-aware) is not available there, so `observation.mjs` keeps that state from `fs/observed` + `tools/result`. Its write/edit guard is a prepended listener on the same two waterfalls: it runs inside the native tool, on the exact target the tool will mutate, after argument validation and any escalation approval, then calls `next()` so the official policy still supplies the CAS version. Native `write` needs the entire file read; native `edit` needs every occurrence of `old_string` read. `apply_patch` checks the same state itself (changed lines and context; entire file for Delete/Move) and uses `replaceIfVersion`/`createIfAbsent` intents directly.

Observation is per agent session, like the official policy: a subagent's reads do not count for its parent (or vice versa), and a change made by another session is an external change that makes the observation stale. The session's own successful mutation becomes its new observed version (entire file only if the original was entirely read, or for Add); otherwise changed lines must be read again. Observations are captured when an `apply_patch` call starts, so two concurrent calls from one session cannot refresh each other.

Limits: shell, MCP and other non-DSH writers are not intercepted and their reads do not count as observation; their changes are only detected as stale versions by the next guarded mutation. State is in memory and requires fresh reads after restart.

## UI presentation

A capable UI renders these tools like native `write`/`edit`: `presentCall` turns the patch argument into a proposed diff card, `presentResult` shows a diff card for a fully `applied` receipt, and `output.presentationMeta` persists the confirmed diff set plus the receipt text so replay rebuilds the card without the live tool value. Only operations the receipt marks `changed`/`partial` become diff entries; Delete and a bodyless Move (the grammar carries no file body) appear in the card title instead. A `partial_failure` result never renders as an applied diff: it becomes a generic card titled `Patch incomplete` with a compact per-file summary and the recovery manifest path, and a thrown/`isError` result keeps the raw error. `apply_patch_undo` presents a compact undo summary instead of the receipt JSON. The model-facing content is always the untouched receipt; the hooks are total and never throw, so a malformed value degrades to the raw card.

## Concurrency, failures and undo

Calls hold an in-process per-target lock across preflight and publication, so overlapping `apply_patch`/`apply_patch_undo` calls in this runtime serialize and the loser fails at preflight. Text writes use the provider's per-target version check, but removal uses native path-based filesystem operations outside that provider lock. Patch/undo removals pass the expected version into trash and recheck it at entry and immediately before rename or copy-source removal; they do not adopt a newer source version. This is not atomic compare-and-remove: native tools, other runtimes and external writers can still race in the remaining check-to-removal window. Trash additionally snapshots/revalidates ancestor identity, type and realpath, including each EXDEV removal parent, rejecting detected parent-to-symlink swaps. This remains path-based rather than pinned-directory-handle containment: a precisely timed hostile swap after the last check is still outside the guarantees.

All operations are preflighted (coverage, version, context, destinations, removal protection), but publication is sequential: NO multi-file atomicity. A thrown error always means no file changed. Otherwise a private `/tmp/alex-dsh-patch-*` receipt is returned; each operation reports `state` `changed`, `unchanged`, `partial` (move: destination written, source kept) or `uncertain`, decided by re-reading the paths' versions after a failure, plus `not_attempted` paths. There is no automatic rollback. `apply_patch_undo` (same session and runtime only) reverses changed/partial operations newest first, only when post-patch versions still match and original paths are still free; each reports `undo.state` `restored`, `not_restored`, `partial` or `uncertain` and can be retried (uncertain ones need manual recovery). Delete, Move sources and undone Adds go through `trash` (cross-filesystem sources are copied, verified, then removed). `/tmp` is tmpfs: receipts, backups and trash entries are private but lost on reboot.
