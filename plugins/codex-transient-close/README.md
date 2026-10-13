# Codex transient close normalization

A small **official `llm/stream` middleware**, not a new retry engine. With the reviewed optional SDK observer it preserves structured Codex failure categories before the agent commits its failed attempt. Its legacy fallback still converts only `PI_AI_ERROR` and the exact shapes `WebSocket closed 1000 [reason]`, `WebSocket closed 1012 [reason]`, or `WebSocket error` to `TRANSPORT`.

All other chunks and finish facts are retained. Requests are never mutated, `next()` is called once, and middleware exceptions are not caught. There is no timer, socket manipulation, model request, tool execution, or retry loop in this plugin.

## Structured terminal-failure observer

The additive SDK seam exports `PROVIDER_FAILURE_OBSERVER_VERSION = 1` and `subscribeProviderFailures(listener): dispose`. Codex emits once in its **final** error catch, never for an internally recovered WebSocket/SSE attempt or successful completion. The detached frozen DTO contains only provider, stable category, fixed safe message, actual HTTP status and validated Retry-After when available. It contains no raw body/event, token, account, project, cause, stack or headers. Listener exceptions/rejected promises cannot change SDK settlement; separate registrations have separate lifetimes. The SDK helper is browser-portable and has no Node AsyncLocalStorage or retry engine.

The provider-owned `failure-bridge.mjs` uses Node AsyncLocalStorage around iterator creation and every `next`, `return` and `throw`. Only active eligible normal Codex requests capture their own reports; late/background/foreign requests are ignored. Only a terminal **error** finish is replaced, never a successful stop. Partial/tool/usage chunks and non-failure metadata retain identity. Replaced errors cannot carry a successful replay envelope. Caller abort/watchdog and established permanent host categories take priority. With a known scoped DTO, contradictory original HTTP401/403 becomes safe `AUTH`, and other original4xx (except408/429) becomes `INVALID_REQUEST` rather than transient; the real permanent status is retained even against a new503. Only validated original requestId/status/positive Retry-After fill fields omitted by the DTO; new valid defined facts otherwise win. RequestIds are bounded/no-controls, invalid metadata and raw cause/extra fields are dropped. A zero SDK hint is omitted because Harness requires positive hints, not replaced with an invented delay. Unknown/unscoped calls retain original facts. Failure messages are fixed categories, not raw provider display text.

Category mapping is based on structured code/type/status, not an overload phrase catalogue:

- explicit auth/401/403 → `AUTH`; quota/billing codes → `QUOTA`;
- context/request/policy rejection → `CONTEXT_WINDOW_EXCEEDED`/`INVALID_REQUEST`;
- `server_error`, `overloaded_error`, reviewed server codes or actual 5xx → `SERVER`;
- rate-limit codes or generic 429 without named quota → `RATE_LIMIT`;
- typed transport/timeout/caller cancellation → `TRANSPORT`/`TIMEOUT`/`ABORTED`;
- unknown facts remain the original failure. Human wording never invents an HTTP503, quota or server category.

The observed `Codex error: Our servers are currently overloaded. Please try again later.` has not supplied a raw machine code in this audit. **If the event contains no known code/type/status, it remains unknown/non-retryable.** No new literal or broad regex fallback was added; any message-only exception needs a separate owner decision. `PI_AI_ERROR` remains outside generic retryable codes.

`sdk-host.mjs` resolves the import-only SDK from the running host adapter's package search roots and direct import export, then imports the real canonical entry. It does not select a private plugin dependency. The old installed SDK without the public marker retains exactly the legacy close behavior. `applyWithObserver(ctx, sdk)` is an explicit offline-test seam, not a profile/CLI config: its SDK instance must be the same one producing the failure stream. Effects unsubscribe on disposal/reload.

**Cancellation limitation:** the native `llm/stream` waterfall's `next()` is zero-argument and closes over the original immutable prepared request. The middleware cannot replace the upstream signal. Consumer close races the wrapper's pending wait, marks its report context inactive and detaches guarded upstream cleanup if needed; it does not claim to kill an uncooperative producer immediately. Transport teardown still depends on the original caller abort and native adapter/provider idle deadline. Native actor cancellation is tested separately from this wrapper-only property.

