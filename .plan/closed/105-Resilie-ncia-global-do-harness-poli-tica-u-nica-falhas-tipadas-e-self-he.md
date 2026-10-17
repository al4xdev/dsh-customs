# Global harness resilience, independent of provider

## Objective and guidance

Use the active goal as execution anchor after approval. Implement a common recovery base for any model/provider passing through the DSH LLM service, whether native adapter or pi-ai. New providers receive the base without requiring an entry in a list. Provider peculiarities add normalizations/extensions; they are not the source of standard resilience.

This is not a patch exclusive to Bonsai, Codex, or Antigravity. Do not alter server, 128k context, sampling, speculative decoding, models, credentials, or permissions. External CLIs and tools with side effects will not be retried automatically.

## Evidence already gathered

Audit in `.dumps/tasks/retry-policy-audit.md`, scripts/tests in the same directory; 24 offline checks passed. Effective composition: Codex/AGY normal 9, 5s→20min, jitter 10%; strata-local default 5, 0.5s→8s across five delays. Current engine named antigravity-quota-retry is general, but long configuration and structured bridge were concentrated in specific providers.

Real MTMD arrived as PI_AI_ERROR, outside normal retry. Self-heal made 3 immediate attempts; notices discarded the message and showed only unclassified error. Common infrastructure exists, but not an effective global policy and uniform diagnostic coverage.

## Proposed initial policy

- A single authoritative central definition: normal mode, 9 retries after initial attempt, exponential 5s backoff, 20min ceiling, 10% jitter.
- Common codes: EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, with typed classification and precedence of cancellation/permanent errors.
- This profile sums to 41min15s of nominal waits, not guaranteed hours; execution, jitter, and Retry-After modify the real duration. Do not silently raise to 20 retries / 4h21min15s. The duration can be modified at a single configuration point later.
- Sparse and explicit exceptions, without copying the entire policy per provider. Migrate known configurations and preserve deliberate opt-outs; already resolved native policies do not allow guessing the difference between omission and override, therefore document central authority and precedence without heuristics based on value comparison.
- Respect validated Retry-After. Do not anticipate server minimums or turn a hint above accepted limit into an earlier attempt.
- Preserve AGY quota extension: typed code / opt-in only with validated reset, up to 24h. Quota and transients share the same finite counter, as today.
- Self-heal: keep 3 cycles per episode and their proofs of resumption/progress; add nominal 5/10/20s delay with jitter via common controller. Do not renew transport budget when injecting notice.

## Architecture

### 1. One controller and two drivers

Create a global resilience plugin, with separate modules for policy, classification, controller/scheduling, loop driver, and auxiliary driver. The controller has admission, counters, delay calculation, cancellation/dispose, and diagnostics. Self-heal requests limited recovery from the same scheduler, rather than creating a third engine.

The new plugin replaces the antigravity-quota-retry fork; native llm-retry remains disabled in this composition. Do not load two engines or enable pi-ai SDK internal retries. Preserve native context/image recovery as a specific transformation, without duplicating backoff.

Primary driver uses agent/request-error after durable assistant/attempt and before any dispatch of completed tool. Maintain turn/step, new attempt, durable context, and compatible projection/audit. Auxiliary driver unconditionally ignores objects marked by isAgentLoopRequest of the SAME host module; a primary failure does not pay two delays.

### 2. Auxiliary calls, including compaction

Cover calls through the LLM service regardless of provider. Compaction and other explicitly replay-safe purposes have private per-attempt buffer; only the winning attempt is published, exactly once. Initial limits: 16MiB and 65536 chunks per operation; respect caller's AbortSignal/deadline. Upon exceeding limit, fail explicitly without unsafe replay.

Arbitrary auxiliary calls cannot be retried after exposing output/effects; recover prior to exposure or require an explicit replay-safe contract. Do not promise universal safe replay for unknown consumers.

Do not retry Cordis waterfall next(): it consumes the chain. Use new redispatch from LLM service, with local bypass of this layer valid throughout the iteration, to re-execute remaining middlewares. PreparedLlmCall.stream is one-shot: each attempt requires new preparation. Check replay support/contract of prepared callers; no monkey-patch of private registry or promise of non-existent generation pinning in public API.

Do not place Promise/backoff in compaction/summary-error, which is synchronous. Do not retry compactRegion/compactNow or already executed tools: only generation of summary before commit. Prove a single commit.

Native llm/retry events require turn/step and compatible provider; do not invent them for manual/idle compaction or different auxiliary provider. Initially, auxiliaries use in-memory counters and safe diagnostics external to mandatory journal. Do not call append(..., {ignorable: true}), as current API ignores this field. Do not promise automatic continuation of auxiliaries after crash/restart. Any required protocol/persistence extension outside these contracts requires specific review before promotion.

### 3. Preserve typed failures, without relying on text

