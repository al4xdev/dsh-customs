# Contextual agent recovery (immutable v6 entry, owner protocol v1)

The sole custom main-agent retry owner. Every eligible failed attempt gets a
safe `harness warning:` before the next freshly prepared request. The native
`llmRetry` projection is a UI/history mirror, not another retry engine.
Required services: `agents`, `sessionProjections`, and `llmRecoveryHistory`,
with both `recoveryVersion: 2` and `recoveryHistoryVersion: 2`. It is provided
only after the native UI and history2 projections and auxiliary hooks are ready.
Old controllers providing only `llmResilience` or `llmRecovery` cannot prematurely
start v6 when profile HMR visits self-heal before the controller. All three aliases
refer to the same frozen controller; there is no second retry engine.
Incompatible/standalone wiring fails closed.

The shared controller defaults to **ten additional retries**, doubling from
7031.25ms to 3600000ms, without jitter: retry9 waits30min, retry10 waits60min.
Total nominal waiting is7192968.75ms (~1h59m53s), plus request execution time.
An explicit local `{maxCycles: N}` (0..10) can only narrow this one budget;
absence inherits the global policy. Route opt-outs remain authoritative.
No account, provider/model, permission, output-cap or backend setting changes.

Provider settings are sparse overrides, not constrained by the default route's
retry count: base7/provider9 permits9, and base0/provider2 permits2. The shared
admission envelope covers all configured routes; each request still uses its
effective route policy. Explicit legacy `selfHeal.maxCycles` and local caps may
narrow admission. Existing episodes retain their pinned cap even after reload
or a provider increase. An explicitly wrapped older controller2 policy remains
conservative, but the old module alone cannot provide the history2 readiness gate.

## Historical recovery conservation

The derived `llmRecoveryAccounting` projection is **stateVersion2**, forcing a
full native replay instead of restoring an old v1 checkpoint. The native
`llmRetry` and `agentSelfHeal` owner schemas remain **stateVersion1**. Production
recovery reads registered projection state, never scans the Session journal.

Legacy technical spending survives native `step/start` and error/cancel
`turn/end`, even with no old semantic chain. Cumulative retry ordinals count once
per provider/policy/id/turn/step; all routes contribute to one historical floor.
Current UI rows merge by maximum ordinal delta, not by adding that floor again.
The old smallest cap and first captured schedule stay pinned. Unknown or
unbounded provenance fails closed. An owner UI mirror is excluded only when an
accepted reservation matches its exact current position and ordinal as well as
its provider, policy and retry id.

A new turn, goal continuation, warning, empty completion or durable user label
never resets spending. A live root RPC insertion/claim/start may produce the
existing corroborated human-resume receipt, including for a legacy-only floor.
A valid live healthy-step acknowledgement also clears it. Old technical-only
history without an owner receipt may clear only after the strict committed,
nonempty assistant/tool success witness and its correlated completed turn;
`completed` alone is insufficient. Unified owner chains still require their
accepted healthy or human receipt. For example, old9 exhausted retries remain
9/cap9 after error termination and cold reload: autonomous continuation gets no
fresh credits, while a newly verified human resume starts the new ten budget.

## Required persistence protocol (local bridge)

`agent/self-heal` payload version 1 is **required owner state**, not ignorable
telemetry: reservations, dedupe and recovery receipts must survive disk reload.
The upstream installed SDK accepted append but refused these unknown records on
reopen; projection/type registration alone does not change its static catalog.

The audited downstream bridge `install-persistence.mjs` adds only this event to
both static catalog faces of the exact local dsh-cli SDK baseline. It does not
relax unknown-event refusals or change session format/version. The public event
payload contract remains in `types.d.ts`; the plugin owns its reducer. Runtime
`apply` probes the actual persistence validator **before** registering hooks, and
replay refuses unsupported owner versions/actions or invalid state.

```sh
node plugins/agent-self-heal/install-persistence.mjs --apply
node plugins/agent-self-heal/install-persistence.mjs --verify
node --test plugins/agent-self-heal/tests/*.test.mjs
env SELF_HEAL_NATIVE_TASK84=1 node --test plugins/agent-self-heal/tests/persistence.test.mjs
```

The final command opens task_84 read-only, checks its file/lock hashes, and restores the real
projection without a model request. Regular tests use isolated `.dumps/` logs.
Backups and hash-guarded rollback receipts live under
`~/.local/share/dsh-customs-backups/self-heal-persistence-task50/`.
`--rollback` restores only unchanged patched SDK bytes; it makes these sessions
unreadable again and must not be used while the self-heal plugin is enabled.

