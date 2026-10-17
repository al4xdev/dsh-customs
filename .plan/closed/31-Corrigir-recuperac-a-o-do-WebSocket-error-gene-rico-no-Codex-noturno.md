# Fix recovery of generic WebSocket error in overnight Codex

## Objective and evidence
Fix the failure category that interrupted alex-tavern on 2026-10-13 01:01:18: `turn/end` with `PI_AI_ERROR` / `WebSocket error`, without retry, resumed manually at 07:11. Use the goal in this session to guide implementation and validation after approval; complete only with verified evidence.

Installed code confirmed: pi-ai produces exactly `WebSocket error` if the event does not report a cause; the adapter does not recognize `socket` within `WebSocket`; current middleware accepts only closes 1000/1012. There was no exhaustion of the official budget.

## Chosen fix and scope
Modify only `plugins/codex-transient-close/index.mjs`, its tests/fixture, and README. Add the message **exactly** `WebSocket error` to TRANSPORT normalization, exclusively on requests marked by the same host as normal loop, provider openai-codex, purpose absent, finish error PI_AI_ERROR, and signal not aborted. Maintain exclusion of HTTP 4xx statuses, including auth/quota/oversize, and qualified/permanent messages. Preserve chunk facts, replay metadata, and original code in out-of-scope streams. No custom retry: official policy unchanged, five additional retries with existing backoff/cancellation/audit.

Do not modify the pi-ai fork, installed node_modules, providers, credentials, recipes/pins, or budget. Do not apply a generic regex `/WebSocket/`, global retryable PI_AI_ERROR, `always`, or infinite retries. The H3 request-buffer-limit error remains fail-fast and outside this task. Compaction/title remain excluded.

### Explicit tradeoff
The generic message lost its cause; it does not prove transience nor allow guaranteed distinction between transport and opaque handshake. Exact, bounded recovery attempts to re-establish the conversation without broadening known auth/quota/policy/oversize messages. If the opaque error persists, six attempts in total end the turn. Do not promise uninterrupted overnight execution, exactly-once remote side effects, or general LTS. Preserving structured cause in the fork is a separate future improvement, not inventing non-existent information.

## Tests/gates
1. Add a specific test reproducing the original failure without the plugin: same generic message, zero retry, and zero CLIENT tool.
2. Add generic recovery in the actual official loop, with a fake adapter without network, incomplete and complete tool chunks: failed stream/backoff execute zero tools; success executes only the tool from the successful attempt; partial history does not enter the next request and attempt IDs are fresh.
3. Test persistent generic WS: six attempts, five retry/retry-started pairs; exhaustion, reset between turns, concurrency/reload, cancel, and dispose without unexpected retry or tool execution.
4. Expand negative matrix for the generic message: unmarked requests, other providers, purpose compaction/title, cancellation, other codes, 4xx; messages with prefix/suffix, newline/CR, auth/quota/policy/oversize, and request-buffer-limit remain untouched. Re-run closes 1000/1012 regressions and official defaults.
5. Run `node --test plugins/codex-transient-close/codex-transient-close.test.mjs`, `npm run test:lts:contracts`, syntax/diff check, and read-only verification of current wiring `node tools/activate.mjs --check --profile dsh-tui`. If check indicates pre-existing drift, record and do not write profiles incidentally.
6. Update README with scope, risk of opaque error, evidence, and activation. Store logs/local receipt in `.dumps`, without private data in Git. Review diff to preserve others' changes.

## Activation, rollback, and boundaries
The dsh-tui profile already points to the local module; editing its source affects future loads. Do not restart or reload processes/sessions automatically. Report that a new process or supported explicit reload is required to use the new code; a persisted session can be resumed. Do not make paid live calls or run overnight tests incidentally. Do not touch Tavern/H3 history. Rollback for the change is the targeted reversal of the plugin diff, tests, and README; do not use task26 tarball rollback. No commit/push/publication in this task.

## Acceptance
Offline regression of the real message goes through bounded official retry, negatives remain fail-fast, LTS contracts green, restricted diff, accurate documentation, and activation instructions without stopping existing agents. A subsequent controlled overnight run remains an operational gate for LTS, not a requirement to declare this classification fix implemented.