Generalize SDK portable failure observer and public llm/stream bridge. A single subscription/bridge must own structured facts, including for Codex; keep only its narrow historical WebSocket fallback as exception. No two observers classifying same stream end.

Detached/frozen DTO selects provider/API, neutral category, safe fixed message, real status, validated requestId, and validated Retry-After. Never export body, full headers, cause/stack, cookies, tokens, or account. Preserve permanent/cancellation facts above transient categories. Do not infer HTTP 503 from wording or HTTP 200 from a stream; unknowns remain unknown. Do not make entire PI_AI_ERROR retryable.

Classification must operate per API/contract, not by model name or provider list. Audit and instrument final catches of 10 installed KnownApi: openai-completions, mistral-conversations, openai-responses, azure-openai-responses, openai-codex-responses, anthropic-messages, bedrock-converse-stream, google-generative-ai, google-vertex, and pi-messages. Also preserve SSE facts before throws that currently convert typed payload to text, especially Responses/Azure. Future or custom APIs continue inheriting global policy for neutral failures; publish capability matrix and do not claim structured preservation where adapter does not provide it.

SDK helper without scheduler/ALS. Harness bridge with context per dispatch and next/return/throw, isolation of concurrent and nested calls, termination after finish/abort, and rejection of foreign/late facts. Typed native adapters pass intact without corresponding DTO.

Do not blindly rebuild sources/pi-ai: that snapshot is behind installed observer. Start from verified canonical state and maintained recipes, preserve previous patches, and produce custom candidate/allowlist/hashes. Previous promotion tools are Codex-specific and do not authorize this new change.

### 4. Useful and compatible self-heal

Preserve durable counter, reservation before admission, deduplication, suspension, causal human resumption authorization, and proof of progress. Do not rearm on reloading configuration, switching policy, or admitting observation itself. Cancellation/dispose supersede delay and prevent retry.

Safe and specific diagnostics: category, phase, typed facts, attempts/delays, and relevant revised guidance. Do not forward arbitrary raw text or grant new permissions. Configured generic route must not lose useful information merely because it is not Codex/AGY.

Compatibility: keep legacy action/version/state readable. Delays may have additive metadata on top of existing events, without incompatible new fields in strict state or new actions breaking earlier readers. Prove reopen/rollback in fixture. Do not claim notice allows model to fix server if no inference produces a response.

## Mandatory validation

- Unlisted artificial providers, local OpenAI-compatible, Codex, AGY, and native adapter inherit same base; explicit precedence/opt-out/extensions.
- Typed HTTP 5xx with opaque text, transport, timeout, generic 429 versus named quota; 401/403, 400/413, policy, context, cancel, and unknowns do not become blind loops. Fixtures per API and SSE when applicable; verified capabilities.
- Real fixture of pi-ai adapter + same SDK/observer, HTTP 500 response with MTMD message, preserved status/hint/id, retry by controller. Do not assert real case had status 500 if that fact was not captured.
- Schedule 9, jitter/cap, hints, 24h quota, exhaustion, persistence of main budget, no silent budget renewal, and exactly one delay per decision.
- Self-heal 3 with delay, safe diagnostics, secret/instruction canaries, reservations, cancel/dispose, progress, and causal resumption; legacy/new readers and pre-existing sessions.
- Auxiliaries: main-bypass, redispatch traversing all middlewares, prepared one-shot, discard of failed partial, single winning publication, limits, early-return, concurrency, nested calls, and cancellation.
- Automatic/manual compaction and with alternative provider: recovered summary and single commit, without altering thresholds/context.
- No client tool executed during failed attempt / backoff; success executes only what native loop admitted. Do not promise exactly-once for remote/hosted effects or crash after effect without receipt.
- Existing regressions of Codex/AGY/self-heal/compaction and module identity in new process. Offline tests with simulated clock and blocked network; no paid calls.

## Integration and safe promotion

Record in shared recipes/manifest and prove composition across all maintained compatible profiles, including dsh-tui and headless/Companion derivations where they use canonical host. Global means all providers in LLM service of each loaded host, not silently altering old/incompatible npx processes. Validate compatibility before activating in another host.

Remove known duplication of baselines per provider without deleting model/OAuth configuration or exceptions. Promotion must not indiscriminately sync drift from foreign plugins. Preserve existing concurrent changes in repo/frontend/manifest.

Isolated candidate, tests, hashes/allowlists, and reviewed receipt; recoverable backups and CAS/preflight of exact files. No ad hoc edits in node_modules. Publication is not multi-file atomic; have rehearsed rollback and reject altered baseline. Do not restart running TUI, server, service, or agent. Validate in isolated new process; inform of need to reopen TUI when owner is idle.

## Completion criteria

Code and configuration have a single global policy source and one controller, without per-model timing branches; exceptions are bounded. Matrix of APIs/callers reports real coverage and limitations. Tests and composition prove above contracts, documented artifacts/rollback, and validated application without interrupting owner's work. Close goal only after verifying authorized effective result.
