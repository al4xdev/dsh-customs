# Task 10 — Managed .plan lifecycle and TUI plan artifacts

## Status and authorization

Design approved by the owner. Engine/store/tools and the artifact scene are implemented; the pinned frontend source has the opt-in /plan route and public native Markdown API. The real isolated engine lifecycle passed, including revision conflicts and save-only categories. Per the owner's request, activation now targets the **default `dsh-tui` profile**: native `plan-mode` is disabled there, the two managed-plan plugins are inserted through the central manifest, and the patched frontend (pinned v0.14.0 commit `c2eee952`) is installed as a local file dependency. A real-profile activation check confirmed all five tools and the `managedPlans` service register. The owner performs the TUI validation personally, so visual/keyboard end-to-end acceptance remains pending and no completion is claimed. All confirmed interview decisions below remain the implementation contract.

## Architecture

- DSH core is the engine: authoritative plan lifecycle, tools, persistence, numbering, revision checks and owner decisions.
- dsh-tui is the frontend: `/plan`, list/navigation, read-only Markdown artifact viewer, line comments and owner approval/rejection.
- Replace the native plan-mode plugin reversibly through profile composition, using its implementation as the base/reference. Do not edit installed node_modules. Preserve session-mode persistence, step boundaries and root/child behavior where appropriate; adapt review semantics deliberately.
- Keep the current frontend's styling/rendering conventions. This is an artifact workflow inside the terminal, not a new web frontend or a duplicate planning engine.
- `.dumps/` remains ephemeral scratch. Durable plans, comments, decisions and recovery metadata must NOT live there. This task focuses on `.plan/`.

## Owner decisions confirmed

1. Anchor `.plan` to the immutable initial working directory where the owner opened the session. **Do not use the Git root** and do not change it because a tool uses workdir/path or a shell runs cd.
2. The agent proposes the category from the conversation; the category is visible before approval.
3. `y` approves the exact proposed revision. Category `tasks` authorizes execution; `backlog` and `para-o-dono` only save/register and never start implementation.
4. `n` keeps the same plan number in staging, records the rejection and comments, and requests a revised proposal. It does not authorize execution.
5. Preserve revision/comment history. A new revision requires a new approval.
6. Multiple plans may be staged; decisions always identify the selected plan and its exact revision.
7. Comments are saved as drafts. Esc saves/returns without sending anything to the agent. Only rejection (`n`) sends them and asks for revision.
8. Keep the exact command `/plan`. The owner approved a small frontend routing change/extension seam rather than settling for `/plans` or `/plan browse`.
9. Enter opens the selected artifact; Markdown is not editable by the owner in this view. Cursor navigation and adding/editing comment text are distinct from modifying the plan.
10. Core tools allocate numeric prefixes and move files. The agent supplies intent/content/plan ids, never chooses a filename/index or runs filesystem moves for the lifecycle.
11. Closing is a core operation that moves the plan to existing canonical `.plan/closed/`, not `.plan/closes/`.
12. Rejection without comments records the decision and waits for the owner's instructions; no speculative automatic rewriting.
13. `/plan new <request>` and a `Novo plano` list action enter the custom planning flow. Bare `/plan` stays the browser.
14. First version: answer saved `para-o-dono` questions in chat and record the answer/decision; no separate artifact answer composer.

## Canonical directories

```text
.plan/
├── staging/       # Proposed revisions waiting for owner review
├── backlog/       # Approved future work; no execution grant
├── tasks/         # Approved actionable work
├── para-o-dono/   # Approved owner questions/decisions or blocked matters
├── closed/        # Completed/decided/explicitly cancelled records
└── .state/        # Proposed durable registry, history, comments and journal
```

The exact internal metadata layout is an implementation detail still under review; stable readable Markdown remains the primary human artifact. No extra planning directory outside `.plan/` is introduced.

## Findings from the installed implementation

### Core: @deepseek-ai/dsh-plan-mode, DSH 0.2.0-rc.2

- Native plan mode does **not** write/stage a Markdown file. It keeps mode state in session events/projections and the submitted Markdown in tool-call history.
- `exit_plan_mode` presents full Markdown using `ctx.userQuestions.ask` with `plan-review` intent, not the permission approval service.
- Approved review exits at an accepted step boundary; rejection sends free-text feedback; dismissed review waits for user takeover. The native pending interactive question is not a durable project review queue.
- Permission policy (`ask`/`never`) and plan review are independent. `approval: never` must never auto-approve or auto-reject the managed plan domain.
- Native plan mode is guidance, not a filesystem sandbox. Do not claim that mode alone blocks shell/MCP writes.
- Disable profile entry `plan-mode` before registering a global replacement to avoid duplicate tools/commands/services. Use a new command definition identity instead of falsely claiming native ownership.
- Session append is not a crash-durability boundary; the persistence flush and plan-store commits need explicit ordering/reconciliation.

