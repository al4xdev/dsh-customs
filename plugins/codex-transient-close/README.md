# Structured provider-failure bridge

Public `llm/stream` middleware, **not a retry engine**. The activation name remains `alex-codex-transient-close` for compatibility. One SDK subscription and one request-local bridge preserve structured failures for any provider supported by the active SDK, including unmarked and auxiliary requests (for example compaction). Native adapter failures without a matching SDK DTO pass through identically.

Requests are never mutated. Waterfall `next()` is called once per wrapper; dispatch is never replayed here. There is no timer, model-name policy, provider allowlist, network request, tool execution or retry loop. The separate recovery controller owns budgets, backoff and replay admission.

## Public SDK contract and capability gate

The bridge imports the SDK through `resolveHostSdkEntry()` in `sdk-host.mjs`: resolve from the running host adapter's package search roots and its public import export, then import the real canonical entry. Do not install a private SDK or `dsh-llm` copy beside this plugin: the subscriber singleton and host loop-request WeakSet must match the actual producer/host.

The additive public contract is:

- `PROVIDER_FAILURE_OBSERVER_VERSION = 1`;
- `subscribeProviderFailures(listener): dispose`;
- **generic coverage:** frozen, nonempty `PROVIDER_FAILURE_APIS` string array listing actually instrumented APIs;
- detached, frozen data-only DTO: `{ provider, api?, code, message, status?, requestId?, providerRetryAfterMs? }`.

A v1 marker alone proves only the historical Codex observer. Without the API capability list, structured capture remains limited to marked normal Codex requests. Without the marker/subscriber, no SDK observer is installed, and only the narrow historical WebSocket fallback remains. Malformed/mutable capabilities cannot widen coverage. `applyWithObserver(ctx, sdk)` is an explicit offline-test seam, not profile/CLI configuration; its SDK must be the instance producing the stream. Cordis effects unsubscribe on disposal/reload.

Once generic capability is present, a known DTO matching the public request's `provider` is admissible without per-request API proof (older DTOs may omit `api`). If `api` is supplied, it must be in the active capability list. No provider-name or model-name list is consulted. Coverage therefore follows SDK API instrumentation, not a claimed universal ability to recover arbitrary raw `PI_AI_ERROR` text. New instrumented APIs are recognized from the public list without another provider branch.

The SDK owns classification and emits only terminal, unrecovered provider failures. Its helper is browser-portable: no scheduler or Node AsyncLocalStorage. The SDK must not export bodies, headers, tokens, account/project data, causes or stacks. The bridge independently projects only safe validated fields and never displays arbitrary DTO message text.

## Isolation and settlement

`failure-bridge.mjs` establishes Node AsyncLocalStorage around dispatch/iterator construction and every iterator `next`, `return` and `throw`. **Every** intercepted request gets an isolated context, even when legacy eligibility excludes capture: nested unmarked/auxiliary calls must never inherit an eligible parent's capture scope. Concurrent same-provider and cross-provider requests remain independent. Finishing, caller abort or consumer close deactivates capture; foreign, unknown and delayed reports are rejected.

Only a terminal **error** finish with a known matching DTO is replaced. Successful stop/tool/usage/partial/provider-metadata chunks retain identity, as do native failures without a matching DTO. Replaced failure finishes discard `replayState`; a failed attempt cannot carry a successful replay envelope. Other finish metadata is retained.

Safety precedence:

- Original caller/watchdog `ABORTED`/`TIMEOUT` and established permanent failure codes win unchanged.
- With a known scoped DTO, a contradictory original permanent HTTP4xx (except408/429) wins over transient DTO status/category:401/403 become safe `AUTH`, other permanent4xx become `INVALID_REQUEST`, retaining the actual permanent status.
- Generic429 and explicit named quota are distinct (`RATE_LIMIT` versus `QUOTA`/`ACCOUNT_QUOTA`); named original quota is not reopened by a rate-limit DTO.
- Actual validated DTO status/hint/requestId take priority; validated original fields fill omissions. RequestIds are nonempty, at most256 characters and contain no controls. Status is integer100–599; Retry-After is finite0–2147483647ms, with zero omitted rather than inventing a positive delay. Invalid optional IDs are dropped; accessor DTO fields are rejected without execution.
- Error messages are fixed: `Provider failure (CODE)`, with historical `Codex provider failure (CODE)` retained only for Codex compatibility. No model name, raw upstream wording or secret is included.