The Task50 activated entry was `lib/index-v2-persistence.mjs` (full bundle, no old
submodule cache reuse); Task105 uses `lib/index-v3-resilience.mjs` after reviewed
promotion. The original bundle remains untouched for rollback.
`promote-persistence.mjs` preflights SDK and profile hashes, backs
up the profile, then atomically replaces its single pointer. It is intentionally
one-shot. Start a **new DSH process** after installation: existing processes keep
cached SDK modules, and may fail the new preflight on hot reload. No automatic
process restart or live-TTY upgrade is claimed. SDK package reinstall/update can
overwrite the local bridge; re-audit rather than applying to a new unknown hash.
This does not patch the separate npx/web installation or provide portable upstream
support. Owner-absent readers retain the entire recognized log; later plugin
registration refolds it, so a missing checkpoint never grants a fresh budget.

Task_84 is compatible through the reader fix alone: its 23 audits and all original
compressed bytes are preserved. No session rewrite, event deletion or sequence
renumbering is needed; other existing sessions are neither migrated nor deleted.

## Sequence and audit

1. Classify eligible errors before downstream technical listeners. Once owned,
   failure/exhaustion/cancellation never delegates to another retry engine.
2. Require the exact live agent and a public committed `assistant/attempt` end
   frame for the failed turn/step. A failed attempt is already settled; no client
   tool from that failed attempt has been dispatched.
3. Append `agent/self-heal` with `reserved` state, consuming a repair cycle.
4. Append a synthetic `user/message` with source `self-heal-observation`,
   `label: Harness warning`, `form: notice`, and a short fixed summary. It is explicitly
   not a new human prompt. Selected error facts are quoted untrusted data, not
   commands, authority or permission to bypass a restriction. Canonical
   `sourceEventSeqs` links the notice to the prior committed failed attempt.
5. Append `observation-admitted` and the matching native `llm/retry` UI mirror,
   wait through the shared scheduler, append `retry-requested`/`llm/retry-started`,
   check cancellation, and return `{kind: 'retry'}`. Exhausted/invalid-minimum cases
   append an explicit terminal warning and return no action; the native loop
   throws its original `LlmError`, so the failure remains visible.

Additive `recoveryOwnership` envelopes drive the derived `llmRecoveryAccounting`
projection. Historical native spending (all routes) plus semantic spending is
imported once; exact owner-tagged mirrors are excluded. Old pinned caps remain
conservative. This requires no synchronous/deprecated Session log scans, new
required event types, rewritten history or enlarged strict owner-state fields.

`reserved` may carry additive top-level `recoveryWait` metadata (policy, delay,
scheduled time and not-before time). Required event version/actions and strict
state remain unchanged and readable by the older bundle. This records a wait,
not an automatic cross-process wakeup. Aborting a wait never refunds its cycle.

These operations are **not atomic**. Abort or uncertain/failed append prevents
our replay decision and records `aborted`/`append-failed` when possible. A spent
cycle is never refunded. Deduplication uses the failed attempt's durable sequence;
concurrent callbacks cannot admit the same observation twice. On retry the host
re-prepares its provider call and rederives messages from the same session. No
`steer`, inbox wakeup, foreground follow-up or goal continuation is scheduled.

The `agentSelfHeal` checkpoint stays at stateVersion 1, with optional policy-v2
fields so existing spent budgets remain readable. The original episode turn/step,
cycle/cap, failed-seq dedupe, admission references and `lastRecovered` survive
series/surface changes, config increases, reload and old full-state audit replay.
Native witnesses contain only bounded numeric seqs/counters and known enum tags.
Session history deletion or restoring an older external backup cannot be repaired;
the host log/checkpoint participants own persistence, not a universal disk flush.

### Healthy step commit

Native `step/end` contains only `{turn, step}` and is appended in **finally**.
It is not proof of success. A candidate requires a matching `step/start`, one
non-interrupted committed model `assistant/message`, explicit `stop`/`tool-calls`
finish, actionable text or calls, and all requested tool results non-error with
their canonical `sourceEventSeqs: [toolCallSeq]`. Partial/thought-only/empty/
MAX_TOKENS output, missing/duplicate/failed tools, replacements and incomplete
steps do not qualify. This observes results; it never re-executes a CLIENT tool.

The projection stages that witness. Outside publication, a coalesced tracked
microtask checks the exact live agent/session, native candidate and episode,
and public turn signal. Only a matching `recovered` audit with `progress.kind:
'healthy-step'` commits renewal. Abort/error/max-tokens turn termination removes
eligibility; cancellation/disposal before the acknowledgement wins. A fake
healthy snapshot cannot manufacture the native witness. V1 `recovered` receipts
without a progress tuple replay only after the full healthy native step plus
its completed turn and exact legacy causal seq/original recovered-chain snapshot.

