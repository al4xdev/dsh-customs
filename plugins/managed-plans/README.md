# Project plan artifacts — not native Plan mode

This plugin owns `.plan` Markdown artifacts, review, revision history and the
project-plan browser. `plan_stage` creates/revises an artifact directly. It does
**not** enter the Harness's native Plan mode, select a permission preset, impose
a read-only sandbox, or append `plan/mode` events. The native `planMode` service
and `dsh-plan-mode` projection are not dependencies. No `exit_plan_mode` alias is
registered; use `plan_stage`.

Normal Cordis tool/command, session persistence, inbox delivery, prompt and sandbox
services remain infrastructure; they are not native planning semantics. The
plugin's artifact approval policy is distinct from permission Auto and the goal
round driver. Autoapproving a plan does not grant shell permissions, arm goals,
keep the runtime running, or guarantee days of unattended execution.

## Own project configuration

This is a **dsh-customs convention**, not a native DSH configuration schema:

```json
{
  "dshCustoms": {
    "managedPlans": {
      "autoApprove": true
    }
  }
}
```

Save it as `<initial canonical workspace>/.agents/config.json`, beside the
workspace's `.plan` root. We read this exact file, not a home/global config or
parent directory. It is separate from `.agents/mcp.json`. Other JSON keys and
namespaces are preserved when changing this preference.

- `autoApprove: true`: each new `plan_stage` revision is approved automatically
  with an `autonomous` audit actor. An approved `tasks` revision may execute
  without stopping for review. `backlog`, `blocked` and `para-o-dono` are saved only.
- `false`: new revisions await owner review; submitting that artifact concludes
  the turn. This review boundary does not turn the entire session into native
  Plan mode or change its permissions.
- If absent, the plugin's `autonomousByDefault` is the fallback (normally false).
  A configured false overrides a true fallback.
- The preference is project/workspace-wide, re-read at submission, shared by
  sessions bound to that workspace, and retained across restarts. It is not an
  ephemeral per-process Map or a copied fork/session flag.
- `/plan auto on`, `/plan auto off` and `/plan auto status` operate on this project
  preference. Status reports the file, scope, source and actual boolean. The
  command accepts writes only from an authenticated root-owner invocation with
  writable roots covering the config file. Delegated sessions cannot change it.
- Malformed JSON/namespaces/booleans fail visibly. The file is limited to 1 MiB;
  config file symlinks and `.agents` escapes are refused. Treat this project
  configuration as owner-controlled policy, not untrusted instructions.
- Writes publish a complete replacement JSON file. This is not a filesystem
  sandbox, hard power-loss durability guarantee, or a multiwriter compare-and-swap
  transaction: coordinate simultaneous external config edits.

The native `auto` permission setting does not enable this preference. Changing
this preference does not change native permissions.

## Artifact workflow

- `plan_stage`: create/revise numbered Markdown with exact-revision approval.
- `plan_list` / `plan_read`: read the catalog, feedback and immutable history.
- `plan_move`: organize approved artifacts; never approve a staged proposal.
- `plan_close`: complete approved tasks or record approved owner decisions, with
  the exact current revision and evidence. **Any session in the same anchored
  workspace may close authorized work**, regardless of which session created it.
  Origin remains provenance, not a perpetual ownership lock. Repeating the same
  closure is idempotent; stale revisions, unapproved/imported artifacts and
  missing evidence remain rejected. Imported Markdown needs a fresh reviewed
  revision; filenames alone do not constitute execution approval.
- `plan_reopen`: exact-copy proposal in a fresh staged revision. Old approval is
  not inherited, even with autoApprove on; reopening still awaits review. It
  does not activate native Plan mode. If fresh content is ready for autonomous
  review, submit it through `plan_stage`, not an inherited-approval shortcut.
- `/plan`: opens the **project artifact browser**, not a native mode picker.
- `/plan new <request>`: queues a request to create an artifact using the tool;
  it does not select a mode.
- Browser `O` opens a destination picker: Tasks, Backlog, Blocked, Owner decisions,
  or Closed. Use arrows and Enter to move, Esc to cancel. It does not wake a goal.
  Approved artifacts retain their approval while changing category; staged or
  rejected artifacts only change their proposed destination. Moving from Closed,
  or moving imported content into Tasks, creates an exact-copy staged revision
  with the same plan_id and requires new approval. Closed as a destination
  archives/cancels; it never claims completed work or fabricates evidence.
- `blocked` is a plan category for interrupted work/dependencies, **not a goal
  phase**. It preserves approved work but does not authorize execution while in
  that category. Moving it back to Tasks restores the existing approved revision;
  moving a still-staged blocked proposal never approves it. No dependency graph or
  automatic dependency resolution is introduced.

Review notifications go to the authenticated session that performed the review,
not an offline historical creator. The source origin and old decisions remain
unchanged. Child model tools resolve their root owner's workspace; arbitrary
cwd changes cannot retarget the store. Other workspace catalogs remain separate.
Cancellation and review/comment authority are still authenticated human command
operations, not model-supplied actor flags.