No wording invents HTTP503, quota or server categories. Unknown reports and broad `PI_AI_ERROR` remain unchanged/non-retryable unless an independent native classifier has already supplied typed facts.

**Cancellation limitation:** waterfall `next()` is zero-argument and closes over the original immutable prepared request. This wrapper cannot replace its upstream signal. Consumer close races the wrapper's pending wait, deactivates capture and detaches guarded cleanup when necessary; it does not claim to kill an uncooperative upstream transport. Teardown still depends on the caller signal and adapter/provider deadline.

## Historical WebSocket fallback (only normal marked Codex)

The fallback remains restricted to requests branded by the **same running host's** `isAgentLoopRequest()`, provider `openai-codex`, and `purpose === undefined`. Only `PI_AI_ERROR` with exact single-line `WebSocket closed 1000 [reason]`, `WebSocket closed 1012 [reason]`, or `WebSocket error` becomes `TRANSPORT`.

It does **not** cover unmarked/auxiliary/other-provider calls, aborted finishes, HTTP4xx, other close codes, qualified/embedded/multiline messages, or reasons mentioning auth/credentials, quota/billing, policy or oversized payloads. The exact opaque socket error is bounded recovery, not proof of a transient cause. No catch-all `PI_AI_ERROR` retry rule was introduced. Newly normalized fallback failures also discard successful `replayState`.

This bridge does not close sockets, reset continuation caches or alter provider transport options. Transport-specific fallback behavior belongs to the separately maintained SDK recipes.

## Loading and recovery ownership

Keep the existing plugin ID `alex-codex-transient-close`. `inject = ['llm']` waits for the official service. Classification explicitly appends its public hook (`prepend: false`), while auxiliary recovery prepends: recovery therefore consumes normalized failures regardless of registration order. Classification cannot require a global-recovery service because standalone/native hosts must not gain a forced SDK dependency. Outer observers see normalized finish facts. Never execute tools from partial-stream observers.

This source change does not edit activation manifests, profiles or installed packages, activate a candidate SDK, or restart a process. A running process retains its existing module graph; deployment and compatibility gates belong to the owner. A legacy profile may still use the official retry plugin; the new global controller owns the approved recovery policy in the new composition. This bridge supplies facts only and never competes with either controller.

Compaction and other auxiliaries now receive structured facts when capability is present, **not automatic replay from this plugin**. `compaction/summary-error` is synchronous and is not used for scheduling. The separate auxiliary recovery driver must enforce its own replay-safe buffering/commit contract. Provider-hosted tools and remote effects have no exactly-once guarantee.

## Offline validation

```fish
node --test plugins/codex-transient-close/failure-bridge.test.mjs plugins/codex-transient-close/codex-transient-close.test.mjs
node --test tools/pi-ai-fork/long-retry-check.test.mjs
```

The bridge suite uses actual Cordis waterfalls and the real host `dsh-llm` marker. It covers capability-vs-v1 compatibility; arbitrary providers and unmarked/auxiliary calls; dispatch-time emission; nested marked/unmarked/auxiliary calls; same/cross-provider concurrency; delayed reports; malformed frozen/accessor DTOs; safe IDs/status/hints; permanent contradictions, quota and abort precedence; chunk identity; consumer return/throw; and single subscriptions after reload/disposal.

The existing native runtime fixture uses fresh Worker module graphs with real official Cordis, loop, sessions, projections, tools and retry plugins; only adapter/tool bodies are fake, with network APIs blocked. It proves no CLIENT tool executes on complete or incomplete failed streams/backoff, success executes only the admitted local tool once, failed partials never enter retry history, budgets remain independent/bounded, and cancel/dispose prevents another attempt. The long-policy fixture accelerates timers only in its isolated Worker; production timing/policy is untouched. These are offline proofs, not live provider/profile activation or an overnight availability claim.

Retest public waterfall, SDK singleton, host marker and loop settlement contracts after host upgrades. The observer source/build recipes live separately under `tools/pi-ai-fork`; tests do not promote them.