Source: installed `@deepseek-ai/dsh-plan-mode/{README.md,lib/index.js}`, core commands/session/projection/userQuestions packages.

### Frontend: dsh-tui 0.14.0

- Full-screen `ctx.tuiScenes` is a supported addon seam with injected host React, terminal UI primitives, channel and close callback. Use this for list/view/comment states and local key handling.
- Bare `/plan` is hardcoded to the current PlanPicker before channel submit. `tui/input` cannot intercept it. A real frontend routing extension/change is required for exact `/plan`.
- Native Markdown already renders terminal text, tables/code and selected Mermaid families. Mermaid is terminal Unicode rendering, not a full browser SVG implementation; unsupported/error/too-wide diagrams need a visible source fallback.
- The internal Markdown component is not currently a public scene UI export and has no source-line/cursor/comment mapping. A small frontend API enhancement is needed to reuse it cleanly; do not import private internals by hardcoded absolute paths as the stable solution.
- Terminal wrapped rows are not Markdown source lines. Persist anchors to immutable source revision/hash and 1-based source line/range plus quoted context. Diagrams/tables can anchor their whole source block; resize must not retarget comments.
- `PanelHostApi.sendToChat` is a stub, not a delivery channel. An active scene also bypasses ordinary chat dialog rendering, so comment composition must be within the scene rather than assuming the generic input modal appears above it.

Source: installed dsh-tui `lib/types/{screens/Chat.js,dsh-adapter/scenes.d.ts,dsh-adapter/ports/channel-ui.d.ts,components/Markdown.js,components/MermaidDiagram.js}` and public package exports.

## Proposed engine contract

Keep a small model-facing surface:

- `plan_stage(title, plan, category, plan_id?, expected_revision?)`: create or revise a proposed Markdown plan; category is exactly `backlog`, `tasks` or `para-o-dono`. Always stages before review; returns assigned id/revision/status without granting execution. Reclassification uses this same revision-bound operation, not an unreviewed move tool.
- `plan_list(category?, status?)`: list plans with category/status/title/revision and whether owner review is pending.
- `plan_read(plan_id, revision?, offset?, limit?)`: read a selected plan/revision and relevant review feedback; allow bounded source-line windows rather than requiring full history reads.
- `plan_close(plan_id, expected_revision, outcome, reason, evidence?)`: core-validated closure/move; outcome distinguishes completed work, recorded owner decision and explicit cancellation. Never return a filesystem move recipe.

Retain `exit_plan_mode(plan, ...)` only as a compatibility adapter to the same staged submission, with no duplicate approval authority and no automatic execution from its name. The custom guidance points primarily to `plan_stage`; the original native plugin is disabled before the adapter is registered. A submitted plan ends the planning turn awaiting the owner rather than pretending the mode already exited.

Use `para-o-dono` to preserve explicit questions and decisions that should not get lost in chat. Complement native asking tools rather than treating approval of a question document as the answer to its questions.

Human-only frontend/command actions (not self-approval tools): save comment, approve, reject and explicitly cancel. Every action carries plan id, revision, content hash and expected state. The server verifies actual owner authority; a model-supplied `actor: user` field is not authorization.

## Lifecycle and execution

```text
agent proposal -> staging(id, revision, category)
                   | y + tasks -> tasks + execution authorization
                   | y + backlog -> backlog (save only)
                   | y + para-o-dono -> para-o-dono (save only)
                   | n + draft comments -> rejected revision retained
                   |                       -> agent revision, same id
                   |                       -> staging(new revision)
approved plan -> core closure operation -> closed
```

- Approval refers to content **and** proposed category, not a mutable path. Changing either invalidates approval.
- Review can outlive the chat turn; staging should not require a live interactive question or block forever in a tool while multiple artifacts are queued.
- Persist the decision before acknowledging it. Deliver a clear correlated user instruction/result to the originating root session; children may propose but cannot review as the owner.
- Rejection delivers comment ids, source anchors, source excerpts and revision/hash. If the originating agent is busy/offline, retain a durable pending notice and deliver at a safe session boundary/resume, not an uncorrelated background mutation.
- Direct `/plan off` or a plain conversational acknowledgement must not grant execution of unapproved managed work.
- Existing approved content cannot be silently replaced. Progress bookkeeping should not accidentally invalidate the approved document or rewrite its scope.

