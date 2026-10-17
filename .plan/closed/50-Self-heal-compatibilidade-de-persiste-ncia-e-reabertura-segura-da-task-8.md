# Self-heal: persistence compatibility and safe reopening of task_84

## Objective and authorization
Fix the plugin and its local persistence integration; restore the ability to open session `e8d530cf-b66a-46c9-82f2-272317e6f0ce` from `/home/alex/git/my/alex-tavern` (task_84). The user authorized updating only this session and requested the safest solution. Do not delete or modify other sessions. Use the active goal as completion criteria.

## Confirmed diagnosis
The plugin records `agent/self-heal` as a mandatory event. The installed SDK permits append, but its static catalog does not recognize this event when loading from disk. The log for task_84 contains 23 of these events, starting at seq 6976. The dsh-tui configuration points to `plugins/agent-self-heal/lib/index-v2.mjs`. Registering a projection does not alter the catalog. The `ignorable` field is unsuitable without proof of safe omission: these records preserve consumed budget and causal receipts, not merely informational messages.

## Proposed implementation
1. Confirm APIs and independent review; record hashes of involved files and repository state. Preserve others' changes.
2. Implement a static, reproducible local integration restricted to the SDK installation at `/home/alex/.local/share/dsh-cli`: include exclusively `agent/self-heal` in the vocabulary of the `@deepseek-ai/dsh-session` build, while maintaining rejection of other unknown events. Keep effective bundle `lib/index.js` and catalog output `lib/types/known-event-types.js` synchronized. The downstream patch must remain versionable in this repository, with preflight by hashes/context, durable backup, verifiable application, and rollback that refuses to overwrite subsequent changes. Do not alter permissions, retries, pi-ai, credentials, or npx/web installation.
3. Fix the plugin with an explicit check of reader compatibility before registering middleware / recording new audits: on an incompatible SDK, fail clearly without creating further unreadable sessions. Do not mutate internal Sets at runtime or rename events to unrelated native types. Recompile into a new bundle with complete internal dependencies and promote the dsh-tui pointer only after validation; preserve stateVersion 1, V2 policy, and maxCycles 3.
4. Preserve mandatory events, sequences, and recovery data. For task_84, prefer NOT rewriting anything: the corrected reader must accept its existing events. Make a verified backup of the compressed file prior to final validation and record before/after hashes. Only if investigation demonstrates a real need for migration, submit a specific revision before altering history.

## Tests and evidence
- Current pure tests of the plugin and relevant contracts.
- Negative test: original SDK rejects agent/self-heal; plugin detects incompatibility before hooks/audits.
- Positive test: corrected SDK accepts recognized mandatory event, but continues rejecting other unknown mandatory events.
- Real round-trip with installed JSONL/zstd backend in isolated `.dumps/` workspace, not just in-memory Session: append, flush, close, new instance/process, load.
- Projection replay preserves spent budget, deduplication, and V1/V2 recovery; exhausted episode does not gain cycles via reload. Messages, sourceEventSeqs, and audits are not removed.
- Real read-only reading of task_84 and replay with V2 plugin; all 23 audits and all events remain, original file hashes identical.
- Document local scope and requirement for a new TUI process: older processes keep ESM modules in cache. Do not restart or kill other processes automatically.

## Publication and conclusion
Publish only approved artifacts and local SDK/profile with backups and integrity receipts; keep temporary fixtures and reports in `.dumps/`, durable backups outside `/tmp`. Do not promise upgrading all already open processes. Close plan and goal only after proving round-trip and native reading of task_84 with state preservation, reporting any remaining manual steps.
