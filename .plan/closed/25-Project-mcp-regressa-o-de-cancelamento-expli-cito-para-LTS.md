# Project-mcp: Explicit Cancellation Regression for LTS

## Request and Objective
User authorized adding the recommended test and checking historical suggestions from c_test2. Use active goal to execute and validate.

## Minimal Scope
- Add test in plugins/project-mcp/project-mcp.test.mjs with real DSH client and local SDK builtin.
- Await confirmation that handler started, abort explicitly via AbortController before a long deadline, confirm signal received / no late completion, and connection still usable.
- Local artificial fixture, without real servers, LLM calls, credentials, or production configuration. New artifacts placed in .dumps per convention.
- Update coverage description in README if test passes. No production code changes, new features, or refactorings.
- Inspect c_test2 history to distinguish legacy suggestions from the current review. Extra suggestions are not automatically included in implementation.

## Validation and Acceptance
Run focal test and npm run test:project-mcp, check git diff --check. Report any concrete failure rather than assuming abort propagation; do not alter core/profiles to make test pass. Close plan with evidence once passing. No commit/push.
