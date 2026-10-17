# session_create — creation in the dsh-tui host

**Current public contract:** [PROFILE-CREATION.md](./PROFILE-CREATION.md) (plan129).
The Companion owner approves and journals; an already-open compatible **dsh-tui**
bridge creates and owns the standard Agent. No public fallback to Companion.
Skills activation and native catalog delivery are covered separately by plan128.

The task83 sections below document the retained **internal legacy provisioning**
implementation and its fixture tests, not the current public tool. In particular,
`composeFrom(companion)` and `new_project` below are NOT the new public behavior.

## Native contracts and mounting proposal

`owner.mjs` is a companion **HOST/root** public Cordis Service. It uses native
`agents.create` with unpublished setup/publication commit; exact public
`agentPresets.composeFrom(childCtx, callerCtx)` retains the caller's preset revision.
The returned native root handles belong to the owner, not the caller, TUI or
subagent hierarchy. An originating caller disposal does not dispose these roots.
Owner teardown invalidates proofs and drains/disposes handles; disposal is NOT
transcript deletion. Ordinary Android `CompanionSessionController.create` is unchanged.

`index.mjs` is available only in a companion preset scope. `composition-proposal.mjs`
exports a root row and separate preset-child row, not an activation function or
whole-profile replacement. Append to the current composition only after parent's
safe boundary. Preserve model defaults, credentials, transport, ports and other rows.
Default ledger is `~/.dsh/session-create` and root is the dedicated workspace;
constructors do no filesystem writes. All fixtures override them into `.dumps/tasks`.

SDK contract: installed `@deepseek-ai/*` **0.2.0-rc.2**, public declarations/exports only.
No SQL, internal registry fields, synthetic native header rewriting or TUI opening.
`selectModel`, `selectDefaultModel`, `initializeDefaultModel` and `saveSelection`
are deliberately absent: native `selectModel` also persists a global default.

## Arguments (JSON Schema is authoritative)

```json
{
  "operation": "create",
  "request": {
    "version": 1,
    "owner_intent": "Create a separate project for owner request",
    "target": { "kind": "new_project", "name": "MyProject" },
    "delivery": { "mode": "empty" },
    "idempotency_key": "stable-request-1"
  }
}
```

Operations: `help`/`capabilities`, `status` with `operation_id`, and `create` with
closed `request`. Raw ToolDefinition uses a closed root, unlike `defineTool`'s
implicit open root; parser independently rejects extra fields, accessors and malformed
objects. Supported schema subset is type/properties/required/additionalProperties,
oneOf/const/enum/description; byte bounds and semantic conditions are enforced by parser.
No `confirmed`, `grant`, sandbox/cwd override or caller-chosen destination session ID.

- Default delivery **empty**, target **current**. Empty means no prompt, draft or
  model dispatch. It is not a saved task. `submit` requires full nonblank `text`
  (16 KiB UTF-8) and may execute Agent/consume quota as soon as admitted.
- `current`: the proven caller cwd, either dedicated root or an already-authorized
  live projects child. A sibling root in the same native project receives its own
  freshly approved incarnation proof; this never rewrites the Android controller.
- `new_project`: single ASCII `name`, default path `dedicatedRoot/projects/name`.
  Optional supplied `path` must equal that path. Default `directory:create_child`
  refuses an existing target; `must_exist` registers an existing canonical directory,
  refusing an existing registry project. Missing `projects` container creation is
  explicit in the prepared preview. No recursive arbitrary-host mkdir.
- `existing_project`: exact native workspace ID, dedicated root or direct approved
  projects child; requires canonical existing directory and the scoped guard seam.
- Preset is companion. Optional model must equal the current effective route/effort.
  Defaults and UI selection are never saved or modified. Newly created model selection
  is live-pinned; **empty cold-resume binding is unproven**, reported explicitly.
- Owner intent/names/paths reject unsafe controls. Submission text is never normalized
  or truncated; unpaired UTF-16 is rejected because UTF-8 transport would replace it.

## Native approval before effects

The body performs readonly preflight, creates an immutable prepared intent with
caller+callId, canonical path/inode facts, IDs minted by host, delivery/literal,
preset document hash/exact retained caller revision, effective model, caller policy,
new-session permission default and host authority epoch. It then calls the public
`ApprovalService.request` once, before ledger, directory, project, Agent, association
or prompt effects. Only `allowed-once` reaches commit. A pre-execute middleware `allow`
cannot bypass the body gate. No cached approval or caller-provided authorization token.

Preview is a complete reversible JSON representation: trusted fields precede the
initial text; ASCII controls/newlines and every invisible/format character (shared
`plugins/session/approval-text.mjs`) are escaped. Tags, bidi controls, private use and
CR are refused by the parser before any approval.
Original prompt UTF-8 length and SHA256 accompany the full text. The actual queued
text stays exactly literal. Approval audit (`asked`/`decided`) is an intentional native
effect; it is not project/session provisioning. Never/rejected/cancelled/unavailable,
missing service, late grant after abort and readonly preflight failures give no business effects.

**Trust limitation:** SDK outcomes do not cryptographically attest human origin.
The curated host answerer chain and legitimate UI are part of the trust boundary;
any trusted in-process plugin can implement an answerer. This plugin adds no automatic
answerer and never replays saved approval. It does not claim protection against a
malicious host plugin. Android already displays full literal reason with scrolling
and separately reachable buttons; no Android source change is needed. Web may later
use public `conversation.approval.detail` for structured presentation; no frontend edited.

## Scoped writable authority (not a global grant)

