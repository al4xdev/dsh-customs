import { resolveHost } from '../common.mjs';
import { assertPersistenceCompatible, assertAuditReadable } from './persistence.mjs';
import { sanitizeFailure, own, positiveInteger, routeFacts, usageFacts } from './sanitizer.mjs';
import { AUDIT_EVENT, PROJECTION_KEY, INITIAL_STATE, POLICY_VERSION, MAX_STEP_CALLS, MAX_HUMAN_GRANTS, validateConfig, decide, transition, chainKey, foldState, observationText, healthyStepProof, recoveredState, manualResumeState } from './logic.mjs';
const { createUserMessage } = await import(resolveHost('@deepseek-ai/dsh-llm'));
const { z } = await import(resolveHost('zod'));
export const name = 'alex-agent-self-heal';
export const inject = ['agents', 'sessionProjections'];
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const chainSchema = z.object({ turn: integer, step: integer, cycle: z.number().int().min(0).max(10), maxCycles: z.number().int().min(0).max(10),
  status: z.enum(['reserved', 'admitted', 'retry-requested', 'suspended', 'aborted', 'append-failed', 'recovered']), attemptSeq: integer,
  messageId: z.string().min(1).max(128).optional(), observationSeq: integer.optional() }).strict();
const progressSchema = z.object({ kind: z.literal('healthy-step'), turn: integer, step: integer,
  startSeq: integer, assistantSeq: integer, stepEndSeq: integer }).strict();
const manualProgressShape = { kind: z.literal('human-resume'), authority: z.literal('live-root-inbox'),
  turn: integer, step: integer, inboxSeq: integer, claimSeq: integer, stepStartSeq: integer };
const candidateSchema = z.object({ turn: integer, step: integer, startSeq: integer, lastSeq: integer, valid: z.boolean(),
  assistantSeq: integer.optional(), finishKind: z.enum(['stop', 'tool-calls']).optional(), stepEndSeq: integer.optional(),
  toolCount: z.number().int().min(0).max(MAX_STEP_CALLS), callSeqs: z.array(integer).max(MAX_STEP_CALLS),
  resultCallSeqs: z.array(integer).max(MAX_STEP_CALLS) }).strict();
export const stateSchema = z.object({ lastHealthyTurn: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  policyVersion: z.literal(POLICY_VERSION).optional(), pendingStep: candidateSchema.optional(), lastHealthyStep: progressSchema.optional(),
  inboxEvidence: z.object({ insertSeqs: z.array(integer).max(MAX_HUMAN_GRANTS), claimSeq: integer.optional() }).strict().optional(),
  lastManualResume: z.object({ ...manualProgressShape, previousChain: chainSchema.optional() }).strict().optional(),
  lastCompletedTurn: z.object({ turn: integer, seq: integer }).strict().optional(),
  seen: z.object({ attemptSeq: integer, emptyCount: z.number().int().min(0).max(2) }).strict().optional(),
  chain: chainSchema.optional(), lastRecovered: chainSchema.optional() }).strict();
const STOPPED = Symbol('self-heal-stopped');
/** Disposal/caller cancellation interrupt this middleware's wait, not upstream I/O. */
function downstream(next, signal) {
  if (signal.aborted) return Promise.resolve(STOPPED);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); resolve(STOPPED); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(next).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
