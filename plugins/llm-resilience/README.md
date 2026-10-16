# Contextual LLM resilience

`alex-llm-resilience` is the shared policy and cancellable scheduler for custom main/auxiliary LLM recovery (contract 3: no retry count limit by default). Load it **instead of**, never alongside, native `llm-retry` or the historical quota-retry fork. The main recovery owner is `agent-self-heal`, not a second technical-retry engine.

## Approved default

```js
{
  policy: {
    // maxRetries omitted: no count limit (Number.MAX_SAFE_INTEGER sentinel).
    // An explicit nonnegative integer (0 = opt-out) is an exact finite cap.
    initialDelayMs: 7031.25,
    maxDelayMs: 3600000,             // every retry after the tenth waits this
    jitterRatio: 0,
    maxProviderWaitMs: 86400000,     // largest honored provider minimum (24h)
    retryableCodes: [
      'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
      'PI_AI_ERROR', 'INVALID_REQUEST',
    ],
  },
  providers: {},                    // explicit sparse overrides of the base
  auxiliary: {
    maxBufferBytes: 16777216,
    maxChunks: 65536,
    replaySafePurposes: ['compaction', 'session-title'],
  },
}
```

| Retry | Nominal wait |
|---:|---:|
|1|7.03125s|
|2|14.0625s|
|3|28.125s|
|4|56.25s|
|5|112.5s|
|6|225s|
|7|450s|
|8|900s|
|9|30min|
|10|60min|
|11, 12, …|60min each, indefinitely|

The first ten nominal waits total **7192968.75ms (~1h59m53s)**, excluding request durations. Sixty minutes is the steady interval, **not** a deadline: transient classes keep retrying at the cap until a healthy step, cancellation or disposal (this revokes plan112's "no eleventh retry"). Production timers round fractional milliseconds upward so the timer cannot run before its minimum. Jitter is available only as an explicit override.

`policy` is a base, not an additional main-only ceiling: `{ policy: { maxRetries: 0 }, providers: { local: { maxRetries: 2 } } }` allows that route two retries. Explicit counts are nonnegative safe integers and are honored exactly (the old ten is `maxRetries: 10`); omission is unbounded. Delay fields are positive finite milliseconds through3600000, initial≤cap; `maxProviderWaitMs` is 1..86400000; jitter is in[0,1]. Unknown fields/codes and ambiguous overrides refuse. Config/policy graphs are detached and frozen.

Legacy `selfHeal.maxCycles` may narrow main admission; it never adds another budget. Its resolved default is an envelope over effective configured route caps, so an explicit route override is not accidentally capped again by the base. Legacy timing fields must match `policy` timing; there is no separate semantic backoff. The deprecated `selfHealPlan(cycle)` is only a stateless compatibility view, not another recovery allowance.

An explicit captured registered `mode:'normal', maxRetries:0` remains an opt-out even over a provider patch. Other materialized registered defaults are not policy authority.

**Provider minima are generic.** Any adapter's typed `providerRetryAfterMs` (Retry-After, quota reset) extends the nominal interval, never shortens it, up to `max(maxDelayMs, maxProviderWaitMs)` — by default 24h — so a reset two hours away is waited for instead of suspending at 60 minutes. A minimum above that ceiling is refused (`provider-wait-over-cap`): a visible suspension, because retrying earlier would not satisfy it. Absent, zero, negative or non-numeric hints impose no minimum and fall back to the local schedule; they are not terminal. Exact provider `google-antigravity` plus a freshly captured normal policy containing `ANTIGRAVITY_QUOTA_RESET` still gates only that typed source classification (pre-existing adapter-specific gate); it shares the same counter and the same generic minimum path, not another timer. The adapter computes the reset delay and switches to `ANTIGRAVITY_QUOTA_RESET_LIMIT` above its own `quotaResetRetry.maxWaitMs`, so there is still exactly one wait/budget owner.

`schedule()` returns either the wait plan or `{kind: 'refused', reason}` with a fixed reason (`route-opt-out`, `retries-disabled`, `retry-budget-exhausted`, `ineligible-failure`, `quota-reset-without-hint`, `provider-wait-over-cap`, `invalid-retry-ordinal`, `unrepresentable-policy`, `controller-disposed`, `invalid-failure-facts`); `plan()` is the same decision returning `undefined` when refused. `wait(plan, signal, { wake, onWoken, notBeforeMs })` resolves early when `wake` aborts, but never before the plan's `minimumDelayMs`. Real waits are armed in slices of at most 60s (`WALL_CLOCK_SLICE_MS`) and end when either the monotonic clock or the wall clock (`notBeforeMs`, the owner's durable deadline) has covered the delay, so a system suspend no longer stretches a long quota wait; injected test timers stay authoritative virtual time unless `wallClockSliceMs` is set.

