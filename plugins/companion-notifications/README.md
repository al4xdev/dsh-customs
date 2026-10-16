# Companion native-goal notification mock (task 99)

**Prepared source only; not activated by these files. No FCM, network, Firebase, HA, TUI or global overlay integration.**

Goals remain entirely native DSH SDK `0.2.0-rc.2`: host `@deepseek-ai/dsh-goal` and `@deepseek-ai/dsh-goal-round-driver`. No companion-goal wrapper, goal database or scheduler is needed. The web bundle disables host model-facing goal controls and instructions; the proposed Companion preset adds the existing native `dsh-tool-goal`, `dsh-command-goal`, `dsh-agent-instructions`, and this mock. Do not enable them globally or regenerate the existing profile from a template.

## Public source contract

Installed SDK root: `${XDG_DATA_HOME:-~/.local/share}/dsh-cli/node_modules/@deepseek-ai/` (tests resolve it through `plugins/session/host-paths.mjs`).

- `dsh-goal/lib/types/domain.d.ts:67-89`: real scoped `goal/changed` event `{ agent, change: { operation, ref, goal? } }`; its matching session `goal/change` is already committed, listener failures contained. Native durable phase is **`complete`**, not `completed`.
- `dsh-goal/lib/index.js:858-877`: native commit appends, projects and then emits. `foldGoal`, `GoalService.get()` and actual Agent registry identity supply source/transition proof; the mock maintains no goal projection of its own.
- `dsh-goal-round-driver/lib/index.js:54-362`: native driver owns checkpointing, idle admission, source `{kind:'goal',goalId,revision,round}`, cancellation, CAS races, exhaustion and teardown/disarm. This plugin never schedules work.
- `dsh-tool-goal/lib/index.js:27-79,195-196,351-360`: exact live root-human or matching admitted goal-round authority. A resumed active goal is disarmed and requires a human rearm. The model tool **cannot resume paused goals**, even in a human turn; native `/goal resume` or the human GoalService remote control must do that. Native blocked threshold defaults to three; the proposal makes three explicit. The model must additionally verify the *same concrete blocker* persisted, as instructed.
- `dsh-web-app/cordis.patch.yml:490-497,549-550`: native service/driver stay host-side, command/tool/instruction loader move into presets.
- `dsh-agent-instructions/lib/index.js:561-578,1122-1144,1271-1287`: instruction discovery uses the immutable **session header cwd**, not the backend process cwd. Future Companion target is `~/git/my/dsh-companion-workspace/AGENTS.md`; absent at audit time. The scratch proposal copies only the observed global **Plan mode and goals** section verbatim, plus native-specific policy. Native default discovery can also include `$DSH_HOME/AGENTS.md`; no global file is modified or copied in full.

## Mock fences and persistence

Mount requires explicit config `{profile:'companion'}`, real `profileContext.name==='companion'`, and a native preset/Agent scope. Emission additionally requires exact live root Agent/session identity, Companion immutable header and live composed preset, matching scope ancestry, no delegated/seeded fork session, exact current `GoalView` and ref, and a real last committed `goal/change` completion with a strict native replay-proven preceding nonterminal revision. Reply text and UI strings are never inputs.

Only `operation:'complete'` can notify. Edit (including terminal edits), pause, block, resume, rejected mutations, foreign scopes, stale events and plain replay cannot create another delivery. Dedup key includes profile/session/native goal id/**completion revision**.

Payload is strictly `{version:1,eventId,goalId,revision,sessionId,phase:'completed',timestamp}`. No title, objective/body, paths, tool data, transcript, model, credentials or auth information. `timestamp` is the native mutation time; `eventId` is a deterministic SHA-256 identity, not a fabricated SDK event type.

The mock delivery **is** the atomic append to `<profileContext.dir>/companion-notifications/mock-v1.json`: an own ledger, unrelated to the native session database/index. File mode 0600; directory 0700; symlinked directory/leaf rejected. Synchronous lock + fsync + same-directory atomic replace serialize mounts/processes and avoid separate delivery/dedup transactions. There is no remote side effect. `MockSink.deliver(payload)` is the narrow idempotent adapter seam; any future external adapter/outbox needs separate authorization and implementation.

Bounds: **256 deliveries**, **512 KiB** maximum input/output. At capacity, fail closed without evicting old dedup keys. Exceptions log only a fixed sanitized warning; native completion is not reverted, resurrected or retried indefinitely. There are no automatic retries. A repeated actual completion notification can retry only its own idempotent delivery. A crash-held `.lock` fails closed: an operator may remove it only while Companion is stopped after reviewing the mock ledger. Do not delete/reset the ledger merely to clear capacity or corruption; doing so loses durable dedup history.

## Validation and activation boundary

```text
node --test plugins/companion-notifications/*.test.mjs .dumps/tasks/task99-composition.test.mjs
```

Tests use the actual installed public SDK with authored isolated roots under `.dumps/tasks/task99-*`, actual AgentLoop/GoalService/preset/event/fold/driver/instruction hooks and no model/network/ports. The driver race test proves an exact **queued** native continuation and stale-round rejection, **not** an admitted autonomous model turn (`roundsStarted` stays zero). Unit sinks are not production notification proof. These tests do not prove the live Companion GoalService client round trip; executor98 must do that after Parent review.

Review artifacts: `.dumps/tasks/task99-candidate.cordis.patch.yml`, `task99-AGENTS.proposal.md`, `task99-composition-proof.json`, `task99-alltests.tap`, `task99-FREEZE.json`, and `task99-source-report.md`. Candidate is anchored to the task97 applied profile hash and inverse-deepEqual preserves every existing patch/composed row, Settings and model selection. If the baseline or target AGENTS changes, stop and re-review; never overwrite unrelated content. The loading test uses an inline synthetic proposal fixture, so it no longer needs the local (gitignored) `.dumps` artifact.

Only executor98 may STOP Companion, back up fresh state, apply the reviewed minimal delta/AGENTS, START Companion and test actual authenticated human-source get/create/rearm/admitted round/complete plus the one mock record. Live activation, auth/bootstrap, Settings writes and real model calls are intentionally absent here.