export function apply(ctx, config = {}) {
  const { maxCycles } = validateConfig(config);
  assertPersistenceCompatible();
  // Keep checkpoint version 1: the new fields are optional and old spent budgets
  // remain readable without replay, config-driven reset or missing-log inference.
  ctx.sessionProjections.register({ key: PROJECTION_KEY, stateVersion: 1, stateSchema,
    init: () => ({ ...INITIAL_STATE, policyVersion: POLICY_VERSION }),
    apply: (state, event) => { assertAuditReadable(event, stateSchema); return foldState(state, event); } });
  const lifetime = new AbortController(), attempts = new WeakMap(), busy = new WeakSet(), active = new Set();
  const turnSignals = new WeakMap(), pendingRecovered = new WeakMap();
  const lastSplices = new WeakMap(), humanGrants = new WeakMap(), claimedHuman = new WeakMap();
  const track = operation => {
    active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  };
  const warnAudit = () => { try { ctx.logger?.warn?.('agent-self-heal: audit append failed; no atomic persistence guarantee.'); } catch {} };
  const readState = agent => ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);
  const audit = (agent, action, state, position, causalSeq, facts, progress) => agent.session.append(AUDIT_EVENT, {
    version: 1, action, turn: position.turn, step: position.step, state,
    ...(causalSeq === undefined ? {} : { causalSeq }), ...(facts === undefined ? {} : { facts }),
    ...(progress === undefined ? {} : { progress }),
  });
  const stops = [];
  const userRpc = message => own(message, 'role') === 'user' && own(own(message, 'source'), 'kind') === 'user'
    && typeof own(own(message, 'source'), 'rpcId') === 'string' && own(own(message, 'source'), 'rpcId').length > 0
    && own(own(message, 'source'), 'rpcId').length <= 256;
  stops.push(ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    // mutate() emits synchronously after its durable splice, retaining the
    // original caller ALS. Ordinary model/peer tools cannot mint a root grant.
    if (lifetime.signal.aborted || maxCycles === 0 || ctx.agents.currentInitiator() !== undefined
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
    if (grant && !lifetime.signal.aborted && maxCycles !== 0 && !signal.aborted
      && grant.turn === turn && ctx.agents.get(agent.id) === agent) {
      const state = readState(agent);
      const progress = { kind: 'human-resume', authority: 'live-root-inbox', turn, step,
        inboxSeq: grant.inboxSeq, claimSeq: grant.claimSeq, stepStartSeq: state.pendingStep?.startSeq };
      const resumed = manualResumeState(state, progress);
      if (resumed && (state.chain || state.seen?.emptyCount)) {
        try { audit(agent, 'manual-resumed', resumed, progress, progress.claimSeq, undefined, progress); }
        catch { warnAudit(); }
      }
    }
    return next();
  }));
  stops.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (lifetime.signal.aborted || maxCycles === 0) return;
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
    if (lifetime.signal.aborted || maxCycles === 0) return;
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
    if (!progress || progress.stepEndSeq !== event.seq || (!state.chain && !state.seen?.emptyCount)) return;
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
    if (maxCycles === 0) return next();
    const signal = AbortSignal.any([lifetime.signal, payload.signal]);
    const action = await downstream(next, signal);
    if (action === STOPPED || signal.aborted) return;
    const { agent, turn, step, provider } = payload;
    if (ctx.agents.get(agent.id) !== agent || busy.has(agent)) return action;
    const attempt = attempts.get(agent);
    // Only the public loop's committed failed attempt admits an observation.
    if (!attempt || attempt.turn !== turn || attempt.step !== step || !positiveInteger(attempt.seq)) return action;
    const selected = sanitizeFailure(payload.failure, provider);
    if (!selected) return action;
    if (action !== undefined && selected.code !== 'EMPTY_RESPONSE') return action;
    const position = { turn, step };
    const facts = Object.freeze({ ...selected, ...routeFacts(provider, agent.options.model),
      ...(positiveInteger(agent.options.maxTokens) && agent.options.maxTokens <= 1_000_000 ? { outputCap: agent.options.maxTokens } : {}) });
    busy.add(agent);
    let state;
    const markStopped = status => {
      if (!state?.chain) return;
      state = transition(state, status);
      try { audit(agent, status, state, position, attempt.seq, facts); } catch { warnAudit(); }
    };
    try {
      const decision = decide(readState(agent), position, attempt.seq, facts, maxCycles, action !== undefined);
      if (decision.kind === 'ignore' || decision.kind === 'duplicate') return action;
      state = decision.state;
      if (decision.kind === 'observed') { audit(agent, 'observed', state, position, attempt.seq, facts); return action; }
      if (decision.kind === 'suspended') { audit(agent, 'suspended', state, position, attempt.seq, facts); return; }
      // Reservation first. Reloads or partial append failures never grant a new
      // cycle for the same failed attempt. These appends are deliberately non-atomic.
      audit(agent, 'reserved', state, position, attempt.seq, facts);
      if (signal.aborted) { markStopped('aborted'); return; }
      const summary = `Model request recovery: cycle ${state.chain.cycle} of ${state.chain.maxCycles}.`;
      const message = createUserMessage({ source: { kind: 'self-heal-observation', label: 'Self-heal', form: 'notice', summary,
        chain: chainKey(state.chain), cycle: state.chain.cycle, attemptSeq: attempt.seq },
        content: [{ type: 'text', text: observationText(facts, position, state.chain, attempt.usage) }] });
      const admitted = agent.session.append('user/message', message, { surfaceOp: 'append', sourceEventSeqs: [attempt.seq] });
      state = transition(state, 'admitted', { messageId: message.id, observationSeq: admitted.seq });
      if (signal.aborted) { markStopped('aborted'); return; }
      audit(agent, 'observation-admitted', state, position, attempt.seq, facts);
      if (signal.aborted) { markStopped('aborted'); return; }
      state = transition(state, 'retry-requested');
      audit(agent, 'retry-requested', state, position, attempt.seq, facts);
      if (signal.aborted) { markStopped('aborted'); return; }
      return { kind: 'retry' };
    } catch {
      // Never include append/callback exception text, never refund the cycle, and
      // never authorize replay after uncertain settlement/admission.
      markStopped('append-failed');
      return action;
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
