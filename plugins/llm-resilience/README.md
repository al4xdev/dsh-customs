# Contextual LLM resilience

`alex-llm-resilience` is the shared finite policy and cancellable scheduler for custom main/auxiliary LLM recovery. Load it **instead of**, never alongside, native `llm-retry` or the historical quota-retry fork. The main recovery owner is `agent-self-heal`, not a second technical-retry engine.

## Approved default

```js
{
  policy: {
    maxRetries: 10,                  // additional to the initial request
    initialDelayMs: 7031.25,
    maxDelayMs: 3600000,
    jitterRatio: 0,
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

Total nominal waits: **7192968.75ms, approximately1h59m53s**, excluding request durations. Sixty minutes is the last interval, **not** an overall deadline. Production timers round fractional milliseconds upward so the timer cannot run before its minimum. There is no eleventh retry. Jitter is available only as an explicit override.

`policy` is a base, not an additional main-only ceiling: `{ policy: { maxRetries: 0 }, providers: { local: { maxRetries: 2 } } }` allows that route two retries. Counts are integers0..10; delay fields are positive finite milliseconds through3600000, initial≤cap; jitter is in[0,1]. Unknown fields/codes and ambiguous overrides refuse. Config/policy graphs are detached and frozen.

Legacy `selfHeal.maxCycles` may narrow main admission; it never adds another budget. Its resolved default is an envelope over effective configured route caps, so an explicit route override is not accidentally capped again by the base. Legacy timing fields must match `policy` timing; there is no separate semantic backoff. The deprecated `selfHealPlan(cycle)` is only a stateless compatibility view, not another recovery allowance.

An explicit captured registered `mode:'normal', maxRetries:0` remains an opt-out even over a provider patch. Other materialized registered defaults are not policy authority. Exact provider `google-antigravity` plus a freshly captured normal policy containing `ANTIGRAVITY_QUOTA_RESET` enables only that typed source classification. It uses the same counter and **same60min ceiling**, not an additional24h timer. A positive server minimum may extend the nominal interval, never shorten it. Invalid hints or minima above the effective cap suspend recovery; retrying earlier would not satisfy the server minimum.

## Warning first, then fresh preparation

For each admitted main recovery, the owner reserves one durable credit, appends a native user notice beginning **`harness warning:`**, records admission/UI progress, waits cancellably and returns `{kind:'retry'}` to the native loop. The loop prepares a new call from updated context; it never reuses a consumed waterfall or prepared iterator. The notice includes safe error code/status/fixed diagnostics, ordinal and wait. Arbitrary remote prose, headers, bodies, credentials and stacks are not copied into the prompt.

Technical failures, first empty responses, bounded opaque `PI_AI_ERROR` and an exactly recognized malformed-tool-call signature share that path. Ordinary `INVALID_REQUEST`, auth/permission failures, cancellation, policy/context failures and conflicting permanent facts do not become generic retries. HTTP4xx except408/429 wins over a conflicting transient code. A warning does not grant permission, select a new model or modify server settings.

When admission is unsafe, a hint is refused or credits are exhausted, there is no fallthrough into another retry engine. A terminal diagnostic is visible and the original native failure remains an error. The last failing request can produce a final warning without consuming or creating an eleventh credit. Cancellation/disposal stops waits promptly. An uncertain/failed append never refunds a reservation or repeats an unsure admission automatically.

Adding a warning does **not** remove retained images, repair a server or allow the model to reason before successful prefill. Persistent backend/input failures can still exhaust the finite budget. No automatic image offload, backend/model change, process restart or paid-tool replay is introduced.

## Durable accounting and UI compatibility

`installMainDriver` now registers projections only; it owns no technical retry listener/timer. Native `llmRetry` stays stateVersion1 with its original shape/reset points, and `agentSelfHeal` keeps its compatible strict v1 state. Additive `agent/self-heal` ownership envelopes feed the derived **v2** `llmRecoveryAccounting` projection. Native UI retry events mirror the **same** reservation, not a second budget.

Legacy consumed native counts across routes/keys and semantic cycles are conservatively imported once; exact owner-tagged UI mirrors are not counted twice. The historical floor survives an error-ended turn and a new autonomous step even though the native UI ledger resets. A v1 accounting cache is rebuilt from full native history, not trusted as an empty budget. Existing smaller pinned episode caps stay smaller. Error/code/route changes, warnings, fresh preparation, policy reload and controller replacement cannot mint new credits. Real healthy progress or separately verified live human input controls new episodes; bare completion labels or cold human-source labels are not sufficient. No deprecated synchronous session-log scans or business-session rewrites are used.

Failed local tool blocks are not dispatched; winning tools are dispatched once and completed tool history stays in context. This is not an exactly-once guarantee for remote hosted tools or effects already performed by an uncooperative transport.

## Auxiliary requests

The auxiliary waterfall remains outside the typed-failure bridge; exact native main-loop request brands bypass it before cloning. The initial `next()` is consumed once. Subsequent attempts call public `llm.stream` with freshly cloned intent and cumulative safe warning messages, preserving initial history, system instructions and requested output format. The operation keeps one in-memory counter even though its messages change.

Replay-safe compaction/title requests buffer a complete attempt through terminal/iterator completion. Failed output, usage, tool declarations and replay state are discarded; only the winning attempt reaches the consumer. Unknown consumers may retry only before any chunk was exposed. Unsafe message/tool-history admission, malformed streams, buffer overflow, consumer/middleware failures and adapter-generation changes fail closed. There are no invented agent journal events or durable auxiliary recovery promises.

A pending uncooperative initial transport may continue remotely: zero-argument `next()` cannot receive a replacement signal. Guarded detached cleanup prevents that from blocking cancellation; fresh attempts receive the owned fused signal. Purpose-based replay safety remains a caller contract.

Grammar-fix reasoning-effort negotiation is bounded input negotiation, not a second generic transport engine; its120s UI deadline remains. FCM outbox delivery, filesystem/RPC/login operations, goal rounds and generation tools are separate contracts, not additional LLM budgets. The old quota fork is retained only as historical rollback code; the new retirement marker installs no hooks, timer or projection.

## Service and deployment

The controller provides **the same frozen object** as `ctx.llmResilience` (compatibility), `ctx.llmRecovery` and **`ctx.llmRecoveryHistory`** (history-v2 readiness), with `recoveryVersion:2` and `recoveryHistoryVersion:2`. Accounting and auxiliary hooks are installed before readiness is published. The owner requires the new history capability: both the historical technical controller and unactivated accounting-v1 candidates lack it, so a new owner queues safely during warm handoff instead of binding prematurely to an old projection contract.

The manifest selects immutable **controller5** (`lib/index-v5-unified.mjs`) and unchanged **self-heal6** (`../agent-self-heal/lib/index-v6-unified.mjs`) in web/headless/tui/dsh-tui/companion, root-only. Controller5 fixes native schema implicit empty-list defaults: omitted lists retain central recovery defaults, while explicit `[]` remains an opt-out. Controller/history/accounting stay at v2, with no protocol change. Both bundle their own module closures: a new entry importing cached old leaves would not hot-upgrade the algorithm. Controller4 and unactivated2/4 and3/5 candidates remain immutable historical inputs, not active deployment targets. SDK namespaces already imported in open processes remain cached; this task does not republish the SDK or automatically restart processes.

Use `node tools/resilience/build-unified-recovery.mjs --esbuild /absolute/esbuild/lib/main.js` with reviewed esbuild0.28.2. It compiles only controller5 to memory and exclusively creates missing controller5 output/sidecar (`wx`); exact existing controller5 is reused. Owner6 and its sidecar must already exist: their recorded closure sources, compiler/target, rollback and artifact hashes are verified before/after the build, with no recompilation, rewritten receipt or owner writes. Closure drift requires separate owner review, never an implicit owner rebuild. Historical controller4 is not touched. Clean-install independently verifies manifests and rollback hashes; portable requirements are active5/6 plus required legacy rollback1/self-heal2/3, not controller4. Inventory reports controller4 separately when present. Targeted profile migration accepts historical controller4 and preserves unrelated models, permissions, compaction and explicit supported overrides. Publication is hash-bound, backed up and per-file CAS—not multi-file atomic. Native `cordis.yml` is derived cache, not an independent config authority.

Original before-patch bytes and **functional rollback** are different: old source-controller URIs now point at edited source. A qualified functional rollback replaces only that URI with immutable `lib/index-v1-resilience.mjs` (historical9+3 behavior), retaining self-healv3. It is never applied automatically. Older self-healv2/v3 artifacts are preserved unchanged.

## Offline validation

```sh
node --test plugins/llm-resilience/*.test.mjs plugins/agent-self-heal/tests/*.test.mjs
```

Injected clocks test every interval without waiting two hours. Real canonical Cordis/loop/session/tool fixtures, native JSONL/zstd cold replay, compiled warm handoff and actual installed SDK HTTP-in-memory fixtures test warning-bearing fresh preparations, finite accounting, cancel/reload and tools. Separate five-profile isolated composition gates precede publication. These proofs are not paid inference or live backend-health guarantees.
