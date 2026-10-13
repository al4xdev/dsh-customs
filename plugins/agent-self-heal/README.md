# Agent self-heal (phase 1, consecutive-episode policy v2)

A public agent-loop recovery middleware, not a synchronous LLM retry engine.
Source is not activated by this directory: the principal owns reviewed profile
wiring and rollback. Plugin name: `alex-agent-self-heal`; required services:
`agents`, `sessionProjections`. Configuration: `{ maxCycles: 3 }`, integer 0..10;
zero disables observation admission. No model, credential, account, credit,
permission, output-cap or timeout setting is changed.

## Sequence and audit

1. Await downstream `agent/request-error` listeners first. The official retry
   policy retains priority and its budgets/delays are unchanged.
2. Require the exact live agent and a public committed `assistant/attempt` end
   frame for the failed turn/step. A failed attempt is already settled; no client
   tool from that failed attempt has been dispatched.
3. Append `agent/self-heal` with `reserved` state, consuming a repair cycle.
4. Append a synthetic `user/message` with source `self-heal-observation`,
   `label: Self-heal`, `form: notice`, and a short fixed summary. It is explicitly
   not a new human prompt. Selected error facts are quoted untrusted data, not
   commands, authority or permission to bypass a restriction. Canonical
   `sourceEventSeqs` links the notice to the prior committed failed attempt.
5. Append `observation-admitted`, then `retry-requested`, check cancellation,
   and return the public `{ kind: 'retry' }` action.

These operations are **not atomic**. Abort or uncertain/failed append prevents
our replay decision and records `aborted`/`append-failed` when possible. A spent
cycle is never refunded. Deduplication uses the failed attempt's durable sequence;
concurrent callbacks cannot admit the same observation twice. On retry the host
re-prepares its provider call and rederives messages from the same session. No
`steer`, inbox wakeup, foreground follow-up or goal continuation is scheduled.

The `agentSelfHeal` checkpoint stays at stateVersion 1, with optional policy-v2
fields so existing spent budgets remain readable. The original episode turn/step,
cycle/cap, failed-seq dedupe, admission references and `lastRecovered` survive
series/surface changes, config increases, reload and old full-state audit replay.
Native witnesses contain only bounded numeric seqs/counters and known enum tags.
Session history deletion or restoring an older external backup cannot be repaired;
the host log/checkpoint participants own persistence, not a universal disk flush.

### Healthy step commit

Native `step/end` contains only `{turn, step}` and is appended in **finally**.
It is not proof of success. A candidate requires a matching `step/start`, one
non-interrupted committed model `assistant/message`, explicit `stop`/`tool-calls`
finish, actionable text or calls, and all requested tool results non-error with
their canonical `sourceEventSeqs: [toolCallSeq]`. Partial/thought-only/empty/
MAX_TOKENS output, missing/duplicate/failed tools, replacements and incomplete
steps do not qualify. This observes results; it never re-executes a CLIENT tool.

The projection stages that witness. Outside publication, a coalesced tracked
microtask checks the exact live agent/session, native candidate and episode,
and public turn signal. Only a matching `recovered` audit with `progress.kind:
'healthy-step'` commits renewal. Abort/error/max-tokens turn termination removes
eligibility; cancellation/disposal before the acknowledgement wins. A fake
healthy snapshot cannot manufacture the native witness. V1 `recovered` receipts
without a progress tuple replay only after the full healthy native step plus
its completed turn and exact legacy causal seq/original recovered-chain snapshot.

### Live human checkpoint resume

A source label `user`, a surface append or a goal continuation is not authority.
The live native inbox insertion must retain **no Agent initiator**, have the
controller's user/RPC source, and match its just-committed `next-turn` splice.
An ephemeral grant is consumed on the matching native claim. Only subsequent
`agent/request` with a real entered `step/start` and live signal can commit a
bounded `manual-resumed` receipt. Discarded/rejected proposals never reach that
boundary. Model/peer-initiated fake user/RPC messages cannot mint a grant.
Pre-step replacement of messages does not erase the already admitted root gesture.

The receipt stores only causal numeric seqs and known enums, not prompt/RPC IDs
or content. `lastManualResume.previousChain` preserves the old spent episode;
`lastRecovered` and failed-seq dedupe are not erased. Old inbox/user labels on
cold replay cannot create new authority; an already committed owned approval
receipt can replay. This assumes trusted kernel/plugin producers, **not
cryptographic authentication of arbitrary privileged JavaScript**. No goal
activation, wakeup, pause/reschedule/rearm or model call is performed by renewal.

## Eligibility and privacy

- Frozen, validated host `PI_AI_ERROR`: diagnostic summary is fixed; the original
  arbitrary message is **discarded**, not regex-redacted into claimed safety.
- Repeated `EMPTY_RESPONSE`: occurrences are recorded across official delegated
  retries. The first occurrence without a prior retry is observed, not replayed.
- `INVALID_REQUEST`: only an exact own Antigravity malformed-function-call marker
  proves the narrow correctable case. Generic invalid request is not eligible.
- Auth, quota/billing, rate limits, context overflow, cancellation, known policy
  blocks and other 4xx facts do not receive blind replay. Positive provider wait
  hints suspend rather than being ignored or starting a second backoff engine.

The observation/audit selects code, fixed summary, validated status/hint, known
own phase, configured public provider/model family, output cap and nonnegative
integer usage counters. It never copies raw bodies, headers, request options,
causes, stacks, cookies, URLs, account data or hidden thinking content. Foreign
or malformed DTOs/accessors are rejected; unknown route labels are omitted.
Existing upstream logs are not retroactively scrubbed by this plugin.

## Limits and suspension

Default repair budget is three cycles per consecutive failure episode,
independent of other agents. Raising config cannot enlarge an already active
chain's cap. Exhaustion records `suspended`, then permits the current known host
termination. The durable objective is not completed, blocked or deleted; its
activation may be disarmed by the goal driver. This is a recoverable checkpoint
for an admitted human resume, **not automatic pause/reschedule/rearm**. Proven
healthy progress closes the episode; the next failure starts at cycle one. Three
failures without progress still exhaust the original cap. Increasing config,
adding self-observations or reloading never renews that episode by itself.

The same failed step's assembly/tools/rendered prompt remain frozen. A model
cannot fix a tool schema or invalid provider knob that rejects every inference
until an independently approved deterministic fix exists. This middleware does
not change those inputs. Thrown prepareCall, stream-consumer and settlement
exceptions can bypass the public request-error hook; they are not universally
self-healed. Tool-result errors already belong to ordinary agent history. Client
side-effect dispatch is owned by the host loop; hosted/remote effects have no
exactly-once guarantee. Caller cancellation and plugin disposal win.

## Gates

`node --test plugins/agent-self-heal/tests/*.test.mjs` runs pure sanitizer and
ledger gates, with token/cause/directive/hidden-content canaries. Native host,
SDK, projection/notice, tool dispatch, cancellation, reload and goal lifecycle
fixtures are separate principal/e4 deliverables; pure tests do not claim them.
`types.d.ts` declares the public message source, audit event and projection map.
No live provider or real credential is required by these pure tests.
