# Fix Global Self-Heal Materialized by Native Schema

## Reproduced Cause
In Alex Tavern bd1e8bdc-94ff-41fc-ba8b-f6b478e1f3ef: attempt 17056 TRANSPORT; audit 17057 observed only; warning 17058 recovery stopped retry 0/max 10; turn/end 17060 error. Read-only replay confirms budget 0/10, safe and without restrictive historical pin. Pure planner admits the failure.

The ACTUAL call to the exported schema `Config({})` from plugins/llm-resilience/index.mjs materializes `policy.retryableCodes:[]` and `auxiliary.replaySafePurposes:[]` via implicit Schemastery defaults. resolveConfig interprets these lists as explicit choices and disables all eligibility, for ANY provider. This explains the 0/10 refusal. It is not a failure specific to Codex/GPT or a proven quota issue. Previous direct apply tests did not go through this normalization.

## Implementation
1. Fix the global schema to distinguish list absence from an explicit empty list, including sparse provider patches and auxiliary replay-safe purpose. Preserve explicit opt-outs, unknown field validation, limits, and other defaults.
2. Regressions against the actually applied schema and Cordis/plugin loading, with a generic provider: SERVER and TRANSPORT receive warning and fresh preparation; empty configuration preserves seven codes and two safe purposes; explicit [] continues disabling, sparse providers do not receive artificial fields.
3. Publish only new immutable controller v5; keep owner v6 and protocols/history/accounting unchanged. Do not edit historic v4/v6 bundles or closed evidence from task 112.
4. Update builder, manifest, migration/inventory/installation, and necessary documentation/tests for target 5/6, preserving data and concurrent changes from other tasks.

## Validation and Publishing
Run relevant full tests and offline acceptance with real SDK/caller and simulated HTTP (no paid calls), including schema-normalized configuration. Qualify the five profiles in an isolated DSH_HOME comparing models/permissions/compaction and unrelated configuration against CURRENT bytes. Make private backups and switch only controller URI 4 to 5, one file per operation, with hashes/modes and drift protection. Verify published files and normalized configuration. Functional rollback preserves controller4/owner6 without erasing provenance.

## Constraints
No further Continue, process restarts, backend/model/sampling/SDK changes, tool replays, budget resets, limit increases, or auth/cancel/permanent bypasses. Do not infer update of already imported namespace without evidence. No indiscriminate commits.