## Human approval and the current session goal

Human `y` approval of a new Tasks revision also resumes the **current goal of
that approving session** when its phase is `paused` or `blocked`. This uses the
existing optional `goals` service, like the native human `/goal resume` command;
it does not ask the model to call `update_goal`, spoof a human message or patch
native policy. There is deliberately no binding to the goal from plan creation.

The host captures the current session/goal/revision before approval, persists the
approved instruction before resuming, and rechecks that exact snapshot without
retry. A changed goal/revision/phase/budget, exhausted budget, cancellation or
pending delivery skips resume; absent/failed goal services leave approval valid
and return a separate `goal_resume` status. Active or completed goals are not
changed. Repeating an already-saved decision does not restart a freshly paused
goal. Rejection, save-only categories, autoApprove, organization, reopening and
background notification delivery never resume goals. If resume is skipped or
fails, inspect the notice and use the native `/goal resume` explicitly if needed.

Waiting for review is already represented by `waiting_for_owner` and the turn
boundary. This plugin does not manufacture goal `paused`/`blocked` transitions
when creating a plan. Plan approval and native goal/permission states stay distinct.

## Long-running goal context

When native `agents`, optional `goals` and runtime-context
(`systemPrompt.context`) capabilities are present, prompt assembly includes one
short snapshot after five hours of observed active execution:

> Continuous autonomous execution: 5h 20m. Open tasks in this project (not closed): 7.

A monotonic process-local counter charges only entered execution steps while the
exact live runtime root is running with an active, armed goal. It covers model
calls and tools, not goal age; idle/pre-step gaps between automatic rounds are
excluded without resetting the sequence. Prompt assembly occurs before the next
step starts, so it can display time already settled by previous steps.

Human messages/replies, requested approvals and questions reset the sequence;
foreground human waits never accrue time, including overlapping requests and
native service-only questions. A timed pending question ends foreground waiting,
so subsequent independent work can start a new sequence. Pause, block, completion,
disarm, goal replacement, execution errors/aborts and disposal also reset it.
Same-goal edits preserve the counter. Ownership uses runtime roots, not historical
session lineage: an independently resumed fork is eligible, an owned child is not.

This is **observed execution time, not provider GPU/CPU compute or proof of useful
progress**: provider/network waits and stuck tools inside an executing step can
still count until cancelled/failed. Approval audit brackets are treated
conservatively as interruptions even if a request is rejected immediately.
Restart, hot reload or loss of optional capabilities starts observation afresh;
historical/offline time is never inferred or reconstructed. No scheduled timer,
inbox message, goal mutation, wakeup or execution authority is introduced.
The snapshot is refreshed on each assembly, not accumulated in conversation
history. Ineligible goals and foreground waits omit it.

The count uses a fresh read-only catalog of the session's anchored project and
includes every artifact not closed (tasks, backlog, blocked, owner decisions and
staging), regardless of approval status. Missing capabilities, suppressed runtime
context or failed reads omit the notice without breaking tools or prompt assembly.
Restart/reload the runtime to pick up this source change.

## Backup for the personal LTS

With all runtimes using the workspace stopped, copy the **entire `.plan` tree**,
including `.state/store.sqlite`, plus `.agents/config.json` if present, to a
persistent backup location. Markdown mirrors alone do not preserve revision,
decision, comment, notification or idempotency history. Do not copy only the
SQLite file while it is being written; this is not a live-backup tool. `/tmp` and
`.dumps/` are not durable backup destinations. Before a runtime upgrade, retain
the working Node/DSH/frontend versions and check a restored copy in an isolated
workspace. No production backup or restore was performed by these tests.

## TUI separation and loading

The custom frontend's `externalPlanCommand: true` opt-in routes `/plan` to these
artifacts. The native planning plugin must not be loaded in the same composition
with the same `/plan` command; the promoted local profile already disables it.
The browser explicitly labels project artifacts, not native Plan mode. Updating
source does not change an already-instantiated plugin or installed frontend
artifact: reload/restart the appropriate runtime, and rebuild/publish the
frontend through its separate local tooling when frontend source changes.

## Focused verification

```fish
npm run test:managed-plans
```

Uses temporary `.dumps` workspaces, real SQLite plan stores and native tool/command
registries, without model calls or production profile/database mutation. Covers
config persistence/preservation/guards, cross-session closure and review routing,
imported/stale/unapproved denial, delegated workspace binding, organization and
blocked transitions, exact goal resume guards, and notification flush/ack recovery
without duplicate delivery. It checks zero native Plan-mode/permission mutations.
Session/persistence adapters control failure injection; these are not proof of
power-loss atomicity across the plan database and native session logs.

Frontend/source rendering regressions are separate. From `frontend/dsh-tui`, run
`node --import tsx/esm ../../tools/task10-profile/viewer-check.mjs` and
`node --import tsx/esm ../../tools/task10-profile/presentation-check.mjs`.
They exercise the actual renderer with controlled input/channel boundaries,
including the destination picker and narrow terminal. They do not replace a
manual smoke check of the installed runtime after restart.