## Warning first, then fresh preparation

For each admitted main recovery, the owner reserves one durable credit and, on the chain's first failure or when the error code changes (bounded per chain), appends a short native user notice beginning **`harness warning:`**; it then records UI progress, waits cancellably and returns `{kind:'retry'}` to the native loop. The loop prepares a new call from updated context; it never reuses a consumed waterfall or prepared iterator. The notice carries only the fixed code, summary and remediation — no ordinal, maximum or wait — so one notice stays true for the whole chain. Arbitrary remote prose, headers, bodies, credentials and stacks are not copied into the prompt.

Technical failures, first empty responses, bounded opaque `PI_AI_ERROR` and an exactly recognized malformed-tool-call signature share that path. Ordinary `INVALID_REQUEST`, auth/permission failures, cancellation, policy/context failures and conflicting permanent facts do not become generic retries. HTTP4xx except408/429 wins over a conflicting transient code. A warning does not grant permission, select a new model or modify server settings.

When admission is unsafe, a minimum is over the ceiling or an explicit finite cap is exhausted, there is no fallthrough into another retry engine. A terminal diagnostic is visible (once per suspension) and the original native failure remains an error; the refusal is logged with its fixed reason. Cancellation/disposal stops waits promptly. An uncertain/failed append never refunds a reservation or repeats an unsure admission automatically.

Adding a warning does **not** remove retained images, repair a server or allow the model to reason before successful prefill. A persistent backend/input failure of a transient class keeps retrying hourly until cancelled; an explicit finite cap bounds it. No automatic image offload, backend/model change, process restart or paid-tool replay is introduced.

## Durable accounting and UI compatibility

`installMainDriver` now registers projections only; it owns no technical retry listener/timer. Native `llmRetry` stays stateVersion1 with its original shape/reset points, and `agentSelfHeal` keeps its strict stateVersion1 checkpoint (only widened). Additive `agent/self-heal` ownership envelopes (v1 from owner6, v2 from owner7 with exact native mirror coordinates) feed the derived **v3** `llmRecoveryAccounting` projection: no ordinal ceiling, a 16-key sliding mirror window (only the newest mirror per policy can still be in the step-scoped UI ledger; an evicted key can only fail closed), and a fixed `unsafeReason`. Native UI retry events mirror the **same** reservation, not a second budget, and follow the v4 session rule (ordinal 1.. per turn/step/policy key, fresh `retryId` per new turn/step) so stored logs keep reopening. Budget refusals are `RecoveryHistoryError`s with a fixed `reason` the owner logs.

Legacy consumed native counts across routes/keys and semantic cycles are conservatively imported once; exact owner-tagged UI mirrors are not counted twice. The historical floor survives an error-ended turn and a new autonomous step even though the native UI ledger resets. A v1 accounting cache is rebuilt from full native history, not trusted as an empty budget. Existing smaller pinned episode caps stay smaller. Error/code/route changes, warnings, fresh preparation, policy reload and controller replacement cannot mint new credits. Real healthy progress or separately verified live human input controls new episodes; bare completion labels or cold human-source labels are not sufficient. No deprecated synchronous session-log scans or business-session rewrites are used.

Failed local tool blocks are not dispatched; winning tools are dispatched once and completed tool history stays in context. This is not an exactly-once guarantee for remote hosted tools or effects already performed by an uncooperative transport.

## Auxiliary requests

The auxiliary waterfall remains outside the typed-failure bridge; exact native main-loop request brands bypass it before cloning. The initial `next()` is consumed once. Subsequent attempts call public `llm.stream` with freshly cloned intent plus **one** safe warning message (replaced only when the code changes, never accumulated), preserving initial history, system instructions and requested output format. The operation keeps one in-memory counter and shares the main policy, so auxiliary recovery is also unbounded by default (caller cancellation still ends it); terminal refusals log `llm-resilience: auxiliary recovery refused (<fixed reason>).`

