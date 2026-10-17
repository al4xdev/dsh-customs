# Self-heal v7 / controller v6: Agents Never Stop, One Warning Per Chain

## Owner Request (2026-10-16)
"The idea is retrying so agents never stop, including some that have quotas (like Google Antigravity) that reschedule as soon as the quota resets. Self-heal is the exact same idea: we don't blindly resend the same request (it might fail identically); we encapsulate the error and warn the model via simple text, without tooling, that something failed in the turn, and we try again (sometimes it's a temporary server error that resolves shortly)."
Approved: unbounded retry, one warning per chain (short text), doctor, and portable tests.
This **revokes** two decisions from task 112: "there is no 11th attempt" and "append a warning on each failure" (§3).

## Evidence (Real Session Today, Vertex Route, Internet Dropped)
Turn 3 step 11: five `llm/retry` TRANSPORT (7.03 s → 112.5 s), recovered on the 6th attempt. Each cycle inserted an ~880-byte `user/message` "harness warning: … retry N of 10"; all five remain in history. Independent reviews (Sonnet and Opus) confirmed: correct flow for transient classes, accumulation by design (tests enforce 11 warnings), v5/v6 bundles without drift.

## Specification
1. **Unbounded for transient classes** (TRANSPORT, TIMEOUT, SERVER, RATE_LIMIT, EMPTY_RESPONSE, PI_AI_ERROR, ANTIGRAVITY_QUOTA_RESET, AGY malformed call): the first 10 wait intervals retain the current scale (7.03125 s · 2^(n-1)); afterwards, wait remains at the cap (60 min) indefinitely. Terminal classes (AUTH, billing QUOTA, credentials, 4xx) remain non-retrying. Existing explicit opt-out (`maxRetries: 0`) remains valid; an explicit finite limit from the owner continues to be honored.
2. **Quota reset / Retry-After above 60 min**: wait until the indicated time, bounded by a quota wait cap (default 24 h; the profile already declares `quotaResetRetry.maxWaitMs: 86400000`) instead of suspending. Invalid hint is non-terminal: falls back to normal backoff.
3. **One warning per chain**: warning `user/message` only on the 1st failure of the chain and again only if the error code changes. Subsequent cycles retain only the `llm/retry` mirror (UI). Short text, without counter ("retry N of M"), keeping the prefix `harness warning:` and the marker "internal harness note, not a user request" + allowlisted facts (code, summary, remediation).
4. **Non-silent refusals**: every refusal / "unsafe" state records a fixed reason (log), without private data.
5. **Persistence**: new policy version in audits; readers accept legacy audits (v2). Rollback to v6 after new audits is not a safe downgrade (same precedent as V2).
6. **New immutable bundles**: `agent-self-heal/lib/index-v7-unified.mjs` and `llm-resilience/lib/index-v6-unified.mjs`, each with `.build.json` (esbuild 0.28.2, target node24, source hashes, rollback = v6/v5). v5/v6 remain untouched.
7. **Wiring**: builder, `plugins/activation.json`, `tools/resilience/profile.mjs`, `tools/clean-install/{install,inventory,profile}.mjs`, READMEs; profiles via `activate`.
8. **Doctor** in `tools/` (unbundled): persistence bridge present in installed SDK and correct owner/controller in profiles. **Portable tests**: no `/home/alex` in self-heal/resilience/codex-transient-close tests and in `install-persistence.mjs`.

## Desirable (If SDK Allows Without New Patch)
Human message during a long wait immediately wakes the retry (currently sits in inbox until the wait ends; only cancel aborts).

## Acceptance Criteria
All test suites green (self-heal, llm-resilience, codex-transient-close, resilience, clean-install, lts:contracts, portable, research); new tests for: retry beyond 10, quota wait > 60 min up to the cap, single warning per chain and new warning when code changes, refusal logs; offline scenario of real session reproducing 1 warning instead of 5.