### Live human checkpoint resume

A source label `user`, a surface append or a goal continuation is not authority.
The live native inbox insertion must retain **no Agent initiator**, have the
controller's user/RPC source, and match its just-committed `next-turn` splice.
An ephemeral grant is consumed on the matching native claim. Only subsequent
`agent/request` with a real entered `step/start` and live signal can commit a
bounded `manual-resumed` receipt. Discarded/rejected proposals never reach that
boundary. Model/peer-initiated fake user/RPC messages cannot mint a grant.
Pre-step replacement of messages does not erase the already admitted root gesture.

The receipt stores only causal numeric seqs and known enums, not prompt/RPC IDs
or content. `lastManualResume.previousChain` preserves the old spent episode;
`lastRecovered` and failed-seq dedupe are not erased. Old inbox/user labels on
cold replay cannot create new authority; an already committed owned approval
receipt can replay. This assumes trusted kernel/plugin producers, **not
cryptographic authentication of arbitrary privileged JavaScript**. No goal
activation, wakeup, pause/reschedule/rearm or model call is performed by renewal.

## Eligibility and privacy

- Frozen, validated host `PI_AI_ERROR`: diagnostic summary is fixed; the original
  arbitrary message is **discarded**, not regex-redacted into claimed safety.
  An exact reviewed MTMD signature selects fixed image-input-processing facts
  and bounded remediation, without changing the error into a transient class.
  Suffixes, embedded instructions and near-matches stay opaque.
- `SERVER`, `TRANSPORT`, `TIMEOUT`, `RATE_LIMIT` and the first `EMPTY_RESPONSE`
  enter the same contextual budget; there is no prerequisite blind retry.
- `INVALID_REQUEST`: only an exact own Antigravity malformed-function-call marker
  proves the narrow correctable case. Generic invalid request is not eligible.
- Auth, billing denial, context overflow, cancellation, known policy blocks and
  other permanent 4xx facts do not receive a generic bypass. Typed408/429 and
  reviewed AGY reset conditions may use the same finite scheduler. Valid provider
  minima are honored; invalid/over60min minima terminate explicitly, never start
  another engine or pretend that a shorter delay meets the minimum.

The observation/audit selects code, fixed summary, validated status/hint, known
own phase, configured public provider/model family, output cap and nonnegative
integer usage counters. It never copies raw bodies, headers, request options,
causes, stacks, cookies, URLs, account data or hidden thinking content. Foreign
or malformed DTOs/accessors are rejected; unknown route labels are omitted.
Existing upstream logs are not retroactively scrubbed by this plugin.

Other configured routes get process-local ordinal aliases such as
`configured-route-1`: diagnostics can distinguish repeated failures without
publishing private provider/model names or maintaining a model whitelist.
Notices include a fixed diagnostic category/remediation and, where available,
the already-consumed transient retry count. They never replay completed tools.

## Limits and suspension

Default recovery budget is ten retries per consecutive failure episode,
independent of other agents. Raising config cannot enlarge an already active
chain's cap. Exhaustion records `suspended`, then permits the current known host
termination. The durable objective is not completed, blocked or deleted; its
activation may be disarmed by the goal driver. This is a recoverable checkpoint
for an admitted human resume, **not automatic pause/reschedule/rearm**. Proven
healthy progress closes the episode; the next failure starts at cycle one. Ten
retries without progress exhaust a fresh default episode; legacy caps stay pinned. Increasing config,
adding self-observations or reloading never renews that episode by itself.

The same failed step's assembly/tools/rendered prompt remain frozen. A model
cannot fix a tool schema or invalid provider knob that rejects every inference
until an independently approved deterministic fix exists. This middleware does
not change those inputs. Thrown prepareCall, stream-consumer and settlement
exceptions can bypass the public request-error hook; they are not universally
self-healed. Tool-result errors already belong to ordinary agent history. Client
side-effect dispatch is owned by the host loop; hosted/remote effects have no
exactly-once guarantee. Caller cancellation and plugin disposal win.

## Gates

`node --test plugins/agent-self-heal/tests/*.test.mjs` runs pure sanitizer and
ledger gates, with token/cause/directive/hidden-content canaries. Native host,
SDK, projection/notice, tool dispatch, cancellation, reload and goal lifecycle
fixtures are separate principal/e4 deliverables; pure tests do not claim them.
`types.d.ts` declares the public message source, audit event and projection map.
No live provider or real credential is required by these pure tests.
