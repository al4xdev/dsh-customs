# Apply-patch: Regression Contracts for Personal LTS

## Intent
Small final polish for personal LTS, not a bug hunt or rewrite. Preserve all production behavior and existing modifications. Guide work using active goal.

## Observation
The plugin already documents exact context, sandbox limits, prior reading, partial results, and undo. No dedicated routine was found in package.json or tool scripts guarding the pure modules of this plugin.

## Minimal Change
1. Add a `node:test` test file for existing contracts: parser (Add/Delete/Move, context/anchors, ambiguity, EOF, newline, and insertion), per-session read coverage, and presentation of valid receipts (success, partial, undo).
2. Add `npm run test:apply-patch`, without new dependencies or model calls.
3. Add the command, covered contracts, and limitations to reference: pure tests do not exercise real writes, recovery, sandbox, or filesystem races.

## Out of Scope
No changes to index.mjs, parser.mjs, observation.mjs, or presentation.mjs; no migration, new feature, new policy, or review of other plugins. No commit/push.

## Acceptance
Dedicated routine passing, changes limited to tests/command/documentation and whitespace verification. Do not declare these tests as complete filesystem validation. If a test requires changing production behavior, stop that item and discuss with the user before expanding scope.