## Checklist (Implementation 2026-10-16)
- [x] 1. Unbounded for transient classes: omitted `maxRetries` = sentinel `UNBOUNDED_RETRIES` (`Number.MAX_SAFE_INTEGER`); first 10 wait intervals on current scale, then 60 min indefinitely; terminals remain terminal; `maxRetries: 0`, recorded opt-out, and explicit finite limits honored; legacy chains (owner6, cap 10) remain finite.
- [x] 2. Provider minimum (`providerRetryAfterMs`, generic across any adapter) honored up to `maxProviderWaitMs` (default/max 24 h); exceeding → visible suspension (`provider-wait-over-cap`); invalid/zero hint → ignored, normal scale.
- [x] 3. One warning per chain (1st failure; new one only with different code; cap of 8 per chain against alternation); short text without counter; `harness warning:` + "internal harness note" + `code`/`summary`/`remediation`; terminal once per suspension.
- [x] 4. Non-silent refusals: fixed reason in log (owner, aux, and unsafe history with `unsafeReason`/`RecoveryHistoryError.reason`).
- [x] 5. Persistence: audit payload v2 / policy 3; v1/policy 2 remain readable; accounting stateVersion 3; ownership v2 (`mirrorRetry`). Rollback to v6/v5 after new audits is not a safe downgrade (documented in READMEs).
- [x] 6. New bundles `agent-self-heal/lib/index-v7-unified.mjs` and `llm-resilience/lib/index-v6-unified.mjs` + `.build.json` (esbuild 0.28.2, node24, rollback v6/v5); v1–v6 byte-identical. sha256 (rebuild after follow-up): owner7 `2c2118236ca25a5087cad71755c4ab76b5891b242591b821b727532be1a42777`, controller6 `a2c2460b1372995698b667bc424ed2c83f3adf233cecb126d16279db1b2f06db`; rebuild reproduces byte-for-byte (`reused: true`). The initial (unpublished) build was replaced.
- [x] 7. Wiring: builder (`tools/resilience/build-unified-recovery.mjs`), `activation.json`, `tools/resilience/profile.mjs` (accepts legacy paths; rewritten quota note), `tools/clean-install/{install,inventory,profile,smoke}.mjs`, READMEs.
- [ ] 7b. Real profiles via `node tools/activate.mjs --write` — **pending** (orchestrator rollout following review; nothing in `~/.dsh` was touched).
- [x] 8. Doctor `tools/resilience/doctor.mjs` (read-only; `npm run resilience:doctor`). Portable tests (no `/home/alex` in self-heal/resilience/codex-transient-close, `install-persistence.mjs`, and `plugins/common.mjs`).
- [x] Desirable: live human message immediately wakes local wait (provider minimum still holds; message enters on next step/turn — SDK does not allow claiming inbox mid-step without a patch).
- [x] Extra finding: owner6 `llm/retry` mirror violated session format v4 rule when chain continued on another step/turn (log did not reopen). Fixed in owner7.

## Pre-Rollout Follow-up (2026-10-16, Following Opus Review "Conditional GO")
Owner decision: keep unbounded retry for ALL transient/deterministic classes (EMPTY_RESPONSE, PI_AI_ERROR, malformed call, image/mtmd), without new caps.
- [x] Long wall-clock waits: slices of ≤60 s; ends when monotonic OR wall clock (durable `notBeforeMs`) covers wait; never earlier than provider minimum; cancel/HMR/wake maintained. Tests with jumping fake wall clock (8 h suspension during a 5 h wait).
- [x] `llm/retry` mirror: `failure` copied only with own data fields and without invalid `providerRetryAfterMs` (≤0/non-finite).
- [x] Doctor: owner before controller, missing `alex-codex-transient-close`, and duplicate `llm-retry` now fail; explicit finite limits become warnings.
- [ ] Wake on Companion message: **not implemented**. Delivery via bridge (`plugins/session/bridge.mjs:92`) arrives as `{role:'user', source:{kind:'user'}}` without `rpcId` or marker, identical to managed-plans `/plan new` (`plugins/managed-plans/index.mjs:184`) and other plugin dispatches; local path (`controller.mjs:292`) runs in sender agent's ALS. Ambiguous → requires fixed marker in bridge delivery (`plugins/session` owner).
- [x] Docs: sessions broken by owner6 (`llm/retry skips its policy attempt sequence` on reopen) and how to detect them; manual rollback procedure (one-way).
- [x] Read-only scanner `tools/resilience/scan-retry-ordinals.mjs` (+ test with real SDK fixtures, zstd per frame): lists ids/paths/rule/seq, and sessions with owner7 audits (`ownerV2`, unsafe rollback). No repair. Was not run against `~/.dsh/sessions` (rule: do not read real sessions).
