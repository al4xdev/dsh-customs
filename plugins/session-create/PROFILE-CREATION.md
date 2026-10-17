# session_create: dsh-tui Target (Plan 129)

## What was Fixed

The public tool remains scoped to Companion, but its owner no longer calls `agents.create` inside the Companion process. It prepares the request, requests native `allowed-once` approval, and sends a signed authorization to a compatible bridge in the **already running dsh-tui host**. The host resolves/mounts its `standard` preset, uses its actual model and policies, and keeps the new handle root-owned. It does not copy caller preset, does not change the active tab, and does not fabricate origin by simply altering headers.

The legacy internal implementation (`controller.mjs`/`provisioner.mjs`) remains for explicitly identified legacy tests; it is not a fallback for the public owner.

## Usage

Tool arguments for **session_create**, not the `session` tool:

```json
{"operation":"capabilities"}
```

The response includes `destination_profile:dsh-tui`, `preset:standard`, `hosts`, `available`, `new_project:false`, and limits. When multiple hosts exist, choose an exact returned `host_id`. Do not arbitrarily pick the first PID. Without a compatible host, it returns `destination_host_unavailable` prior to approval/creation: opening/reloading a TUI with an updated bridge is required. The existence of an older channel that only supports send does not prove create support.

```json
{"operation":"create","request":{"version":1,"owner_intent":"Create a separate session in dsh-tui for user request","target":{"kind":"current"},"delivery":{"mode":"empty"},"idempotency_key":"request-123"}}
```

With multiple hosts, add `request.host_id` with the real ID. `request.profile` and `request.preset`, when provided, accept only `dsh-tui` and `standard`. `preset:companion` is rejected, not reinterpreted.

`delivery:empty` is default: creates/persists session without executing prompt/draft/model. `delivery:{mode:submit,text:...}` requires non-empty literal text up to 16 KiB UTF-8 and admits the task for execution. Approval displays full reversibly escaped text, with `initial_text_utf8_bytes`, `initial_text_sha256`, and invisible character count. CRLF becomes LF before card rendering, hash, and dispatch (approved literal is delivered literal). Unicode tags (U+E0000–E007F), bidi controls, private use, isolated CR, and other controls (except LF/TAB) are refused (`invalid_text`) before approval across all text fields: human owner would not see them, but target agent would read them. Rare legitimate invisibles (ZWJ, ZWSP, BOM, variation selectors) pass, always displayed as `\uXXXX`. Admission ACK and provisioning `status:completed` do not mean task completion.

Default model is that of destination host. `request.model` is an optional exact assertion of model/provider/effort, not arbitrary selection or copy from Companion. No global default is saved.

## Policies and Boundaries

Companion approval remains strictly `allowed-once`, even if destination has `approval:never`. Confirmation displays profile, host, model, cwd, preset, and actual destination policies. If dsh-tui uses `danger-full-access/never`, that is declared as broad future execution without tool approvals; it is neither concealed nor silently replaced by another policy.

- `current`: proven caller cwd, inside dedicated workspace or authorized child.
- `existing_project`: exact native project existing within authorized boundary, with revalidated facts across both hosts.
- `new_project`: **unavailable** in this version and therefore **excluded from advertised schema** to model (internal parser still recognizes it to explicitly reject). Native registration API is create-or-reuse and does not prove exclusive ownership of new project; tool does not adopt race outcomes or invent `created:true`. Returns `new_project_unavailable`, without creation/approval. Do not create directories/projects via another route to bypass refusal.

Description and schema avoid internal jargon: "dedicated Companion workspace" is the root folder (`~/git/my/dsh-companion-workspace`); `existing_project` is the ID of an already registered DSH project whose folder sits directly in `projects/` of that workspace. "Human owner" is always the person; internal `*Owner` services do not appear in model text.

Target host maintains session independently from caller Companion. Caller cancellation/disconnect after dispatch does not kill target session. Closing owner host drains/closes only its handles. No guarantee of preserving model across cold resume of an empty session: binding is live-pinned and this limitation remains explicit.

## Protocol and Integrity

- `list` announces `capabilities.createProfile` without creation side-effects.
- `prepare-create` is read-only and records bounded/ephemeral preparation, with proposal hash, profile, preset, model, policy, configuration, modules, and path facts.
- `create-session` requires its own grant, separate from send grant, with MAC over process/bridge identity, preparation/hash, nonce, and TTL. Preparation includes IDs and literals; no accepted `confirmed`/grant fields from model.
- Host revalidates before effects, publication, and admission. Fences block unapproved requests/tools during startup.
- Durable journal and reservation prior to effect; nonces and IDs are not reused as authorization. Preparation may expire while awaiting approval: explicit error, without replaying stale approval.
- Response loss after dispatch is UNKNOWN, never confirmation that nothing occurred. `status` reads caller receipt; does not re-execute. No auto-retry, destructive rollback, delete/archive, or removal of uncertain locks.
- Only responses that **prove absence of effect** become `not_started` (without `recovery_required`): local failure prior to sending frame (`retrySafe:true`: cancellation, unavailable key, unreachable bridge) or authenticated destination rejection before opening its own ledger (`effect:none`). Receipt stays in journal; same key returns that receipt, without retry.
- `owner.lock` records `pid`+`startTime` (kernel ticks). Live process lock: `ledger_owner_held`; dead process lock (PID absent or reused): `ledger_owner_dead`, with PID and operation, prompting verification of `status` and **manual** removal by human owner. No automated takeover. Older lock without verifiable owner remains `ledger_owner_held`.
- Bridge does not execute queued request whose socket already closed or whose deadline (3s, or 30s for creation) passed; creation host `close()` is bounded (5s per step) and always clears fences.

Ledgers: owner Companion in `~/.dsh/session-create/profile-dsh-tui`; destination in `<bridge-root>/profile-create-ledger`. Do not migrate legacy receipts or reuse saved approvals. `operation_id` is scoped to caller. Creation IPC timeout is 30s; timeout does not cancel already admitted effect. Send/read retain prior protocols and limits.

## Skills in Companion (Plan 128)

Web bundle disables global `skill-filesystem` and `tool-skill`. Both were added **inside Companion preset**, in installed profile and generator, without changing model/permissions. Provider uses `customSkillDirs` targeting `~/git/my/dsh-companion-workspace/.agents/skills`, even when session resides in child project with its own `.git`. `tool-skill` itself delivers tool and `skill-catalog` message.

Original instructions file is `~/.dsh/AGENTS-Companion.md`. `~/.dsh/Companion/AGENTS.md` is its necessary symlink to loader, not a duplicate copy.

## Validation and Activation

```sh
env SESSION_RESUME_REAL=0 node --test plugins/session/*.test.mjs plugins/session-create/*.test.mjs tools/session-companion/profile.test.mjs tools/session-companion/companion-skills.native.test.mjs
```

Fixtures use isolated storage/identities and fake adapter, without calls to external models. They cover owner approval, closed contracts, ambiguities, invalid profiles, tampering/replay/drift, UNKNOWN, SDK AgentLoop/preset/policies/writer, and real Unix IPC creation. Target fixture is a synthetic dsh-tui profile with mounted real standard preset, not a full boot of user-installed plugin inventory.

Skills test validates tool schemas, four public API calls, and `skill-catalog` in initial fake request, across root and child repo. This is stronger than merely finding files with an isolated provider, but does not claim inspection of every already-open session.

No restart was forced. Companion profile live-reloads config; TUI processes with legacy bridges require fresh launch. Read-only probe in `.dumps/companion-guides/live-capabilities.json` recorded zero compatible hosts at that instant. No production session was created/sent to test activation.
