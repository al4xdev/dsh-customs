# Companion: File-Based Discovery and Detailed Navigation

## Agreed Scope

The Companion session tool observes main DSH/TUI conversations, excluding its own conversations and subagents. The user authorized implementing: useful list via recent files, selective literal search, and deep reading, without changing send, which already works.

## Implementation

1. Catalog files in the configured public root using readdir/stat, without decoding all conversations. Select supported generation per session, reject symlinks, and do not open arbitrary paths. Classify by header: Companion excluded; subagent origin / positive delegationDepth excluded; parentSession alone does not exclude continuation. Insufficient metadata explicitly marked unknown. Filter before counting limit, supporting 50+ subagents.
2. list default 10 main sessions by mtime, limit, and pagination. Current title (latest session/title, including user rename), ID/cwd/mtime, and useful preview only for selected items. Cache bounded by identity/stat; no mandatory SQLite. Changes from another session must not invalidate all pagination; preserve filters and explicit snapshot.
3. find as literal operation (search compatible): default 100 recent main files, adjustable with explicit ceilings/budgets. Streaming/reading only over the selected set, results referenced by session/seq, limits per call and continuation. Do not promise entire history.
4. read/context/inspect: useful event pages, head/tail/seq, and before/after navigation. Readable format and JSON option for selected events. Allow drilling down into tool arguments, results, and errors, with excerpts/pagination for long content. Redact credentials; no entire file automatically nor arbitrary payload outside the root. Log data remains untrusted.
5. Preserve send/resume and approval/origin/bridge gates. Active state remains separate from mtime. Do not create a separate subagent surface; main delegations remain navigable in the log.
6. Update contracts, tool description, and documentation. Backward compatibility with existing parameters where possible; explicit limits/cursor semantics.

## Validation

- Tests for main/continuation/fork sessions, 50+ subagents and Companion, rename, file generation, mtime, caches, zstd logs, and concurrent writing.
- Literal search in only N main sessions, pagination, and explicit coverage.
- Navigation of long results/arguments/JSON, redaction, recoverable truncation, errors, and output limits.
- Regression tests for session, routing, and send/resume without weakening controls.
- Read-only smoke test on real logs via SDK/tool input; compact summary in .dumps. Without restarting services or sending messages unprompted.

## Execution

Guided by active goal. Separate physical catalog and event reading for independent delegation; integrate and validate before closing. Do not alter other concurrent work.