## Numbering, files and persistence

- One cross-process lock per initial workspace; different sessions opened in the same directory share catalog and counter. Subdirectories are separate workspaces unless opened with that directory explicitly as their initial root.
- Harness allocates monotonic numeric ids, never reuses them, and uses stable id plus revision. Counter reservations may leave gaps after crashes; do not promise gapless numbering.
- Idempotency prevents retried submit/decision operations from allocating duplicates or performing moves twice.
- Validate all target identities and paths; reject traversal, symlink escapes, collisions and overwrites. File operations remain inside the anchored `.plan` tree.
- Atomic publication and a journal/reconciliation strategy cover interrupted allocation/moves/decisions. Filesystem changes and session log events are not assumed multi-resource atomic.
- Before importing current plans, define which filenames are actual numeric prefixes; do not mistake the date-prefixed closed record for plan id 2026. Preserve existing filenames/content unless migration is explicitly approved.
- Core ownership of file moves is a workflow guarantee; preventing arbitrary shell/MCP bypass is a separate filesystem-policy question, not a promise implicit in this plugin.

## TUI interaction proposal

- `/plan` opens a full-screen plan list, emphasizing staging and showing all categories. Initial focus can prefer the newest pending item without hiding others.
- Up/down (optional j/k) navigate; Enter opens; Esc viewer -> list; Esc list -> chat.
- Artifact view reuses native Markdown style after adding a supported export/source-map seam. Selected source line/range is visible; comment marks never imply editable Markdown.
- A dedicated in-scene comment composer accepts text; saving persists a sidecar draft against the exact revision. Esc from composer cancels that composer, not the entire artifact.
- In the list, `y`/`n` act only on a reviewable staged item. Clearly display target category and execution consequences before acceptance. Show stale-review/duplicate/busy errors explicitly.
- `n` saves and sends drafted comments with the rejection. With no comments, record rejection and wait for the owner's instructions; never invent reasons or start an automatic alternative.
- Comments on old revisions remain in history. Do not automatically retarget them to changed text without showing that they are stale/rebased.

## Safe initial transition rules

- Saved backlog/owner work promoted to tasks is staged with its existing id and proposed category, then requires a fresh y. No model tool can elevate a save-only approval into execution.
- Close approved tasks after completion evidence; close approved para-o-dono after its answer/decision is recorded. Explicitly cancelling backlog/staging requires the owner's instruction, not an autonomous dismissal of a rejection.
- Source revision, category and hash are immutable approval inputs. Progress/answers/comments are separate durable records; a scope/content change goes through a staged revision.
- Owner review/browser remains read-only for Markdown. Model staging is the only normal content-update operation; core owns naming and moves.

## Frontend source and minimal integration change

The installed package identifies its maintained repository as `https://github.com/ccch1mneyyy/dsh-TUI.git`, version 0.14.0. Locate an existing maintained checkout first; if none exists, use a dedicated versioned source checkout pinned to the installed version and a reversible development-profile package override. Never patch the installed bundle directly.

Add opt-in command-presentation metadata distinguishing native mode-picker from an external plan command. Bare `/plan` routes the custom command to its scene, while native deployments retain their picker. Add a supported native Markdown renderer export/source-map seam for the artifact viewer; reuse host React and existing terminal renderers. The frontend package change stays separate from the DSH engine plugin.

Initial implementation should not include a generic artifact platform, a web UI, a replacement filesystem toolbox, .dumps lifecycle tools, manual Markdown editing or a custom Mermaid renderer.

## Delivery boundaries

1. Resolve interview questions and review the complete task 10 plan.
2. Implement engine store/tools/review authority as a reversible plugin.
3. Add the minimal frontend routing/Markdown extension seams in its maintained source and implement the addon scene.
4. Activate only in an isolated profile first; keep a recovery path to native plan mode.
5. Validate one real flow directly in the harness/TUI: stage -> open -> comment -> reject -> revised same id -> approve as tasks -> close. Check save-only categories and stale revision once. No large mock/test project and no local-model calls unless the owner explicitly asks.
6. Update AGENTS.md plan guidance only after the replacement is active; preserve `.dumps` rules and other preferences.
