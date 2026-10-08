# Plan 11 — Native `list` tool (bounded directory listing)

## Problem

Directory discovery currently falls back to shell `ls`/`find`, which pollutes the
context with raw output and inconsistent hidden-file/quoting behavior, or to
`glob`, which returns only files, always walks the whole tree and orders by
modification time. There is no native way to ask "what is in this directory?" at
a controlled depth, so a trivial "what's here?" costs a shell call.

## Owner request

- Add a native `list` tool with the same ergonomics as `read`, so the two are not
  confusable.
- A `depth` parameter, **default 1**: only the immediate entries unless asked
  otherwise, so listing a tree cannot flood context.
- Hidden entries (dotfiles and dot-directories) are listed **by default**, not
  filtered out.

## Tool syntax (locked to the native fs tools)

`list` must read like a sibling of `read`/`write`/`edit`, not like
`glob`/`grep`, so the fs family never becomes two vocabularies:

- `file_path` (string, `required: true`) — deliberately the same parameter name
  `read`/`write`/`edit` use, even though the target is a directory.
- `depth` (integer, optional, default `1`).
- `limit` (integer, optional) — entry cap.
- `hidden` (boolean, optional) — only if the owner wants an opt-out; hidden
  entries are listed by default.
- snake_case names, English descriptions in the same voice as `read`/`write`,
  and the same `output.schema` + `render` contract the other fs tools use.

## Proposed shape (confirm before coding)

- `file_path` resolved against the session cwd by the filesystem backend, exactly
  like `read`.
- Optional `depth` (positive integer, default `1`; `1` = immediate entries only;
  a hard maximum cap).
- Optional `limit` for the entry count, with an explicit truncation signal — a
  capped result must never look complete.
- Directories marked as directories; symlinks not followed into loops.
- Deterministic ordering (name, directories before files) rather than
  modification time.
- Hidden entries included by default; an explicit opt-out (e.g. `hidden: false`)
  only if the owner wants one.
- Output bounded like `read`: entry cap, per-line cap and total-size cap, with
  truncation reported.

## Boundaries

- Names and types only: `read` stays the content tool, `list` never returns file
  bodies.
- No unbounded recursive walk: depth is clamped and the walk is capped.
- No shell; resolve through the filesystem seam so the session sandbox policy
  applies exactly as it does for `read`/`write`.
- No credentials, no environment values, no absolute-path leakage beyond what the
  caller asked for.
- Presentation is optional and stays plugin-side: do not fork the TUI renderer or
  modify installed core (same rule as plan 9).

## Validation

One real harness/TUI operation — an actual `list` call in a directory containing
hidden files and nested subdirectories — with no new mock suites and no
local-model calls. Compare against the equivalent `ls`/`glob` output for the same
directory before calling it done.

## Status

Implemented and owner-requested. `plugins/list/index.mjs` registers the native
`list` tool (`file_path`/`depth`/`limit`/`hidden`; `depth` defaults to 1, hidden
entries included by default; directories-first deterministic ordering;
symlink-loop protection via visited directory identities; capped results report
truncation). Registered in all four persistent profiles and the repo overlay.
Validated with one real headless-DSH tool call against a directory containing
hidden files/directories, a nested subdirectory and a self-referential symlink,
compared with the OS directory listing. Evidence: `.dumps/tasks/11-list-validation/`.
