# Validate and Integrate Codex WebSocket Fixes in pi-ai Fork

## Objective and Authorized Scope
Integrate relevant Codex transport fixes into fork `/home/alex/git/my/pi`, base v0.87.1+c043ded, preferring cherry-pick and adapting patches per user's explicit authorization. No host deployment, push, publishing, LLM requests, or changes to other providers.

## Selection and Evidence
- Review PR 7648 (head 51ba89acfdd134b8582325ec4ea991ce0faccd23): recovery after metadata before assistant output; evaluate diff and commits, do not indiscriminately apply generic retries for unknown errors.
- Review fitchmultz fork commit 732d7c07f18a739bd7103883b01b272392fd7314: persistent SSE fallback only on 1009, WS recovery on subsequent call.
- Check for other directly related fixes (lifecycle/replay/transport), verify if already present; exclude features and unjustified changes. Merged PR 4133 is already included and must not be reapplied.

## Safe Implementation
1. Verify clean tree, preserve reasoning fix and current refs. Fetch candidate refs without moving working branch.
2. Create isolated review worktree/branch under workspace `.dumps/pi-ai-fork/`. Thoroughly inspect target files and local rules; do not overwrite other changes.
3. Run offline baseline of focused tests. Apply candidate via cherry-pick without immediate commit in review worktree where appropriate; resolve only authorized files. Adjust tests/patch before committing.
4. Distinguish observed metadata from assistant output; any text/refusal/reasoning/tool block, even empty or encrypted signature, prevents replay. Maintain a single start/terminal, clear attempt state when recoverable, fresh connection / full history, and bounded recovery with cancellation respected.
5. Protect missing_previous_response retry against replay after output; do not globally ignore 1000 closure. Evaluate sticky SSE change only on 1009 separately, preserving diagnostics/cancellation and lifecycle tests.
6. Run focused mock tests and `npm run check` according to pi rules; no E2E/live. Prove regression failures on baseline when possible and success on patch, without unnecessarily modifying dependencies or catalog metadata.
7. Commit only own paths explicitly, preserving authorship/provenance of cherry-picks; after validation integrate commits to original personal branch via cherry-pick if tree remains clean. If tree changes, stop instead of overwriting. Record commits/results and keep review branch recoverable.

## Acceptance Criteria
- Metadata+close1000 recovers before output; text/reasoning/tool/customtool, even empty, never repeat.
- Completed/done/incomplete+close1000 does not become an extra failure; cancellation does not retry.
- Missing_previous after content does not duplicate output; asserts for request count / start / terminal and partial preservation.
- Sticky SSE and discarded connection have relevant tests; pre-existing TTL/age/reuse continue passing.
- Reasoning fix preserved, offline tests and check pass; working tree/commits reported. Active goal used for tracking. Installed host remains unchanged; deployment is a separate step.