The root owner privately owns a WeakMap. Public `sessionCreateAuthority` exposes:

- `attachGuard({workspaceRoot,revision:1}) -> disposer`: trusted guard lifecycle
  handshake, not a grant. Deferred public `ctx.inject` supports standing preset mounts
  activated before the optional root owner.
- `allows(exec, policy) -> boolean`: exact live Agent `=== agents.get(id)`, Session
  and immutable header object identity, native companion preset/header, exact canonical
  direct-child cwd, committed intent hash, current epoch and core workspace-write root.
  Fresh synchronous lstat/realpath checks of the three approved directories close the
  long Native Bash ASK wait before the final synchronous ToolGuard decision.
- `validate(exec, policy) -> Promise<boolean>`: also rechecks canonical nonlinked root,
  container and child dev/ino facts; drift revokes the live proof.
- `capabilities()`: readiness/epoch/root only, no mint/recovery/token method.

Only root-private approved publication commits mint proofs. Guard uses a per-execution
WeakMap after asynchronous validation; skipped hook, stale epoch, sibling/legacy agent,
ID reuse, forged kwargs, danger-full-access, policy-root mismatch and cold reconstructed
header do not count as authority. Native canonical FS containment still applies.
Original dedicated-root behavior and legacy reads remain; unproven mutations deny.
Child Bash still prepares full native confinement and always returns Native ASK with
its exact scoped cwd/literal; no background/escalation/auto grant changes.

Cold resume by ID or saved ledger does **not** recreate authority. This version safely
denies child mutations after owner restart until a separate explicitly approved recovery
path exists; persisted proof material is evidence, never a reusable approval grant.

## Fences, durability and honest partial/UNKNOWN semantics

Owner serializes approval+provisioning. After allowed-once, revalidation runs after awaits
and before every stage. Publication has a synchronous caller/model/permission/epoch fence.
The exact model is scoped; future-session permission default must remain workspace-write+ask,
not a silently escalated or readonly default. Filesystem facts are rechecked and symlink
ancestors rejected. Native operations remain path-based: **not TOCTOU-free against hostile
external OS actors**. No fd/openat or cross-store atomicity is invented.

A private file ledger starts only after approval/revalidation. `owner.lock` is exclusive
across processes and records the owner's pid and kernel start ticks; an existing lock fails
closed, without takeover/deletion: `ledger_owner_held` for a live (or unverifiable legacy)
owner, `ledger_owner_dead` naming the dead pid and operation for owner-directed recovery. Atomic
per-record writes use file fsync+rename+directory fsync. Every stage records a durable
starting marker before its SDK effect and confirmation after its receipt. Native session
flush must explicitly report a successful durability barrier. This is NOT a transaction
covering directory+workspace+session+attach+prompt.

Idempotency key binds caller identity/incarnation metadata and normalized request hash;
same key/different literal conflicts, same key/same request returns receipts without asking
or executing again. IDs alone never authorize native adoption, resume or send. Native prompt
request ID dedup is supplemented by request hash. `queue`, never steer/interrupt, targets
only the newly minted exact live session. Accepted != completed.

Failure/crash after a stage starts or a native service throws can leave UNKNOWN effects.
Starting records are UNKNOWN on readonly status/restart. `TOOL_OUTCOME_UNKNOWN` and lost
receipts must not trigger retries. Status is caller-bound and uses readonly journal reads;
no Agent activation or model. No automatic continuation after restart or old grant reuse.
A stale lock requires owner-directed recovery, not guessed PID/lease freedom. A stage
whose action proves it never reached its destination (`noEffect`) is journaled as
`not_started` instead of UNKNOWN; anything ambiguous stays UNKNOWN.

Default compensation is **keep and report**: directory, native project record, session,
association and submission are distinct effects. No rm, rename of reused projects, archive,
delete, stop or cancel compensation. A publication failure can still leave directories or
project records. Archive would preserve transcript/accounting and may write before activity
stops; it is not rollback of accepted submission. Root handles are retained after uncertain
published effects; child proof is revoked on failed provisioning.

## Validation (authored isolated fixtures only)

```fish
node --test plugins/session-create/*.test.mjs plugins/companion-workspace/guard-policy.test.mjs plugins/companion-workspace/index.test.mjs plugins/companion-workspace/project-authority.test.mjs plugins/companion-workspace/session-controller.test.mjs tools/session-companion/profile.test.mjs
```

Pure fixtures cover parser, no grants/escalation, all non-grants, literal escaping/hash,
actual synthetic folders, concurrent idempotency, defaults intact, drift, symlink boundaries,
incarnation/epoch, stage fault injection, attach/submit UNKNOWN and restart lock/journal.
Native fixture boots the **installed public SDK** in synthetic `.dumps/tasks/task83-native-*`
home: real Agent/session persistence/workspace membership, exact schema, native approval
and FS. HTTP/Connection disabled: **no listening port**. An authored unavailable public
fileUploads seam replaces transport metadata only; create/persistence/project/FS owners
are native. Every model dispatch throws; calls must remain zero. Native fixture only creates
empty sessions; pure submit fixture uses an authored stub receipt, never an Agent/model run.
Synthetic answerer is confined to that test Context and placed before absent Remote UI.
It checks pre-allow bypass, rejected/never zero effects, new writable project, outside/symlink
and foreign same-cwd denial, and native root lifetime after originating caller disposal.
No existing user home/history, production profile/session/project or real model is exercised.
The fixture does create real native Agent/workspace objects, but only inside its authored synthetic home.
