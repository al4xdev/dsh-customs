# Unified contextual recovery of the harness

## Confirmed request
The user requested removing blind retry chaining that prevents self-heal from communicating the error, unifying custom LLM recovery mechanisms, and using up to 10 additional retries. Confirmed that 60min is the interval of the final attempt, not the total duration. The initial call does not count as a retry.

Nominal schedule without jitter: 7031.25; 14062.5; 28125; 56250; 112500; 225000; 450000; 900000; 1800000; 3600000 ms. Each interval doubles; 9 = 30min and 10 = 60min. Summed delays 7192968.75 ms (~1h59min53s), plus execution time. They remain cancellable; there is no attempt 11.

## Proven current failure
`agent-self-heal/index.mjs` awaits downstream before admitting observation. The current main-driver consumes technical retries, and the self-heal sanitizer accepts only PI_AI_ERROR, EMPTY_RESPONSE, and a known form of invalid call. Thus SERVER passes through blind retry, not through the message. Currently there is a budget of 9 + 3 and two backoff parameters, contrary to the new intent.

## Scope and architecture
1. A single algorithm and policy authority for custom LLM retries. Exactly one durable reservation per retry in the agent chain; no multiplying 10 technical by 10 semantic. Switching error type, warning message, a reload, or fresh preparation does not grant another budget.
2. A single recovery owner in the main flow. The new contextual self-heal admits safe diagnostics BEFORE next preparation and does not call the competing technical engine to perform the same recovery. Retain native retry projection/UI if necessary, but remove duplicated blind retry function. Upon exhaustion, admission failure, or cancellation, do not fall back into another engine; terminal error must remain observable, not swallowed.
3. For each eligible failure, append a notice literally identified by `harness warning:` with code, available reliable status/facts, attempt/limit/delay, and guidance to continue authorized task without repeating completed tools. Do not copy HTTP bodies, tokens, headers, stacks, or arbitrary remote instructions into prompt. Use constants and allowlisted facts; reviewed diagnostic signatures may select fixed text. New error after final attempt must produce explicit termination and diagnostic, not silence or yet another hidden cycle.
4. Next call must be prepared anew from updated context. Tools from a failed attempt remain undispatched; results of already completed tools are preserved. A message does not remove retained images and does not allow model to reason prior to a successful prefill. Do not add automatic offload, model/backend change, restart, or claim of multimodal cure in this task.
5. Same policy/scheduler for custom auxiliary LLM calls. For compaction/titles and other flows admitted by replay contract, retry requires safe diagnostic context compatible with original request, preserving output format, obtaining a fresh stream, and discarding losing attempts. Do not fabricate turn/step events or durable agent messages for consumers lacking this context. When safe replay/admission is not available, fail explicitly rather than blindly resending.
6. Audit old custom plugins, including AGY quota and Codex classifiers. Classifiers gain no separate timer. Legacy LLM retry implementations must delegate to shared authority, become explicitly inactive/deprecated, or reject concurrency; do not keep independent formulas active. Retries for filesystem, RPC, OAuth/login, and tools with their own effects do not automatically become LLM retries; do not repeat paid generation or completed tool.

## Policies and security
- Global default 10, base 7031.25 ms, cap 3600000 ms, and jitter 0. Explicit overrides/opt-outs already authorized must not be silently expanded; any conflict must appear in migration report.
- Recoverable technical failures (including SERVER/transport/timeout/rate-limit/empty) pass through contextual recovery, as do finitely admitted opaque errors and specifically recognized malformed calls. Cancellation, invalid credentials/permissions, invalid context, and permanent denials receive no generic bypass.
- Typed Retry-After/reset cannot create an additional engine or wait above the 60min cap. If minimum demanded by server exceeds authorized limit or is invalid, suspend with explicit diagnostic rather than pretending waiting less satisfies the minimum.
- Preserve consumed counters and caps already fixed in legacy episodes. If additional markers are needed, use compatible/auditable envelopes; do not rewrite history or silently increase an old chain. Required projections/events must remain readable by installed native bridge. UI mirrors cannot be double-counted.

## Delivery and activation
Create immutable compiled artifacts with new names for controller and self-heal (e.g. contextual controller v2 and self-heal v4), manifests, and hashes. Preserve old v2/v3 bundles byte-for-byte. New names avoid reliance on invalidating ESM cache in running processes; already loaded SDK namespace remains with documented limitation. Do not modify pi-ai SDK published in task 105 unless new demonstrated and reviewed need arises.

Update single policy source, schemas/types, activation/bootstrap, pure profile migrator, builder, clean-install recipe, and documentation. After testing and hash review, prepare candidates and backups of web/headless/tui/dsh-tui/companion profiles. Publish one file per operation with CAS/hash/mode and receipt, without full-sync of unrelated plugins. `cordis.yml` is derived cache per previous native qualification; observe, do not manually restore/rewrite. Do not execute native --dump-config in real DSH_HOME.

## Mandatory checks
- Ten correct delays with simulated clock, 9 = 30min / 10 = 60min; no 11; correct accumulated duration.
- SERVER is not swallowed by technical retries before observation; first retry and subsequent receive safe warning in prepared request.
- Repetition of same error, code change, reload, plugin order, and controller switch do not renew credits; consumed legacy remains conserved.
- Abort/dispose during warning/wait/preparation stops promptly and does not trigger another engine. Append failure/ambiguity does not automatically retry admission.
- Exhaustion is visible to user and preserves error/terminal state; auth/permanent/opt-out without bypass.
- Partial tool from losing attempt is not executed; winning tool and already completed tools are not repeated.
- Compaction/titles: fresh-stream, diagnostic context, safe buffering, preserved formats, and no false agent audit.
- Real Cordis/loop/adapter fixtures with in-memory HTTP and blocked network; no paid inference, restart, backend/model change, or business session mutation.
- Immutable build / rollback hashes, recipe/bootstrap tests, five isolated native compositions, models/permissions/compaction/unrelated config preserved; final read-only check of published files.

## Conclusion
Use active goal as guide and close it only after implementation, tests, and verified activation. Report exactly what was unified, finite limit, and any legacy components deliberately excluded, without promising that a permanently broken backend will never interrupt work.
