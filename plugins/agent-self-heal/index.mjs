import { resolveHost } from '../common.mjs';
import { assertPersistenceCompatible, assertAuditReadable } from './persistence.mjs';
import { sanitizeFailure, harnessWarningText, own, positiveInteger, routeFacts, usageFacts } from './sanitizer.mjs';
import { randomUUID } from 'node:crypto';
import { ACCOUNTING_KEY, recoveryBudget } from '../llm-resilience/recovery-accounting.mjs';
import { AUDIT_EVENT, PROJECTION_KEY, INITIAL_STATE, POLICY_VERSION, MAX_CONFIG_CYCLES, MAX_STEP_CALLS, MAX_HUMAN_GRANTS, validateConfig, decide, transition, chainKey, foldState, healthyStepProof, recoveredState, manualResumeState } from './logic.mjs';
const { createUserMessage } = await import(resolveHost('@deepseek-ai/dsh-llm'));
import { stateSchema } from './state-schema.mjs';
export { stateSchema };
export const name = 'alex-agent-self-heal';
export const inject = ['agents', 'sessionProjections', 'llmRecoveryHistory'];
export function apply(ctx, config = {}) {
  const { maxCycles } = validateConfig(config);
  const resilience = () => ctx.get?.('llmRecoveryHistory');
  if (resilience()?.recoveryVersion !== 2 || resilience()?.recoveryHistoryVersion !== 2) throw new Error('agent-self-heal: historical recovery controller v2 required');
  const localCap = Object.hasOwn(config, 'maxCycles') ? maxCycles : MAX_CONFIG_CYCLES;
  const cycleCap = () => {
    const shared = resilience()?.config;
    // The shared admission envelope covers explicit provider overrides; the
    // budget/plan enforce the actual route's cap. The base is not a ceiling.
    // Older v2 services remain conservative until their replacement arrives.
    const cap = shared?.selfHeal?.maxCycles ?? shared?.policy?.maxRetries ?? 0;
    return Math.min(localCap, cap);
  };
  assertPersistenceCompatible();
  // Keep checkpoint version 1: the new fields are optional and old spent budgets
  // remain readable without replay, config-driven reset or missing-log inference.
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
  const audit = (agent, action, state, position, causalSeq, facts, progress, recoveryWait, recoveryOwnership) => agent.session.append(AUDIT_EVENT, {
    version: 1, action, turn: position.turn, step: position.step, state,
    ...(causalSeq === undefined ? {} : { causalSeq }), ...(facts === undefined ? {} : { facts }),
    ...(progress === undefined ? {} : { progress }),
    ...(recoveryWait === undefined ? {} : { recoveryWait }),
    ...(recoveryOwnership === undefined ? {} : { recoveryOwnership }),
  });
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
    if (!splice || splice.target !== 'next-turn' || !splice.ids.includes(id)) return;
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
        try { audit(agent, 'manual-resumed', resumed, progress, progress.claimSeq, undefined, progress); }
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
      try { audit(agent, 'recovered', recovered, proof, proof.stepEndSeq, undefined, proof); } catch { warnAudit(); }
    }).catch(warnAudit));
  }));
  async function recover(payload, next) {
    if (lifetime.signal.aborted || payload.signal.aborted) return;
    const signal = AbortSignal.any([lifetime.signal, payload.signal]);
    const { agent, turn, step, provider } = payload;
    const selected = sanitizeFailure(payload.failure, provider);
    if (!selected) return next();
    // This owner never delegates a selected failure to an old technical retry.
    if (ctx.agents.get(agent.id) !== agent || busy.has(agent)) return;
    const scheduler = resilience();
    // An explicit route opt-out is not permission for semantic fallback to
    // bypass the operator's decision by issuing a different kind of replay.
    if (scheduler?.recoveryVersion !== 2 || scheduler.recoveryHistoryVersion !== 2 || scheduler.signal.aborted) return;
    const attempt = attempts.get(agent);
    // Only the public loop's committed failed attempt admits an observation.
    if (!attempt || attempt.turn !== turn || attempt.step !== step || !positiveInteger(attempt.seq)) return;
    const position = { turn, step };
    const facts = Object.freeze({ ...selected, ...route(provider, agent.options.model),
      ...(scheduler ? transientFacts(agent, provider) : {}),
      ...(positiveInteger(agent.options.maxTokens) && agent.options.maxTokens <= 1_000_000 ? { outputCap: agent.options.maxTokens } : {}) });
    busy.add(agent);
    let state;
    const markStopped = status => {
      if (!state?.chain) return;
      state = transition(state, status);
      try { audit(agent, status, state, position, attempt.seq, facts); } catch { warnAudit(); }
    };
    try {
      const current = readState(agent);
      if (attempt.seq <= (current.seen?.attemptSeq ?? 0)) return;
      const policy = scheduler.policyFor(provider, payload.retryPolicy);
      const budget = recoveryBudget(current,
        ctx.sessionProjections.stateOf(agent.session, ACCOUNTING_KEY),
        ctx.sessionProjections.stateOf(agent.session, 'llmRetry'), policy, provider, cycleCap());
      // Import disjoint legacy native/semantic spending once. Subsequent unified
      // reservations already include this floor and must never add it again.
      let seeded = current;
      if (budget.consumed > (current.chain?.cycle ?? 0) || current.chain) seeded = { ...current, chain: {
        ...(current.chain ?? { turn, step, status: 'reserved', attemptSeq: attempt.seq }),
        cycle: Math.max(current.chain?.cycle ?? 0, Math.min(budget.consumed, budget.cap)), maxCycles: budget.cap,
      } };
      const waitPlan = selected.invalidFailureFacts ? undefined : scheduler.plan({ provider, failure: selected,
        previousRetry: budget.consumed, registeredPolicy: payload.retryPolicy, policy: budget.policy });
      const appendWarning = (terminal, retry = budget.consumed) => {
        const summary = `harness warning: ${terminal ? 'recovery stopped' : `retry ${retry} of ${budget.cap}`}.`;
        const message = createUserMessage({ source: { kind: 'self-heal-observation', label: 'Harness warning', form: 'notice', summary,
          ...(state?.chain ? { chain: chainKey(state.chain), cycle: state.chain.cycle } : {}), attemptSeq: attempt.seq },
          content: [{ type: 'text', text: harnessWarningText(facts, { retry, maxRetries: budget.cap, delayMs: waitPlan?.delayMs, terminal }) }] });
        const admitted = agent.session.append('user/message', message, { surfaceOp: 'append', sourceEventSeqs: [attempt.seq] });
        return { message, admitted };
      };
      if (!waitPlan) {
        // A terminal-only legacy takeover has no unified reservation. Its
        // native floor already lives in history2; copying it into a semantic
        // chain here would count the same native spending twice on continuation.
        state = { ...current, seen: { attemptSeq: attempt.seq, emptyCount: selected.code === 'EMPTY_RESPONSE' ? 1 : 0 } };
        if (state.chain) state = transition(state, 'suspended', { maxCycles: Math.min(state.chain.maxCycles, budget.cap) });
        audit(agent, state.chain ? 'suspended' : 'observed', state, position, attempt.seq, facts);
        if (!signal.aborted) appendWarning(true);
        return; // Native loop throws the original LlmError; never call another retry owner.
      }
      const decision = decide(seeded, position, attempt.seq, facts, budget.cap, false, true);
      if (decision.kind !== 'heal') return;
      state = decision.state;
      const retryId = budget.retryId ?? randomUUID();
      const ownership = { version: 1, kind: 'unified-agent-warning', origin: { turn: state.chain.turn, step: state.chain.step },
        provider, retryId, policyKey: waitPlan.policyKey, retry: state.chain.cycle,
        legacyNativeConsumed: budget.legacyNativeConsumed, legacySemanticConsumed: budget.legacySemanticConsumed, importedConsumed: budget.importedConsumed };
      const scheduledAtMs = Date.now();
      const recoveryWait = { version: 1, phase: 'contextual-recovery', retry: waitPlan.retry, delayMs: waitPlan.delayMs,
        policyKey: waitPlan.policyKey, scheduledAtMs, notBeforeMs: scheduledAtMs + waitPlan.delayMs };
      // Reserve before warning/UI appends: any partial failure consumes this credit.
      audit(agent, 'reserved', state, position, attempt.seq, facts, undefined, recoveryWait, ownership);
      if (signal.aborted || lifetime.signal.aborted) { markStopped('aborted'); return; }
      const { message, admitted } = appendWarning(false, state.chain.cycle);
      state = transition(state, 'admitted', { messageId: message.id, observationSeq: admitted.seq });
      audit(agent, 'observation-admitted', state, position, attempt.seq, facts);
      if (signal.aborted || scheduler.signal.aborted) { markStopped('aborted'); return; }
      agent.session.append('llm/retry', { retryId, turn, step, provider, mode: 'normal', policyKey: waitPlan.policyKey,
        retry: state.chain.cycle, maxRetries: budget.cap, delayMs: waitPlan.delayMs, failure: payload.failure });
      if (!await scheduler.wait(waitPlan, signal)) { markStopped('aborted'); return; }
      if (signal.aborted || scheduler.signal.aborted || ctx.agents.get(agent.id) !== agent) { markStopped('aborted'); return; }
      state = transition(state, 'retry-requested');
      audit(agent, 'retry-requested', state, position, attempt.seq, facts);
      if (signal.aborted) { markStopped('aborted'); return; }
      agent.session.append('llm/retry-started', { retryId, turn, step, retry: state.chain.cycle });
      return { kind: 'retry' };
    } catch {
      // Never include append/callback exception text, never refund the cycle, and
      // never authorize replay after uncertain settlement/admission.
      markStopped('append-failed');
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
