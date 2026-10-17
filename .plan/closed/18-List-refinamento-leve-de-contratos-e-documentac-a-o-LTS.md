# List: Lightweight Contract Polish and LTS Documentation

## Objective
Continue conservative review for personal LTS starting with the list plugin. MCP remains last. Do not seek new features or rewrite code; use active goal and preserve existing modifications.

## Minimal Scope
- Test the actual definition registered by apply, with in-memory filesystem: path/cwd aliases, arguments and limits, sorting, depth, hidden files, counting and truncation, UTF-8 budget for paths, repeated directories / loops via targetKey, cancellation, backend errors, and output/presentation.
- Add `npm run test:list` and a short README describing observed contracts and limits.
- Keep index.mjs and common.mjs intact, with no new dependencies or model calls.

## LTS Clarifications
Maximum depth 8, maximum limit 1000, and budget of approximately 64 KiB for collected paths. `limit` is a result limit, not a work limit: traversal continues within the requested depth. Avoid promising real sandbox/FS tests: the suite uses the installed defineTool and simulates the backend.

## Acceptance
Tests passing without altering behavior, consistent documentation and command, restricted diff, and valid whitespace. If a test suggests a production change, do not expand scope without discussing with the user. No commit/push.
