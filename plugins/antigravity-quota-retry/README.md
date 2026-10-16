# Antigravity quota-reset retry engine (retired historical fork)

**Do not activate `index.mjs`.** All five managed profiles use the shared
`llmResilience` recovery authority instead. Plan112 unifies the custom LLM
algorithms: ten retries, one contextual warning/admission per retry, and nominal
exponential waits with retry9 at30min and retry10 at60min. There is no independent
24h quota timer. A typed server minimum above the shared60min cap is a visible
suspension, not permission to retry earlier or start another engine.

`retired.mjs` is an inert compatibility marker: it requires the shared contract2
and refuses legacy configuration or an absent controller. It owns no listener,
projection, counter or timer. It is not added to any profile. The original
`index.mjs` remains byte-identical for provenance and historical rollback
evidence, **not** as another supported active policy. Native retry must also stay
disabled. Re-enabling the old fork is outside the unified deployment contract.

Non-LLM operations retain their own safety contracts: the unused Companion FCM
outbox is delivery/idempotence logic, not another agent recovery engine;
grammar correction's bounded reasoning-effort negotiation and120s deadline are
not permission to execute a second long-running transport retry loop. Browser,
session delivery, music and image-generation mutations are not blindly replayed.

## Historical implementation below — not activation instructions

Approved plan53r2 explicitly authorized this minimal fork of the installed official
`@deepseek-ai/dsh-llm-retry@0.2.0-rc.2` engine. It is **not an upstream API** and does
not modify SDK/runtime packages in `node_modules`.

## Provenance

- Canonical input: `/home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js`
- Input SHA256: `cbb99f1c5038e4a9167aedf333343cb3e3adfb5c9f45a37ef7562b024429d050`
- Upstream package repository: `https://github.com/deepseek-ai/deepseek-harness`, directory `packages/llm/llm-retry`.
- MIT license/copyright retained in `LICENSE`.
- `provenance.test.mjs` requires this exact baseline and proves the complete fork
  equals upstream plus five allowlisted replacements: host imports, quota config
  validation, capture quota cap, validate gated hints, accept their exact delay.
  Host upgrades require explicit review/rebase, not automatic source rewriting.

## Historical contract and wiring (do not apply)

Disable the native `llm-retry` entry and insert a profile-local
`antigravity-quota-retry` entry pointing to `index.mjs`; do not load both engines.
Native patch `name` is an identity guard, not a module-replacement operation. Public exports remain
`Config`, `RetryId`, `apply`, `inject`, `name`; there are no new testing exports.
Dependencies resolve from the running canonical host through `../common.mjs`.
A newly started process is required to load changed modules/configuration.

The executor accepts optional `maxQuotaWaitMs` (default `86400000`), positive
finite milliseconds no greater than 24h. Providers still own `retryPolicy`.
This fork has no `enabled` config: provider opt-in consists of enabling its
quota-reset feature and including `ANTIGRAVITY_QUOTA_RESET` in the **stable**
registered normal policy's retryable codes. Do not swap policies per failure.

Only `provider === 'google-antigravity'`, `mode === 'normal'`, and that exact
eligible code gain the quota-only delay allowance. The provider bridge must
emit this code only after typed quota/rate-limit failure plus fresh exact-model
usage supplies a valid future reset, respecting the later server minimum.
It supplies the remaining positive delay as `failure.providerRetryAfterMs` and
safe diagnostic text. The engine itself does not query usage or infer models,
reset windows, dates, credentials, or account state.

Eligible quota hints up to the configured ceiling are waited **exactly**, without
backoff/jitter. Missing/nonfinite/nonpositive/above-ceiling gated quota hints are
terminal; they never fall back to local backoff. A code not opted into the policy
retains the official downstream delegation behavior. Other providers and always
mode retain all official behavior.

The base policy stays normal9, initial5s, local/provider generic cap20min. The
same upstream policy key, projection `llmRetry` (version1/schema), retry identity,
and nine-retry budget cover quota and transient errors together. All event
commits, timers, cancellation and disposal remain the upstream implementations:
`llm/retry` is durable before waiting and `llm/retry-started` is recorded on wake.
There is no second scheduler. While quota waits are longer, generic local delays
and accepted generic hints still obey the unchanged20min ceiling.

Waits survive only while the process/session and signal remain active. They do
not guarantee Google's quota will recover, persist scheduling across exit, or
reopen the session after process restart. Outer turn deadlines may abort a wait.

## Offline validation

```fish
node --test plugins/antigravity-quota-retry/*.test.mjs
```

Tests execute the real installed official engine and this fork through a small
host event/projection fixture with a controlled clock. Differential cases prove
unchanged normal/always/backoff/jitter/server hints/other-provider behavior;
quota cases prove exact24h scheduling, stable shared budget9, invalid-hint gates,
policy opt-in, smaller quota ceiling, cancellation/disposal and step/turn resets.
The source-delta test prevents accidental changes in untouched upstream logic.
These are engine-level native-function tests, **not** a full agent-loop/fake-HTTP
fixture or a live inference recovery claim. Provider bridge, loop, tooling effects,
profile wiring and promotion gates are validated separately by plan53's owner.
