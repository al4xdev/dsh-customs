import { resolveHost } from '../common.mjs';
import { assertPersistenceCompatible, assertAuditReadable } from './persistence.mjs';
import { sanitizeFailure, harnessWarningText, own, positiveInteger, routeFacts, usageFacts } from './sanitizer.mjs';
import { randomUUID } from 'node:crypto';
import { ACCOUNTING_KEY, recoveryBudget } from '../llm-resilience/recovery-accounting.mjs';
import { isUnbounded } from '../llm-resilience/policy.mjs';
import { AUDIT_EVENT, AUDIT_VERSION, PROJECTION_KEY, INITIAL_STATE, POLICY_VERSION, MAX_CONFIG_CYCLES, MAX_HUMAN_GRANTS, validateConfig, decide, transition, chainKey, foldState, healthyStepProof, recoveredState, manualResumeState, shouldWarn, warned } from './logic.mjs';
const { createUserMessage } = await import(resolveHost('@deepseek-ai/dsh-llm'));
import { stateSchema } from './state-schema.mjs';
export { stateSchema };
export const name = 'alex-agent-self-heal';
// Contract 3 only (unbounded chains, accounting v3, audit payload v2). Contract-2
// controllers publish other names, so this owner waits instead of mis-binding.
export const inject = ['agents', 'sessionProjections', 'llmRecoveryUnbounded'];
const compatible = service => service?.recoveryVersion === 3 && service?.recoveryHistoryVersion === 3 && typeof service.schedule === 'function';
/** UI mirror copy of the native failure: own data fields only, and the native
 * invariant for providerRetryAfterMs (finite and > 0) enforced even if a host
 * ever delivered a malformed one; anything else is dropped from the mirror. */
function mirrorFailure(failure) {
  const copy = {};
  let descriptors = {};
  try { descriptors = Object.getOwnPropertyDescriptors(failure ?? {}); } catch { /* foreign object: empty mirror */ }
  for (const [key, descriptor] of Object.entries(descriptors)) if (descriptor.enumerable && 'value' in descriptor) copy[key] = descriptor.value;
  const hint = copy.providerRetryAfterMs;
  if (hint !== undefined && !(typeof hint === 'number' && Number.isFinite(hint) && hint > 0)) delete copy.providerRetryAfterMs;
  return copy;
}
// Every refusal logs one fixed reason. Logs never carry failure prose, provider
// or model names, ids, messages or exception text.
const WARN_REASONS = new Set(['stale-agent', 'concurrent-recovery', 'controller-unavailable', 'uncommitted-attempt', 'append-failed',
  'invalid-failure-facts', 'provider-wait-over-cap', 'unrepresentable-policy', 'invalid-retry-ordinal', 'unsafe-history']);
const INFO_REASONS = new Set(['ineligible-failure', 'cancelled', 'duplicate-attempt', 'recovery-disabled', 'route-opt-out', 'retries-disabled',
  'retry-budget-exhausted', 'quota-reset-without-hint', 'controller-disposed']);
const HISTORY_REASONS = new Set(['invalid-accounting-state', 'missing-native-ledger', 'unknown-native-scope', 'unknown-native-row',
  'unknown-native-provenance', 'native-row-overflow', 'invalid-ownership-provenance', 'ownership-mismatch', 'unknown-legacy-policy', 'unspecified']);
