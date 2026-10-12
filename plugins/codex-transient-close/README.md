# Codex transient close normalization

A small **official `llm/stream` middleware**, not a new retry engine. It converts only a native Codex error finish with `PI_AI_ERROR` and the exact message shape `WebSocket closed 1000 [reason]` or `WebSocket closed 1012 [reason]` to `TRANSPORT` before the agent commits its failed attempt.

All other chunks and finish facts are retained. Requests are never mutated, `next()` is called once, and middleware exceptions are not caught. There is no timer, socket manipulation, model request, tool execution, or retry loop in this plugin.

## Scope and fail-fast rules

Eligible requests must be marked by the **same running host's** public `isAgentLoopRequest()` API, have provider `openai-codex`, and have no auxiliary `purpose`.

The plugin does not normalize:

- unmarked calls, other providers, `compaction`, or `session-title`;
- cancellation, an aborted finish, or a failure whose code is not `PI_AI_ERROR`;
- another close code, a merely embedded close message, or multiline messages;
- HTTP 4xx facts or close reasons mentioning credentials/authentication, quota/billing, policy violations, or oversized payloads.

These exclusions intentionally favor fail-closed behavior over broad error recovery. New close codes require explicit review. `PI_AI_ERROR` must **not** be added to generic retryable codes; `always` and infinite retries are not required or recommended.

## Official policy and audit

The installed `@deepseek-ai/dsh-llm-retry` plugin still owns recovery. Its unchanged normal defaults are five retries after the original request, exponential delays starting at 500 ms, maximum delay 10 seconds, jitter 0.1, and transient codes including `TRANSPORT`.

Failed chunks become `assistant/attempt`, not a successful `assistant/message`. The official loop evaluates recovery only after that settlement and dispatches CLIENT tools only after a successful assistant message. The retry plugin records `llm/retry` before its cancellable wait, then `llm/retry-started` before the next attempt. The budget is per provider/policy/step, not a global overnight budget. A failure after exhaustion still terminates the turn.

This delivery leaves the provider policy unchanged. A later reviewed route-specific policy can use normal mode, 5–8 retries and a 30-second maximum delay. Policy edits during an active chain can create a different budget key; avoid live policy reloads during recovery.

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

## Socket and compact-summary limitations

The previously audited installed pi-ai implementation clears the cached continuation and releases/discards a failed Codex WebSocket connection, then marks the session for sticky SSE fallback. The separately maintained updated pi-ai fork narrows that sticky fallback to close 1009 (oversized messages); transient closes 1000/1012 can use a fresh WebSocket instead. Which behavior is active depends on the deployed pi-ai version and must be verified during the host deployment gate. In either case, the next official attempt rebuilds context from durable history. This plugin does not reset fallback state, close other sessions, or change transport options.

Auxiliary compact-summary calls are deliberately excluded. `compaction/summary-error` is a synchronous boolean hook requiring durable progress in selected input; it cannot safely await a transport backoff. The official model-step retry engine does not automatically budget compact-summary requests. `compactionRetries` is about pressure after successful compactions, not transport errors. Thus this patch mitigates observed conversation-step closes; it is not a guarantee of uninterrupted overnight execution or process supervision.

CLIENT-tool non-execution on failed streams is covered by tests. Provider-hosted tools, billing and remote effects may already occur before the client receives an error; there is no exactly-once guarantee for them. The fixture only registers a side-effect-free local tool spy.

## Offline tests

```fish
node --test plugins/codex-transient-close/codex-transient-close.test.mjs
```

The integration tests use fresh Worker module graphs with actual official Cordis, loop, session, projections, tools and retry plugins; only the provider adapter and tool body are fake. Network APIs are blocked. They prove:

- without this plugin the original Codex `PI_AI_ERROR` fails with no retry;
- incomplete **and complete** tool chunks followed by failure execute no tool during failed settlement/backoff; retry success executes the local spy exactly once;
- retries use fresh live attempt IDs in the same step and omit failed partial chunks from request history;
- the unchanged official maximum of five retries gives six attempts, five audit pairs and zero tools on exhaustion;
- cancellation and official retry-plugin disposal during backoff prevent a new attempt; concurrent agents have independent budgets, and the next turn gets a fresh budget;
- listener disposal/reload does not retain duplicate wrappers, and observer/middleware failures remain thrown;
- strict negatives and preservation of finish metadata/chunk identity.

The integration clock uses 1 ms backoff to avoid spending production delays in an offline test; the policy-default test separately asserts 500/10000 ms and jitter 0.1.

## Audited upstream

Installed official version: `@deepseek-ai/dsh-llm` / `dsh-llm-retry` **0.2.0-rc.2**, Cordis peer `~4.0.4`. Public source repository recorded in installed package metadata: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

Relevant installed evidence:

- `dsh-llm/lib/types/index.d.ts`: public `llm/stream` waterfall, immutable loop requests.
- `dsh-llm/lib/index.js`: `streamWithRegistration()` wraps prepared calls too.
- `dsh-agent-loop/lib/index.js`: failed settlement before recovery, successful settlement before tool dispatch.
- `dsh-llm-retry/lib/index.js`: durable bounded recovery, cancellation and disposal.
- `dsh-llm-pi-ai/lib/index.js`: native classification misses `WebSocket` as a standalone `socket` token.
- `@earendil-works/pi-ai/dist/api/openai-codex-responses.js`: exact native close-message construction, connection release and sticky SSE fallback.

Retest these contracts after host upgrades. No upstream library modification or core fork is needed.
