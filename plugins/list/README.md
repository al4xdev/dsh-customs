# List — Contract for Personal LTS

Lists names and types without reading file contents. Relative paths use the session
cwd. `file_path` and `path` are aliases; when both are supplied, `file_path` takes precedence.
A non-empty path is required.

## Preserved Behavior

- `depth`: default 1, maximum 8; depth 1 lists only immediate children.
- `limit`: default 200, maximum 1000. Both require positive integers.
- Hidden entries are included by default. `hidden: false` also prevents traversing
  hidden subdirectories.
- Inside each directory, order is directories, files, and other types; within each group,
  names use `localeCompare`. Recursion happens while visiting each directory, not as a
  global tree sort.
- Displayed paths are relative to the requested root; directories append `/`.
- A single directory, identified by backend `targetKey`, is traversed only once. Its
  aliases still appear in the listing.
- Collection respects a 64 KiB budget for UTF-8 paths and separators, beyond the entry limit.
  This budget excludes header and footer.
- Capped results report the count and display a `capped` notice, never appearing complete.

**Result cap is not a work cap:** the tool continues traversing the requested depth to
compute `total`, even after hitting `limit` or path byte budget. For large directory trees,
reduce `depth` or select a subfolder. `total` accounts for hidden-entry filtering and recursion
deduplication; it is not a universal count of all possible filesystem paths.

## Regression

From the repository root, run `npm run test:list`.

The 13 tests use the native `defineTool` definition of the installed DSH and an in-memory
backend. They cover arguments, defaults, cwd, sorting, depth, hidden entries, limits,
repeated identities, cancellation, errors, rendering, and system prompt guidance.
They do not use models, credentials, or actual filesystem operations. They do not replace
backend integration, sandbox, or real symlink tests.

This refinement adds documentation and tests without modifying `index.mjs` or `common.mjs`,
and without installing new dependencies.