Source/build recipe and hash manifest: [Codex categories recipe](../../tools/pi-ai-fork/README.md#structured-codex-failure-candidate-task38). The candidate is not promoted by tests; source pins, old artifacts and Task32 OAuth outputs remain untouched.

## Legacy scope and fail-fast rules

Eligible requests must be marked by the **same running host's** public `isAgentLoopRequest()` API, have provider `openai-codex`, and have no auxiliary `purpose`.

The plugin does not normalize:

- unmarked calls, other providers, `compaction`, or `session-title`;
- cancellation, an aborted finish, or a failure whose code is not `PI_AI_ERROR`;
- another close code, a merely embedded message, a qualified `WebSocket error` (including whitespace/prefix/suffix), or multiline messages;
- HTTP 4xx facts or close reasons mentioning credentials/authentication, quota/billing, policy violations, or oversized payloads.

These exclusions intentionally favor fail-closed behavior over broad error recovery. New close codes require explicit review. `PI_AI_ERROR` must **not** be added to generic retryable codes; `always` and infinite retries are not required or recommended.

### Opaque socket errors

The installed pi-ai emits exactly `WebSocket error` when its error event supplies no message or nested error details. The official adapter's standalone `socket` classifier misses `WebSocket`, leaving `PI_AI_ERROR` non-retryable. This interrupted the audited Tavern session at 01:01 on 2026-10-13 without a retry; it resumed manually in the morning.

Only that exact fallback is now eligible under the same normal-loop guards. **The lost cause is not proven transient**: an opaque handshake/authentication/policy failure may also present this way. Recovery is a bounded attempt, not invented diagnosis; a persistent opaque error still terminates after the official budget. Known AUTH/quota/invalid-request codes, HTTP 4xx, qualified error messages and oversized/request-buffer errors remain unchanged. Preserving structured native causes would be a separate fork/adapter improvement.

## Official policy and audit

The installed `@deepseek-ai/dsh-llm-retry` plugin still owns recovery. Its unchanged normal defaults are five retries after the original request, exponential delays starting at 500 ms, maximum delay 10 seconds, jitter 0.1, and transient codes including `TRANSPORT`.

Failed chunks become `assistant/attempt`, not a successful `assistant/message`. The official loop evaluates recovery only after that settlement and dispatches CLIENT tools only after a successful assistant message. The retry plugin records `llm/retry` before its cancellable wait, then `llm/retry-started` before the next attempt. The budget is per provider/policy/step, not a global overnight budget. A failure after exhaustion still terminates the turn.

This middleware leaves the provider policy unchanged. The separate Task32 OAuth configuration adds provider-scoped `retryPolicies`: this machine's long-running Codex deployment selects normal mode, nine retries, 5000 ms initial delay, 1200000 ms cap and jitter 0.1. Nominal waits are 5/10/20/40/80/160/320/640/1200 seconds (41m15s accumulated, excluding requests); the last jittered wait is 18–20 minutes. Other providers retain defaults unless configured. A provider Retry-After within the cap replaces the local backoff; above the cap, normal mode still fails fast. Policy edits during an active chain can create a different budget key; avoid live policy reloads during recovery. Use a new TUI process after promotion.

## Loading

`plugins/activation.json` registers this plugin only for `dsh-tui` (`overlay: false`), so personal-profile sync retains it without enabling it in other profiles or generic overlays. Check with `node tools/activate.mjs --profile dsh-tui --check`.

The effective host profile insertion is:

```yaml
- insert:
    - id: alex-codex-transient-close
      name: /home/alex/git/my/dsh-customs/plugins/codex-transient-close/index.mjs
```

`inject = ['llm']` waits for the official service. Row order is not activation order. `ctx.on('llm/stream', listener, { prepend: true })` makes this an outer wrapper relative to listeners already registered; a later prepend can wrap it. Inner observers see the original finish, outer observers see normalized routing facts. Do not execute tools from raw partial-stream observers.

No actual profile is changed by the tests. The common repository helper resolves public packages from `process.argv[1]` (the running DSH entry), with `/home/alex/.local/share/dsh-cli/package.json` as the existing offline-test fallback. **Do not install a private copy of `dsh-llm` beside this plugin:** its loop-request marker is a module-local WeakSet. Importing a different bundle makes the predicate false and disables normalization safely. A live profile-loader gate must verify a marked request and normalized finish in the same process before deployment. The integration fixture proves this identity through real host loop-built requests, not a forged marker or a copied request.

Existing profile IDs are `llm-pi-ai` and `llm-retry`. Loader patches replace the entire targeted `config`; any later policy override must preserve the full provider configuration and every existing route. This plugin needs no provider override.

The profile already references this local source. A **new DSH process** loads the correction; existing processes may retain the old module. Do not restart agents automatically or assume a goal resume reloads JavaScript. At an appropriate idle checkpoint, reopen the TUI and resume the existing persisted session. Rollback is the focused source diff, not a pi-ai tarball downgrade. Tests and wiring checks do not rewrite profiles, history or credentials.

## Socket and compact-summary limitations

The previously audited installed pi-ai implementation clears the cached continuation and releases/discards a failed Codex WebSocket connection, then marks the session for sticky SSE fallback. The separately maintained updated pi-ai fork narrows that sticky fallback to close 1009 (oversized messages); transient closes 1000/1012 can use a fresh WebSocket instead. Which behavior is active depends on the deployed pi-ai version and must be verified during the host deployment gate. In either case, the next official attempt rebuilds context from durable history. This plugin does not reset fallback state, close other sessions, or change transport options.

Auxiliary compact-summary calls are deliberately excluded. `compaction/summary-error` is a synchronous boolean hook requiring durable progress in selected input; it cannot safely await a transport backoff. The official model-step retry engine does not automatically budget compact-summary requests. `compactionRetries` is about pressure after successful compactions, not transport errors. Thus this patch mitigates observed conversation-step closes; it is not a guarantee of uninterrupted overnight execution or process supervision.

CLIENT-tool non-execution on failed streams is covered by tests. Provider-hosted tools, billing and remote effects may already occur before the client receives an error; there is no exactly-once guarantee for them. The fixture only registers a side-effect-free local tool spy.

## Offline tests

```fish
node --test plugins/codex-transient-close/codex-transient-close.test.mjs
node --test tools/pi-ai-fork/long-retry-check.test.mjs
```

The integration tests use fresh Worker module graphs with actual official Cordis, loop, session, projections, tools and retry plugins; only the provider adapter and tool body are fake. Network APIs are blocked. They prove:

- without this plugin both native closes and the exact generic `WebSocket error` fail with no retry;
- incomplete **and complete** tool chunks followed by either failure execute no tool during failed settlement/backoff; retry success executes the local spy exactly once;
- retries use fresh live attempt IDs in the same step and omit failed partial chunks from request history;
- for native closes and generic errors, the unchanged official maximum of five retries gives six attempts, five audit pairs and zero tools on exhaustion;
- for both categories, cancellation and official retry-plugin disposal during backoff prevent a new attempt; concurrent agents have independent budgets, and the next turn gets a fresh budget;
- listener disposal/reload does not retain duplicate wrappers, and observer/middleware failures remain thrown;
- strict negatives and preservation of finish metadata/chunk identity.

The original integration clock uses 1 ms backoff to avoid spending production delays in an offline test; the policy-default test separately asserts 500/10000 ms and jitter 0.1. The long-policy suite retains the real policy and durable delay values, accelerating only timers inside its isolated Worker. It verifies nine official retries, the full 5s→20min schedule and jitter cap, Retry-After below/above cap, permanent fail-fast, independent concurrent budgets, and cancellation/disposal of an actually pending 20-minute timer. The combined suites pass **40/40** tests; no production timer or retry engine is modified.

The 2026-10-13 generic-error regression first reproduced eight failures against the old middleware; after the focused correction, **28/28** tests passed. The separate LTS contracts passed **76/76** and `node tools/activate.mjs --check --profile dsh-tui` reported in sync. These are offline host-loop/fake-adapter and wiring proofs, **not a live provider/profile-loader test or a new uninterrupted overnight run**.

## Audited upstream

Installed official version: `@deepseek-ai/dsh-llm` / `dsh-llm-retry` **0.2.0-rc.2**, Cordis peer `~4.0.4`. Public source repository recorded in installed package metadata: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

Relevant installed evidence:

- `dsh-llm/lib/types/index.d.ts`: public `llm/stream` waterfall, immutable loop requests.
- `dsh-llm/lib/index.js`: `streamWithRegistration()` wraps prepared calls too.
- `dsh-agent-loop/lib/index.js`: failed settlement before recovery, successful settlement before tool dispatch.
- `dsh-llm-retry/lib/index.js`: durable bounded recovery, cancellation and disposal.
- `dsh-llm-pi-ai/lib/index.js`: native classification misses `WebSocket` as a standalone `socket` token.
- `@earendil-works/pi-ai/dist/api/openai-codex-responses.js`: exact native close-message construction, connection release and sticky SSE fallback.

Retest these contracts after host upgrades. The legacy close-only guard needs no core fork. Structured category preservation needs the separately reviewed additive SDK observer; the host adapter and native retry engine remain unmodified.
