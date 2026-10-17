# Managed-plans: Organize with O, Blocked Category, and Session Goal Resumption

## Consolidated Request
- `O` should organize the plan by choosing destination, not be a shortcut dedicated to reopening.
- Add `blocked` classification for work halted by a dependency, separate from goal status. Do not create a dependency engine.
- When manually approving a tasks plan, resume the **current goal of the approving session** if paused/blocked. Do not link to the old goal from plan creation: the user explicitly expects goal changes.
- Apply small documentation/resumption and shell-reconsider recommendations. Use active goal to guide execution; preserve earlier modifications.

## Organization and Compatibility
1. Add blocked to recognized destinations, schemas, presentation, and browser. Blocked is save-only, without execution authorization while in that category. Moving does not create/unblock goals.
2. `O` opens a compact selector: Tasks / Backlog / Blocked / Owner decisions / Closed, with Enter to confirm and Esc to cancel, preserving TUI semantic tokens and monospace style. Store draft, identity/revision/hash, and idempotency.
3. Authenticated human organization operation: approved can change category; staged/rejected change proposed destination without approval. Closed or imports moved back to tasks generate a new staged revision with identical content and same plan_id, preserving history and requiring new approval. This detail is made explicit in the selector; do not reuse old approval from a closed plan.
4. Closed as a destination archives/cancels via human action; it does not declare a task completed or fabricate evidence. Existing reopening API remains available to the agent, without a mandatory dedicated key.
5. Additive migration: create blocked directory on normal initialization, keep SQLite state and existing revisions compatible; do not manually edit mirrors/registry or invent approval for imported content.

## Approval and Goal
- Optional integration with existing `ctx.get('goals')` service; do not modify core or make the service mandatory.
- Only real root human command, after CAS authorizing tasks approval. UI indicates that it resumes the session's paused/blocked goal. Rejection, save-only, autoApprove, and background notifications do not resume goals.
- Capture host snapshot of current goal before approving; enqueue and persist the approved instruction before calling `goals.resume(agent,{id,revision})`.
- After awaits, revalidate session/live/id/revision/phase and budget. If changed, completed, already active, or exhausted, do not resume or retry silently. Already saved approval remains valid; return value shows separate resumption status.
- Do not use model's update_goal for paused goals or fabricate command/user events. The real human approval action is the authority, as requested by the user.

## Recommendations and Regressions
- Document consistent backup of the entire .plan directory, including .state/store.sqlite, and .agents/config.json with runtime stopped to a persistent destination; do not copy user data in this work.
- Test flush/ack failure during delivery and resumption after reopening store, without duplication, in artificial fixtures in .dumps.
- Adjust three documentation phrases for shell-reconsider: read without reconsideration, permit bound to all args, here-doc as heuristic.
- Run suites for config/store/native registry, new organization and goal contracts, viewer/cards with real renderer, and existing LTS test set. Do not claim manual testing of installed TUI or absolute power-loss protection.

## Division of Work
Store/organization and its tests by one subagent; goals helper and tests by another. Main agent integrates index/TUI/presentation/documentation/scripts/browser tests and final review. Each agent edits only assigned files.

## Acceptance
O chooses destination, blocked does not authorize execution, closed→tasks does not inherit approval, approval→resume touches only the human session's current goal with CAS and durable order, tests pass, and no core/credentials/profiles are altered. Reload/restart required for already loaded runtime. No commit/push.