Replay-safe compaction/title requests buffer a complete attempt through terminal/iterator completion. Failed output, usage, tool declarations and replay state are discarded; only the winning attempt reaches the consumer. Unknown consumers may retry only before any chunk was exposed. Unsafe message/tool-history admission, malformed streams, buffer overflow, consumer/middleware failures and adapter-generation changes fail closed. There are no invented agent journal events or durable auxiliary recovery promises.

A pending uncooperative initial transport may continue remotely: zero-argument `next()` cannot receive a replacement signal. Guarded detached cleanup prevents that from blocking cancellation; fresh attempts receive the owned fused signal. Purpose-based replay safety remains a caller contract.

Grammar-fix reasoning-effort negotiation is bounded input negotiation, not a second generic transport engine; its120s UI deadline remains. FCM outbox delivery, filesystem/RPC/login operations, goal rounds and generation tools are separate contracts, not additional LLM budgets. The old quota fork is retained only as historical rollback code; the new retirement marker installs no hooks, timer or projection.

## Service and deployment

Controller6 provides one frozen object **only** as `ctx.llmRecoveryUnbounded`, with `recoveryVersion:3` and `recoveryHistoryVersion:3`, after the accounting-v3 projection and auxiliary hooks are installed. It deliberately does not publish the contract-2 names (`llmResilience`, `llmRecovery`, `llmRecoveryHistory`): owner6 keeps waiting during a warm handoff instead of binding to schemas it cannot read, and owner7 never binds to controller5. The retired quota fork's marker still requires contract 2 and stays out of every profile.

The manifest selects immutable **controller6** (`lib/index-v6-unified.mjs`) and **self-heal7** (`../agent-self-heal/lib/index-v7-unified.mjs`) in web/headless/tui/dsh-tui/companion, root-only. Both bundle their own module closures: a new entry importing cached old leaves would not hot-upgrade the algorithm. Controller5/owner6 are the reviewed rollback pair; controller4 and the older candidates remain immutable historical inputs. SDK namespaces already imported in open processes remain cached; this task does not republish the SDK or automatically restart processes. Profiles are switched only by `tools/activate.mjs --write` (targeted migration: owner6/controller5 and every older owned path are recognized and upgraded in place; the superseded 60-minute quota comment is rewritten).

Use `node tools/resilience/build-unified-recovery.mjs --esbuild /absolute/esbuild/lib/main.js` with reviewed esbuild0.28.2. It compiles **both** controller6 and owner7 from the current sources to memory, captures and re-verifies every closure source, and exclusively creates missing outputs/sidecars (`wx`); exact existing artifacts are reused, a differing one is refused ("use a new version"). Before the first and after the last write it verifies that controller5/owner6 still match their own build records and that every historical artifact (v1, v2-persistence, v3, rollback sidecars) is byte-identical. Clean-install requires both reviewed artifacts to be checked in, walks the rollback chain (controller6→5→1, owner7→6→3→2) through the records, and accepts the build only if both are reproduced byte-for-byte. Inventory requires the active pair plus that rollback chain; controller4 stays optional provenance. Publication is hash-bound, backed up and per-file CAS—not multi-file atomic. Native `cordis.yml` is derived cache, not an independent config authority.

**Rollback** to controller5/owner6 is a functional downgrade only for sessions that never ran contract 3: payload-v2 audits, policy 3, accounting v3 and cycles above ten are refused by the old pair. It is never applied automatically. Older artifacts are preserved unchanged.

## Offline validation

```sh
npm run test:resilience
node tools/resilience/doctor.mjs   # read-only: SDK bridge, bundles, profile pair
```

Injected clocks test every interval (and retries past ten) without waiting hours. Real canonical Cordis/loop/session/tool fixtures, native JSONL/zstd cold replay, compiled warm handoff and actual installed SDK HTTP-in-memory fixtures test warning-bearing fresh preparations, finite accounting, cancel/reload and tools. Separate five-profile isolated composition gates precede publication. These proofs are not paid inference or live backend-health guarantees.