export function apply(ctx, config = {}) {
  const { maxCycles } = validateConfig(config);
  const resilience = () => ctx.get?.('llmRecoveryUnbounded');
  if (!compatible(resilience())) throw new Error('agent-self-heal: unbounded recovery controller contract 3 required');
  const localCap = Object.hasOwn(config, 'maxCycles') ? maxCycles : MAX_CONFIG_CYCLES;
  const cycleCap = () => {
    const shared = resilience()?.config;
    // The shared admission envelope covers explicit provider overrides; the
    // budget/plan enforce the actual route's cap. The base is not a ceiling.
    // Absent caps are the unbounded sentinel; explicit finite caps narrow it.
    const cap = shared?.selfHeal?.maxCycles ?? shared?.policy?.maxRetries ?? 0;
    return Math.min(localCap, cap);
  };
  assertPersistenceCompatible();
  // Keep checkpoint version 1: policy-3 fields are optional/widened, so policy-2
  // checkpoints and spent budgets stay readable without replay, config-driven
  // reset or missing-log inference. The reverse (v6 reading these) is refused.
  ctx.sessionProjections.register({ key: PROJECTION_KEY, stateVersion: 1, stateSchema,
    init: () => ({ ...INITIAL_STATE, policyVersion: POLICY_VERSION }),
    apply: (state, event) => { assertAuditReadable(event, stateSchema); return foldState(state, event); } });
  const lifetime = new AbortController(), attempts = new WeakMap(), busy = new WeakSet(), active = new Set();
  const routeAliases = new Map();
  const route = (provider, model) => {
    if (typeof provider === 'string' && provider.length <= 512 && !routeAliases.has(provider) && routeAliases.size < 4096) routeAliases.set(provider, `configured-route-${routeAliases.size + 1}`);
    return routeFacts(provider, model, routeAliases.get(provider));
  };
  const turnSignals = new WeakMap(), pendingRecovered = new WeakMap();
  const lastSplices = new WeakMap(), humanGrants = new WeakMap(), claimedHuman = new WeakMap();
  const track = operation => {
    active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  };
  const warnAudit = () => { try { ctx.logger?.warn?.('agent-self-heal: audit append failed; no atomic persistence guarantee.'); } catch {} };
  const refuse = (reason, detail) => {
    const level = WARN_REASONS.has(reason) ? 'warn' : INFO_REASONS.has(reason) ? 'info' : 'warn';
    const known = WARN_REASONS.has(reason) || INFO_REASONS.has(reason) ? reason : 'unclassified';
    const suffix = known === 'unsafe-history' ? `:${HISTORY_REASONS.has(detail) ? detail : 'unclassified'}` : '';
    try { ctx.logger?.[level]?.(`agent-self-heal: recovery refused (${known}${suffix}).`); } catch {}
  };
  const notice = text => { try { ctx.logger?.info?.(`agent-self-heal: ${text}`); } catch {} };
  const readState = agent => ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);
  const historicalSpend = agent => {
    const history = ctx.sessionProjections.stateOf(agent.session, ACCOUNTING_KEY);
    return history.unsafe || history.legacyConsumed > 0;
  };
  const transientFacts = (agent, provider) => {
    // This optional diagnostic reads the native ledger without resetting it.
    // Old standalone fixtures/hosts need not register the shared driver.
    let ledger;
    try { ledger = ctx.sessionProjections.stateOf(agent.session, 'llmRetry'); } catch { return {}; }
    if (!ledger || typeof ledger !== 'object') return {};
    let count = 0;
    for (const [key, entry] of Object.entries(ledger)) {
      let route;
      try { [route] = JSON.parse(key); } catch { continue; }
      const retry = own(entry, 'retry');
      if (route === provider && Number.isSafeInteger(retry) && retry >= 0) count = Math.min(Number.MAX_SAFE_INTEGER, count + retry);
    }
    return { transientRetries: count };
  };
  // Payload version 2 (policy 3). Older owner bundles refuse it on replay rather
  // than misreading an unbounded chain: rollback after new audits is unsafe.
  const audit = (agent, action, state, position, causalSeq, facts, { progress, recoveryWait, recoveryOwnership, recoveryWake } = {}) => agent.session.append(AUDIT_EVENT, {
    version: AUDIT_VERSION, action, turn: position.turn, step: position.step, state,
    ...(causalSeq === undefined ? {} : { causalSeq }), ...(facts === undefined ? {} : { facts }),
    ...(progress === undefined ? {} : { progress }),
    ...(recoveryWait === undefined ? {} : { recoveryWait }),
    ...(recoveryOwnership === undefined ? {} : { recoveryOwnership }),
    ...(recoveryWake === undefined ? {} : { recoveryWake }),
  });
  // agent -> wake(inboxSeq) while one recovery wait is pending for that agent.
  const waiting = new WeakMap();
  const stops = [];
  const userRpc = message => own(message, 'role') === 'user' && own(own(message, 'source'), 'kind') === 'user'
    && typeof own(own(message, 'source'), 'rpcId') === 'string' && own(own(message, 'source'), 'rpcId').length > 0
    && own(own(message, 'source'), 'rpcId').length <= 256;
  stops.push(ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    // mutate() emits synchronously after its durable splice, retaining the
    // original caller ALS. Ordinary model/peer tools cannot mint a root grant.
    if (lifetime.signal.aborted || cycleCap() === 0 || ctx.agents.currentInitiator() !== undefined
      || ctx.agents.get(agent.id) !== agent || !userRpc(message)) return;
    const splice = lastSplices.get(agent), id = own(message, 'id');
    if (!splice || !splice.ids.includes(id)) return;
    // The same live root evidence wakes a pending backoff: the retry starts now
    // (provider minima still hold). The message itself stays queued in the inbox
    // and is claimed at the next native step/turn boundary, as without a wait.
    if (splice.target === 'next-step' || splice.target === 'next-turn') waiting.get(agent)?.(splice.seq);
    if (splice.target !== 'next-turn') return;
    let grants = humanGrants.get(agent);
    if (!grants) humanGrants.set(agent, grants = new Map());
    if (grants.size >= MAX_HUMAN_GRANTS || typeof id !== 'string' || id.length > 128) return;
    grants.set(id, { inboxSeq: splice.seq });
  }));
  stops.push(ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    humanGrants.get(agent)?.delete(own(message, 'id'));
  }));
  stops.push(ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const grants = humanGrants.get(agent), id = own(message, 'id'), grant = grants?.get(id);
    grants?.delete(id);
    const splice = lastSplices.get(agent);
    if (!grant || lifetime.signal.aborted || !userRpc(message) || !positiveInteger(turn)
      || ctx.agents.get(agent.id) !== agent || splice?.target !== 'next-turn' || splice.ids.length !== 0
      || splice.removedCount !== 1 || splice.outcome !== undefined || splice.seq <= grant.inboxSeq) return;
    claimedHuman.set(agent, { ...grant, claimSeq: splice.seq, turn });
  }));
  stops.push(ctx.on('agent/request', ({ agent, turn, step, signal }, next) => {
    // Only capture the public turn cancellation signal; preserve the config waterfall.
    turnSignals.set(agent, { turn, signal });
    const grant = claimedHuman.get(agent);
    claimedHuman.delete(agent);
    if (grant && !lifetime.signal.aborted && cycleCap() !== 0 && !signal.aborted
      && grant.turn === turn && ctx.agents.get(agent.id) === agent) {
      const state = readState(agent);
      const progress = { kind: 'human-resume', authority: 'live-root-inbox', turn, step,
        inboxSeq: grant.inboxSeq, claimSeq: grant.claimSeq, stepStartSeq: state.pendingStep?.startSeq };
      const resumed = manualResumeState(state, progress);
      if (resumed && (state.chain || state.seen?.emptyCount || historicalSpend(agent))) {
        try { audit(agent, 'manual-resumed', resumed, progress, progress.claimSeq, undefined, { progress }); }
        catch { warnAudit(); }
      }
    }
    return next();
  }));
  stops.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (lifetime.signal.aborted || cycleCap() === 0) return;
    const type = own(frame, 'type');
    if (type === 'start') {
      const turn = own(frame, 'turn'), step = own(frame, 'step');
      if (positiveInteger(turn) && positiveInteger(step)) attempts.set(agent, { turn, step, usage: {}, seq: undefined, attemptId: own(frame, 'attemptId') });
    } else {
      const attempt = attempts.get(agent);
      if (!attempt || own(frame, 'attemptId') !== attempt.attemptId) return;
      if (type === 'chunk') {
        const chunk = own(frame, 'chunk');
        if (own(chunk, 'type') === 'usage') attempt.usage = usageFacts(own(chunk, 'usage') ?? chunk);
      } else if (type === 'end') {
        const outcome = own(frame, 'outcome'), seq = own(outcome, 'seq');
        if (own(outcome, 'kind') === 'committed' && own(outcome, 'eventType') === 'assistant/attempt' && positiveInteger(seq)) attempt.seq = seq;
      }
    }
  }));
  stops.push(ctx.on('session/event', (session, event) => {
    if (lifetime.signal.aborted || cycleCap() === 0) return;
    const agent = ctx.agents.get(session.id);
    if (!agent || agent.session !== session) return;
    if (event.type === 'agent/inbox/spliced') {
      const data = event.data;
      lastSplices.set(agent, { seq: event.seq, target: data.target, removedCount: data.removedCount, outcome: data.outcome,
        ids: data.inserted.length <= MAX_HUMAN_GRANTS ? data.inserted.map(message => own(message, 'id')) : [] });
      return;
    }
    if (event.type === 'turn/start' && (claimedHuman.get(agent)?.turn ?? event.data.turn) < event.data.turn) claimedHuman.delete(agent);
    if (event.type !== 'step/end') return;
    // step/end is appended in finally, even after cancel. Projection stages the
    // native witness; the live signal must still admit this deferred commit.
    const state = readState(agent);
    const progress = healthyStepProof(state);
    if (!progress || progress.stepEndSeq !== event.seq || (!state.chain && !state.seen?.emptyCount && !historicalSpend(agent))) return;
    const ticket = { progress, chain: state.chain ? chainKey(state.chain) : undefined,
      attemptSeq: state.chain?.attemptSeq ?? state.seen?.attemptSeq, cycle: state.chain?.cycle };
    if (pendingRecovered.has(agent)) { pendingRecovered.set(agent, ticket); return; }
    pendingRecovered.set(agent, ticket);
    track(Promise.resolve().then(() => {
      const pending = pendingRecovered.get(agent);
      pendingRecovered.delete(agent);
      const currentSignal = turnSignals.get(agent);
      if (!pending || lifetime.signal.aborted || ctx.agents.get(agent.id) !== agent || agent.session !== session
        || !currentSignal || currentSignal.turn !== pending.progress.turn || currentSignal.signal.aborted) return;
      const current = readState(agent), proof = healthyStepProof(current);
      if (!proof || JSON.stringify(proof) !== JSON.stringify(pending.progress)
        || (current.chain ? chainKey(current.chain) : undefined) !== pending.chain
        || (current.chain?.attemptSeq ?? current.seen?.attemptSeq) !== pending.attemptSeq
        || current.chain?.cycle !== pending.cycle) return;
      const recovered = recoveredState(current);
      try { audit(agent, 'recovered', recovered, proof, proof.stepEndSeq, undefined, { progress: proof }); } catch { warnAudit(); }
    }).catch(warnAudit));
  }));
  async function recover(payload, next) {
    if (lifetime.signal.aborted || payload.signal.aborted) { refuse('cancelled'); return; }
    const signal = AbortSignal.any([lifetime.signal, payload.signal]);
    const { agent, turn, step, provider } = payload;
    const selected = sanitizeFailure(payload.failure, provider);
    if (!selected) { refuse('ineligible-failure'); return next(); }
    // This owner never delegates a selected failure to an old technical retry.
    if (ctx.agents.get(agent.id) !== agent) { refuse('stale-agent'); return; }
    if (busy.has(agent)) { refuse('concurrent-recovery'); return; }
    const scheduler = resilience();
    // An explicit route opt-out is not permission for semantic fallback to
    // bypass the operator's decision by issuing a different kind of replay.
    if (!compatible(scheduler) || scheduler.signal.aborted) { refuse('controller-unavailable'); return; }
    if (cycleCap() === 0) { refuse('recovery-disabled'); return; }
    const attempt = attempts.get(agent);
    // Only the public loop's committed failed attempt admits an observation.
    if (!attempt || attempt.turn !== turn || attempt.step !== step || !positiveInteger(attempt.seq)) { refuse('uncommitted-attempt'); return; }
    if (selected.ignoredProviderHint) notice('malformed provider minimum ignored; the local schedule applies.');
    const position = { turn, step };
    const facts = Object.freeze({ ...selected, ...route(provider, agent.options.model),
      ...(scheduler ? transientFacts(agent, provider) : {}),
      ...(positiveInteger(agent.options.maxTokens) && agent.options.maxTokens <= 1_000_000 ? { outputCap: agent.options.maxTokens } : {}) });
    busy.add(agent);
    let state;
    const markStopped = (status, reason) => {
      refuse(reason);
      if (!state?.chain) return;
      state = transition(state, status);
      try { audit(agent, status, state, position, attempt.seq, facts); } catch { warnAudit(); }
    };
    try {
      const current = readState(agent);
      if (attempt.seq <= (current.seen?.attemptSeq ?? 0)) { refuse('duplicate-attempt'); return; }
      const policy = scheduler.policyFor(provider, payload.retryPolicy);
      const nativeLedger = ctx.sessionProjections.stateOf(agent.session, 'llmRetry');
      let budget;
      try {
        budget = recoveryBudget(current,
          ctx.sessionProjections.stateOf(agent.session, ACCOUNTING_KEY), nativeLedger, policy, provider, cycleCap());
      } catch (error) { refuse('unsafe-history', error?.reason); return; }
      // Import disjoint legacy native/semantic spending once. Subsequent unified
      // reservations already include this floor and must never add it again.
      let seeded = current;
      if (budget.consumed > (current.chain?.cycle ?? 0) || current.chain) seeded = { ...current, chain: {
        ...(current.chain ?? { turn, step, status: 'reserved', attemptSeq: attempt.seq }),
        cycle: Math.max(current.chain?.cycle ?? 0, Math.min(budget.consumed, budget.cap)), maxCycles: budget.cap,
      } };
      const scheduled = selected.invalidFailureFacts ? { kind: 'refused', reason: 'invalid-failure-facts' }
        : scheduler.schedule({ provider, failure: selected, previousRetry: budget.consumed, registeredPolicy: payload.retryPolicy, policy: budget.policy });
      const waitPlan = scheduled.kind === 'wait' ? scheduled : undefined;
      // Short, counter-free notice; it is appended only when shouldWarn allows.
      const appendWarning = terminal => {
        const summary = terminal ? 'harness warning: recovery stopped.' : 'harness warning: model request failed; retrying.';
        const message = createUserMessage({ source: { kind: 'self-heal-observation', label: 'Harness warning', form: 'notice', summary,
          ...(state?.chain ? { chain: chainKey(state.chain) } : {}), attemptSeq: attempt.seq },
          content: [{ type: 'text', text: harnessWarningText(facts, { terminal }) }] });
        const admitted = agent.session.append('user/message', message, { surfaceOp: 'append', sourceEventSeqs: [attempt.seq] });
        return { message, admitted };
      };
      if (!waitPlan) {
        refuse(scheduled.reason);
        // A terminal-only legacy takeover has no unified reservation. Its
        // native floor already lives in history2; copying it into a semantic
        // chain here would count the same native spending twice on continuation.
        const announce = shouldWarn(current.chain, selected.code, true);
        state = { ...current, seen: { attemptSeq: attempt.seq, emptyCount: selected.code === 'EMPTY_RESPONSE' ? 1 : 0 } };
        if (state.chain) state = transition(state, 'suspended', { maxCycles: Math.min(state.chain.maxCycles, budget.cap) });
        audit(agent, state.chain ? 'suspended' : 'observed', state, position, attempt.seq, facts);
        // Native loop throws the original LlmError; never call another retry owner.
        if (!announce) return;
        if (signal.aborted) {
          // The stop was never announced: leave the chain 'aborted', not
          // 'suspended', so the next terminal failure still gets its notice.
          if (state.chain) { state = transition(state, 'aborted'); audit(agent, 'aborted', state, position, attempt.seq, facts); }
          refuse('cancelled'); return;
        }
        const { message, admitted } = appendWarning(true);
        if (state.chain) {
          state = { ...state, chain: warned(state.chain, selected.code, message.id, admitted.seq) };
          audit(agent, 'observation-admitted', state, position, attempt.seq, facts);
        }
        return;
      }
      const decision = decide(seeded, position, attempt.seq, facts, budget.cap, false, true);
      if (decision.kind !== 'heal') { refuse(decision.kind === 'suspended' ? 'retry-budget-exhausted' : decision.kind === 'duplicate' ? 'duplicate-attempt' : 'recovery-disabled'); return; }
      state = decision.state;
      // One notice per chain: the first failure, then only a changed code. A
      // chain resuming after a visible stop re-announces, or the model would
      // retry with only the stale "recovery stopped" notice in its history.
      const announce = shouldWarn(state.chain, selected.code) || current.chain?.status === 'suspended';
      // Native v4 session rule for the UI mirror: within one turn/step and policy
      // key the ordinal counts 1.. under one retryId, and a new turn/step needs a
      // never-used retryId. A chain that continues after a failed tool step or a
      // cancelled turn must therefore not reuse its chain-wide id/ordinal, or the
      // stored log no longer reopens. The step-scoped native ledger has the prior.
      const prior = own(nativeLedger, JSON.stringify([provider, waitPlan.policyKey]));
      const mirror = Number.isSafeInteger(own(prior, 'retry')) && own(prior, 'retry') >= 0 && typeof own(prior, 'retryId') === 'string'
        ? { retryId: own(prior, 'retryId'), retry: own(prior, 'retry') + 1 } : { retryId: randomUUID(), retry: 1 };
      const ownership = { version: 2, kind: 'unified-agent-warning', origin: { turn: state.chain.turn, step: state.chain.step },
        provider, retryId: mirror.retryId, policyKey: waitPlan.policyKey, retry: state.chain.cycle, mirrorRetry: mirror.retry,
        legacyNativeConsumed: budget.legacyNativeConsumed, legacySemanticConsumed: budget.legacySemanticConsumed, importedConsumed: budget.importedConsumed };
      const scheduledAtMs = Date.now();
      const recoveryWait = { version: 1, phase: 'contextual-recovery', retry: waitPlan.retry, delayMs: waitPlan.delayMs,
        policyKey: waitPlan.policyKey, scheduledAtMs, notBeforeMs: scheduledAtMs + waitPlan.delayMs,
        ...(waitPlan.minimumDelayMs === undefined ? {} : { providerMinimumMs: waitPlan.minimumDelayMs }) };
      // Reserve before warning/UI appends: any partial failure consumes this credit.
      audit(agent, 'reserved', state, position, attempt.seq, facts, { recoveryWait, recoveryOwnership: ownership });
      if (signal.aborted || lifetime.signal.aborted) { markStopped('aborted', 'cancelled'); return; }
      if (announce) {
        const { message, admitted } = appendWarning(false);
        state = { ...state, chain: warned({ ...state.chain, status: 'admitted' }, selected.code, message.id, admitted.seq) };
        audit(agent, 'observation-admitted', state, position, attempt.seq, facts);
        if (signal.aborted || scheduler.signal.aborted) { markStopped('aborted', 'cancelled'); return; }
      }
      // The UI mirror is the only per-cycle trace once the chain has warned.
      // An unbounded budget is shown with the native "no maximum" vocabulary.
      agent.session.append('llm/retry', { retryId: mirror.retryId, turn, step, provider,
        ...(isUnbounded(budget.cap) ? { mode: 'always' } : { mode: 'normal' }), policyKey: waitPlan.policyKey,
        retry: mirror.retry, ...(isUnbounded(budget.cap) ? {} : { maxRetries: budget.cap }), delayMs: waitPlan.delayMs, failure: mirrorFailure(payload.failure) });
      const wake = new AbortController();
      let wakeSeq, wokenSeq;
      waiting.set(agent, inboxSeq => { if (!wake.signal.aborted) { wakeSeq = inboxSeq; wake.abort(); } });
      let elapsed;
      // Attribute a wake only if it actually shortened the pending wait.
      // The durable not-before instant is the wall-clock deadline: it survives a
      // system suspend that stops the monotonic timers.
      try { elapsed = await scheduler.wait(waitPlan, signal, { wake: wake.signal, onWoken: () => { wokenSeq = wakeSeq; }, notBeforeMs: recoveryWait.notBeforeMs }); }
      finally { waiting.delete(agent); }
      if (!elapsed) { markStopped('aborted', 'cancelled'); return; }
      if (signal.aborted || scheduler.signal.aborted || ctx.agents.get(agent.id) !== agent) { markStopped('aborted', 'cancelled'); return; }
      state = transition(state, 'retry-requested');
      audit(agent, 'retry-requested', state, position, attempt.seq, facts,
        positiveInteger(wokenSeq) ? { recoveryWake: { version: 1, kind: 'live-human-inbox', inboxSeq: wokenSeq } } : {});
      if (signal.aborted) { markStopped('aborted', 'cancelled'); return; }
      agent.session.append('llm/retry-started', { retryId: mirror.retryId, turn, step, retry: mirror.retry });
      return { kind: 'retry' };
    } catch {
      // Never include append/callback exception text, never refund the cycle, and
      // never authorize replay after uncertain settlement/admission.
      markStopped('append-failed', 'append-failed');
      return;
    } finally { busy.delete(agent); }
  }
  stops.push(ctx.on('agent/request-error', (payload, next) => {
    const operation = recover(payload, next);
    return track(operation);
  }, { prepend: true }));
  ctx.effect(() => async () => {
    lifetime.abort();
    for (const stop of stops) stop();
    await Promise.allSettled([...active]);
  }, 'agent-self-heal: stop observation admission and drain middleware');
}
