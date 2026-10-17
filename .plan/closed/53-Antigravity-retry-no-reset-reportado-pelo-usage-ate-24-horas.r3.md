# Antigravity: retry on reset reported by usage up to 24 hours

## Request and goal
Goal goal-ca9a9885: automatically recover Antigravity requests at the exact reset reported by usage, waiting at most 24h; above that, show date and terminate. Do not infer windows or guarantee recovered quota. R1 investigated the API; r2 authorized a minimal local fork of the official executor, with stable provider bridge and policy budget. This r3 maintains the same scope and only corrects wiring based on real parser evidence.

## Wiring correction observed before publication
`applyEntryPatches` treats `name` as an identity guard, not a module replacement; the offline gate rejected the r2 proposal. No live change was applied. Therefore, disable native id `llm-retry` and insert a profile-local entry id `antigravity-quota-retry` with absolute module `plugins/antigravity-quota-retry/index.mjs`. An id without the `alex` prefix prevents activation tools from removing manual entries. Exactly one active engine, same `llmRetry` projection, and same official protocol/events. The parser/compose gate verifies original id disabled, unique local entry, and preserved configurations. Previous preparation remains abandoned evidence; use a fresh backup/receipt for corrected wiring.

## Contract and provider
Opt-in `quotaResetRetry` enabled/maxWaitMs<=86400000, default disabled; enable for `dsh-tui` only. Following a typed RATE_LIMIT/QUOTA_EXCEEDED failure, query `usage.snapshot(refresh:true,signal)`, exact native id of request/prepared snapshot. Fresh valid metadata and unchanged generation; missing fraction is unknown, never 0%. Future reset reported = forecast, not guarantee.

Target is the later of reset and minimum Retry-After/RetryInfo anchored to failure observation. <=24h eligible; >24h date/limit and fail-fast. Do not anticipate hints, invent resets, equate models, or poll. Without eligible metadata/reset, preserve transient rate-limit retry 20min; explicit quota without reset is terminal. Auth/billing/policy/aborted/timeout/unknown are not covered by this recovery.

Bridge request-local/ALS, stream and prepared.stream, frozen model, canceled/disposed/epoch invalidated fail-closed; usage existing service deadline 10s/cache/singleflight, no reading secrets in diagnostics. Do not sleep/resend inside adapter. Eligible failure emitted as ANTIGRAVITY_QUOTA_RESET; above cap ANTIGRAVITY_QUOTA_RESET_LIMIT with safe ISO dates/status/hint. Normal policy 9 records gate code once; single identity and counter between quota/transient. Current selfheal allowlist does not recover new codes/429 statuses.

## Local executor and config
`plugins/antigravity-quota-retry/index.mjs` derived from officially installed with hash/provenance; canonical host imports. Same projection/schema/version/policyKey/retryId/budget/events/normal/always/downstream/cancel/dispose. Only extension: google-antigravity + normal + allowed gate code + positive hint up to maxQuotaWaitMs default 24h uses separate quota cap, without changing maxDelayMs 20min/policyKey. Invalid/above-cap gate does not become local delay. Other providers/mode always behave like original. One timer engine only. `llm/retry` persisted before wait, `llm/retry-started` on wake.

Profile config: original `llm-retry` disabled + local id insert; Antigravity quotaResetRetry enabled 24h. Codex 9/search/model/selfheal intact. No SDK/node_modules/host contract changes, installs, budget resets, model/account/route/credit rotation, inference quota burn, auto-restarts, or cold resume. Process/session must remain alive for the wait.

## Mandatory gates
Provider pure tests reset minutes/hours/exact 24h/>24h/past/missing/invalid/NaN observed; fresh/model match/fraction missing/hint later/clock. Bridge cancel/lifecycle/epoch/prepared snapshot/concurrency/secrets. Differential engine against official for unaffected cases and quota budget <-> transient 9, gate/config/max 24h/cancel/dispose. Full native Loop + Sessions + Projections + Tools + candidate fake HTTP/fake clock: 429/structured quota -> fresh usage -> wait -> CLIENT dispatch 1 + success, zero effects failed, exact 24h, longer hint, >24h without timer, missing reset fallback 5s/permanent quota, ninth transient 20min, mixed 9 budget, cancel/dispose. Without claiming Google recover true.

Standalone source regressions, strict TS/declarations/public consumer (reviewed skipLibCheck), frozen esbuild candidate in `.dumps`, root contracts 76/grammar, native actual profile `applyEntryPatches` and config schema. Compiler/source hashes preserved, generated lib not hand-edited. EN/ZH docs keep commands metadata-only and feature opt-in explicit. Do not touch parallel publication task 52.

## Promotion and real query
After gates: only `lib/index.js`, affected declarations `index/usage/failurebridge/newquotaretry`, profile YAML; new durable backup `~/.local/share/dsh-customs-backups`, before/new snapshots, source/CAS preflight, atomic per-file rename + fsync and partial/verified receipt. CAS rollback refuses later edits; new files native trash after hash. Do not promise multi-file atomicity. No commit/push/restart. New TUI required.

Up to 3 explicit metadata-only queries using official manager for current reset, stop on 429/auth/deadline; normal OAuth refresh may persist token; safe date/model/fraction output. No live inference. 1 query already executed without OAuth/inference: Claude reset 2026-10-17T23:13:12Z (fraction unknown), >24h; GeminiFlashLow reset 2026-10-14T01:09:46Z / fraction ~98.25%. Do not repeat unnecessarily.

## Acceptance
Request with eligible reset waits and retries through the minimal official fork in loop, shared 9 budget/transient 20min; >24h shows date and terminates. Provider 341 tests, engine 17, native 18, and root 76 + grammar previously green; final corrected wiring regates, compiled hashes/public API/promotion must be collected before closing. Document limits: alive process/provider forecast/real unobserved recover.
