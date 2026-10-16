# Contextual agent recovery (immutable v7 entry, owner protocol v2 / policy 3)

The sole custom main-agent retry owner, provider-agnostic: it acts only on
canonical typed failure facts (`code`, `status`, `providerRetryAfterMs`), so any
adapter benefits without a provider branch. The **first** eligible failure of a
chain gets a short `harness warning:` before the next freshly prepared request;
later cycles of the same chain add a new notice only when the error code changes.
The native `llmRetry` projection is a UI/history mirror, not another retry engine.
Required services: `agents`, `sessionProjections` and **`llmRecoveryUnbounded`**
(`recoveryVersion: 3`, `recoveryHistoryVersion: 3`). Controller6 publishes only
that name, after the native UI and accounting-v3 projections and auxiliary hooks
are ready; contract-2 controllers (`llmResilience`/`llmRecovery`/
`llmRecoveryHistory`) never start this owner, and owner6 never binds to
controller6, so a half-migrated profile waits instead of mixing durable schemas.
Incompatible/standalone wiring fails closed.

**Agents never stop on transient failures.** The shared controller has no retry
count limit by default. The first ten waits keep the reviewed scale (7031.25ms
doubling, no jitter: retry9 30min, retry10 60min, ~1h59m53s in total); every
later retry keeps waiting at the 60-minute cap, indefinitely, until a healthy
step closes the chain, the caller cancels or the plugin is disposed. Terminal
classes (auth, billing quota, credentials, other 4xx, cancellation, policy,
context) are still never retried. An explicit owner opt-out (registered
`{mode:'normal', maxRetries:0}`, `policy.maxRetries: 0` or a route `0`) and any
explicit finite cap (`policy`/route `maxRetries: N`, legacy `selfHeal.maxCycles`
or this plugin's `{maxCycles: N}`) are honored exactly. No account,
provider/model, permission, output-cap or backend setting changes.

Provider settings are sparse overrides, not constrained by the default route's
retry count: base7/provider9 permits9, and base0/provider2 permits2. The shared
admission envelope covers all configured routes; each request still uses its
effective route policy. Explicit legacy `selfHeal.maxCycles` and local caps may
narrow admission. Existing episodes retain their pinned cap even after reload
or a provider increase: a chain started by owner6 keeps its finite cap10 until a
healthy step or a live human resume closes it; only new chains are unbounded.

**Provider minima.** A valid `providerRetryAfterMs` (Retry-After, an adapter's
typed quota-reset hint) extends the local interval, never shortens it, up to the
controller's `maxProviderWaitMs` (default and maximum 24h). The agent therefore
waits until the indicated reset instead of suspending at 60 minutes. A minimum
above that ceiling suspends visibly (retrying earlier would not satisfy it). A
malformed, zero or negative hint is not terminal: it is ignored (logged) and the
local schedule applies. The Antigravity adapter supplies its reset as exactly
such a typed fact (`ANTIGRAVITY_QUOTA_RESET` + hint, or `..._LIMIT` above its own
`quotaResetRetry.maxWaitMs`); the controller remains the only wait/budget owner.

## Historical recovery conservation

The derived `llmRecoveryAccounting` projection is **stateVersion3** (uncapped
ordinals, a bounded sliding mirror window, fixed `unsafeReason`), forcing a full
native replay instead of restoring an older checkpoint whose init implied cap10.
The native `llmRetry` and `agentSelfHeal` owner schemas remain **stateVersion1**:
owner state only widened (unbounded `cycle`/`maxCycles`, optional `warnedCode`/
`warnings`, `policyVersion` 2 or 3), so every older checkpoint still parses.
Production recovery reads registered projection state, never scans the Session journal.

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

`agent/self-heal` payloads are **required owner state**, not ignorable telemetry:
reservations, dedupe and recovery receipts must survive disk reload. Owner7
writes payload **version 2** (state `policyVersion: 3`) and reads versions 1 and
2; anything newer is refused rather than turned into a fresh budget.

**Rollback to owner6/controller5 after owner7 has written audits is not a safe
downgrade** (same precedent as the V2 persistence change): owner6 refuses payload
v2, policy 3, cycles above ten and the new chain fields, so such sessions stop
reopening under the old pair. Roll back only sessions/processes that never ran
the new pair, or keep owner7/controller6 for those sessions.

**Manual rollback (one-way, never automatic):**
1. Close every DSH process (TUI, web, headless, Companion host).
2. Run `node tools/resilience/scan-retry-ordinals.mjs` (read-only). Its `ownerV2`
   list names the sessions already written by owner7; under owner6 they fail to
   reopen. If any matter, do not roll back: fix forward instead.
3. Revert the manifest/migrator targets first (`plugins/activation.json` and
   `RESILIENCE_MODULES` in `tools/resilience/profile.mjs` back to
   `llm-resilience/lib/index-v5-unified.mjs` / `agent-self-heal/lib/index-v6-unified.mjs`);
   otherwise `tools/activate.mjs --write` migrates the profiles straight back to
   v6/v7. Then switch the two module paths in each profile's `cordis.patch.yml`
   (by hand or with activate) and start new processes.
4. Never edit, truncate or "downgrade" session logs or audits; owner7-written
   sessions stay readable only by owner7. Re-upgrading later is safe.

**Sessions already broken by owner6.** Owner6 mirrored a chain that continued
into another step or turn (after a failed tool step, or a cancelled turn followed
by an autonomous continuation) under its chain-wide `retryId` and ordinal. The
native v4 reader then refuses the stored log on reopen with
`SessionFormatError: llm/retry skips its policy attempt sequence` (wrapped in
"stored log is corrupt"); the live process kept working until restart. Owner7
does not create new ones, but cannot fix existing logs. Detect them with
`node tools/resilience/scan-retry-ordinals.mjs [--dsh-home ABS]`: it reads each
`session.v4.jsonl[.zstd]` (zstd decoded frame by frame, as the SDK does),
replays only the v4 `llm/retry`/`llm/retry-started` relationship rules and
prints session ids, paths, a fixed rule name and the offending event `seq` —
never contents. It never writes and offers no repair (exit 1 when any is found).

`node tools/resilience/doctor.mjs` (read-only, also `npm run resilience:doctor`)
checks that the installed SDK carries this bridge (both catalog faces and the
real validator), that the reviewed owner7/controller6 bundles match their build
records, and that every managed profile points at that exact pair, controller
before owner, with exactly one enabled `alex-codex-transient-close` and exactly
one native `llm-retry` row, disabled (`outdated-pair`, `mismatched-owner-controller-pair`,
`owner-before-controller`, `missing-typed-failure-bridge`, `duplicate-native-retry`,
`foreign` are failures). Explicit finite caps (`maxRetries`, `maxCycles`, route
`0`) are reported as warnings. It never writes and never reads sessions or credentials.
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
projection without a model request (opt-in only; `SELF_HEAL_TASK84_ROOT` may relocate it).
Regular tests use isolated `.dumps/` logs and resolve the runtime like the `dsh`
launcher (`$XDG_DATA_HOME`, else `~/.local/share`), never a fixed home directory.
Backups and hash-guarded rollback receipts live under
`$XDG_DATA_HOME/dsh-customs-backups/self-heal-persistence-task50/` (default `~/.local/share`).
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
4. **Only on the chain's first failure, or when its error code differs from the
   last announced one** (at most eight notices per chain, so alternating codes
   cannot grow history without bound): append a synthetic `user/message` with
   source `self-heal-observation`, `label: Harness warning`, `form: notice` and a
   fixed summary, then `observation-admitted`. The text is short (~400 bytes),
   has no retry/maximum/wait counter, keeps the `harness warning:` prefix and the
   "internal harness observation, not a new human request" marker, and carries
   only allowlisted `code`, `summary` and `remediation`. Selected error facts are
   untrusted data, not commands, authority or permission to bypass a restriction.
   Canonical `sourceEventSeqs` links the notice to the committed failed attempt;
   the chain keeps that notice's `messageId`/`observationSeq` on later cycles.
5. Append the native `llm/retry` UI mirror (the only per-cycle trace once the
   chain has warned; `mode: 'always'` without `maxRetries` when unbounded; its
   `failure` copy keeps own data fields only and drops a `providerRetryAfterMs`
   that is not finite and positive, per the native invariant),
   wait through the shared scheduler, append `retry-requested`/`llm/retry-started`,
   check cancellation, and return `{kind: 'retry'}`. Exhausted/over-ceiling cases
   append one explicit terminal notice per suspension and return no action; the
   native loop throws its original `LlmError`, so the failure remains visible.
6. Every refusal (ineligible failure, stale/concurrent agent, missing controller,
   uncommitted attempt, duplicate, unsafe history with its fixed provenance
   reason, opt-out, exhausted cap, provider wait over the ceiling, cancellation,
   append failure) logs `agent-self-heal: recovery refused (<fixed reason>).` —
   never failure prose, provider/model names, ids or exception text.

The UI mirror follows the native v4 session rule: per turn/step and policy key
its ordinal counts from 1 under one `retryId`, and a new turn/step uses a fresh
`retryId`. Ownership v2 records those exact mirror coordinates (`retryId`,
`mirrorRetry`) next to the chain cycle (`retry`). Owner6 reused one chain-wide id
and ordinal, which made a stored log unreadable ("llm/retry skips its policy
attempt sequence") once a chain continued after a failed tool step or a
cancelled turn; owner7 fixes that for new mirrors (old logs are not rewritten).

Additive `recoveryOwnership` envelopes drive the derived `llmRecoveryAccounting`
projection. Historical native spending (all routes) plus semantic spending is
imported once; exact owner-tagged mirrors are excluded. Old pinned caps remain
conservative. This requires no synchronous/deprecated Session log scans, new
required event types, rewritten history or enlarged strict owner-state fields.

`reserved` may carry additive top-level `recoveryWait` metadata (policy, delay,
scheduled time, not-before time and any `providerMinimumMs`). This records a
wait, not an automatic cross-process wakeup. Aborting a wait never refunds its cycle.

**Wall-clock waits.** Node timers follow CLOCK_MONOTONIC, which stops while the
machine is suspended. Real waits are therefore armed in slices of at most 60s
and end as soon as either the monotonic clock or the wall clock has covered the
delay; the owner passes its durable `notBeforeMs` as the wall-clock deadline. A
5h quota-reset wait on a laptop that slept 8h retries within a minute of
waking, still never before the provider minimum. Cancellation, disposal, HMR and
wake behave as before; a manual forward wall-clock change can end a wait early,
like any wall-clock deadline.

**Live human wake.** While a wait is pending, a live root human RPC message
(same evidence as the human-resume grant: no Agent initiator, user/RPC source,
the just-committed `next-step` or `next-turn` splice) ends the local backoff
immediately; a provider-declared minimum still holds. `retry-requested` then
carries `recoveryWake: {kind: 'live-human-inbox', inboxSeq}`. The SDK does not
let a plugin claim the inbox mid-step, so the retried request does not yet
contain that message: it stays queued and is delivered at the next native step
or turn boundary, exactly as without a wait. Model/peer-initiated or label-only
messages never wake a wait. Not yet: messages relayed from the Android Companion
through the session bridge (`plugins/session/bridge.mjs`, human-approved
allowed-once) arrive as a bare `{role:'user', source:{kind:'user'}}` with no
`rpcId` or delivery marker — the same shape `/plan new` (managed-plans) and other
plugin sends use — so owner7 cannot tell them apart and does not wake on them.
A narrow fixed marker on bridge deliveries would be needed (session plugin owner).

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
  reviewed AGY reset conditions use the same scheduler. Valid provider minima are
  honored up to the 24h provider-wait ceiling; above it they suspend explicitly,
  never start another engine or pretend that a shorter delay meets the minimum.
  Malformed minima are ignored (local schedule), not terminal.
- Remaining provider-specific branches (pre-existing, kept as adapter-typed
  facts): exact Antigravity message signatures select `phase`/the malformed
  function-call class, and `ANTIGRAVITY_QUOTA_RESET` is accepted only from the
  `google-antigravity` route with its registered opt-in. The new unbounded
  count, warning cadence, provider-minimum wait and refusal logging never branch
  on a provider name.

The observation/audit selects code, fixed summary, validated status/hint, known
own phase, configured public provider/model family, output cap and nonnegative
integer usage counters. It never copies raw bodies, headers, request options,
causes, stacks, cookies, URLs, account data or hidden thinking content. Foreign
or malformed DTOs/accessors are rejected; unknown route labels are omitted.
Existing upstream logs are not retroactively scrubbed by this plugin.

Other configured routes get process-local ordinal aliases such as
`configured-route-1`: diagnostics can distinguish repeated failures without
publishing private provider/model names or maintaining a model whitelist.
Notices include only the fixed code, summary and remediation. Audit facts keep
the bounded diagnostics (route alias, status, hint, transient retry count). They
never replay completed tools.

## Limits and suspension

Default recovery budget is unbounded per consecutive failure episode (the
`Number.MAX_SAFE_INTEGER` sentinel is stored as an ordinary integer), independent
of other agents. Raising config cannot enlarge an already active chain's cap. With
an explicit finite cap, exhaustion records `suspended`, then permits the current
known host termination. The durable objective is not completed, blocked or deleted; its
activation may be disarmed by the goal driver. This is a recoverable checkpoint
for an admitted human resume, **not automatic pause/reschedule/rearm**. Proven
healthy progress closes the episode; the next failure starts at cycle one. A fresh
default episode never exhausts; explicit and legacy caps stay pinned. Increasing
config, adding self-observations or reloading never renews that episode by itself.

The same failed step's assembly/tools/rendered prompt remain frozen. A model
cannot fix a tool schema or invalid provider knob that rejects every inference
until an independently approved deterministic fix exists. This middleware does
not change those inputs. Thrown prepareCall, stream-consumer and settlement
exceptions can bypass the public request-error hook; they are not universally
self-healed. Tool-result errors already belong to ordinary agent history. Client
side-effect dispatch is owned by the host loop; hosted/remote effects have no
exactly-once guarantee. Caller cancellation and plugin disposal win.

## Build and gates

Owner7 (`lib/index-v7-unified.mjs`) and controller6 are built together, from the
current sources, by `node tools/resilience/build-unified-recovery.mjs --esbuild
/absolute/esbuild/lib/main.js` (reviewed esbuild 0.28.2, target node24). Each
`.build.json` records the source closure hashes and its rollback (owner6 /
controller5); an existing artifact is reused only if byte-identical, rollbacks
must still match their own records, and v1..v6 artifacts are never touched.

`npm run test:resilience` runs this suite with the controller, codex bridge and
tools/resilience gates; set `SELF_HEAL_PLUGIN_MODULE`/`RESILIENCE_CONTROLLER_MODULE`
to run the same native fixtures against the compiled bundles.
`node --test plugins/agent-self-heal/tests/*.test.mjs` runs pure sanitizer and
ledger gates, with token/cause/directive/hidden-content canaries. Native host,
SDK, projection/notice, tool dispatch, cancellation, reload and goal lifecycle
fixtures are separate principal/e4 deliverables; pure tests do not claim them.
`types.d.ts` declares the public message source, audit event and projection map.
No live provider or real credential is required by these pure tests.
