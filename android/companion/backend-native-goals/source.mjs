import { randomUUID } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const token = s => typeof s === 'string' && ID.test(s);
const fail = code => { const error = new Error('Native goal operation refused.'); error.code = `nativeGoals/${code}`; throw error; };
function fields(value, required) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== required.length || required.some(key => !Object.hasOwn(value, key)) ||
      Reflect.ownKeys(value).some(key => !required.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('invalid-request');
}
export function parseNativeGoalRequest(method, raw) {
  if (method === 'read') {
    fields(raw, ['sessionId', 'generation']);
    if (!token(raw.sessionId) || !integer(raw.generation)) fail('invalid-request');
  } else if (method === 'catalog') {
    fields(raw, ['sessionIds']);
    if (!Array.isArray(raw.sessionIds) || raw.sessionIds.length > 100 || raw.sessionIds.some(id => !token(id)) || new Set(raw.sessionIds).size !== raw.sessionIds.length) fail('invalid-request');
  } else if (method === 'control') {
    fields(raw, ['sessionId', 'goalId', 'revision', 'sourceId', 'incarnation', 'generation', 'permit', 'action']);
    if (![raw.sessionId, raw.goalId, raw.sourceId, raw.incarnation, raw.permit].every(token) || !positive(raw.revision) || !integer(raw.generation) || !['pause', 'resume'].includes(raw.action)) fail('invalid-request');
  } else fail('invalid-request');
  return raw;
}
function safeValue(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 65536) fail('observation-limit');
  return JSON.parse(text);
}

/** UNUSED until the Parent stop gate. No persistence, loader, model tools, extra listener, or shadow goal/TODO. */
export function createNativeGoals(ctx, { scopeOf, scopeChainOf, identityOf = value => value, now = Date.now, mint = randomUUID } = {}) {
  const root = ctx.root, ownerFiber = ctx.fiber, rootFiber = root?.fiber;
  const ownerUid = ownerFiber?.uid, rootUid = rootFiber?.uid;
  const profile = ctx.get('profileContext');
  const scope = scopeOf(ctx);
  const connection = ctx.get('connection');
  if (profile?.name !== 'companion' || !scope || !connection?.operator || typeof scopeChainOf !== 'function') fail('scope-unavailable');
  const operator = connection.operator, operatorContext = operator.ctx, operatorFiber = operatorContext?.fiber;
  const operatorUid = operatorFiber?.uid;
  // Public Cordis incarnation evidence only; UID0 is live and an unknown initial UID is never recaptured.
  const active = (fiber, uid) => integer(uid) && fiber?.uid === uid;
  const sourceId = mint();
  const incarnations = new WeakMap();
  const permits = new Map();
  let closed = false;
  const MAX_PERMITS = 256;
  const TTL = 30000;
  const services = () => {
    if (ctx.get('profileContext') !== profile || root.get('profileContext') !== profile || operatorContext.get('profileContext') !== profile ||
        identityOf(ctx.get('connection')) !== identityOf(connection) || identityOf(root.get('connection')) !== identityOf(connection) || profile.name !== 'companion') fail('source-changed');
    const agents = ctx.get('agents'), goals = ctx.get('goals'), projections = ctx.get('sessionProjections'), presets = ctx.get('agentPresets');
    if (!agents || !goals || !projections || !presets) fail('unavailable');
    const roots = agents.roots();
    if (!Array.isArray(roots) || roots.length > 4096) fail('observation-limit');
    return { agents, goals, projections, presets, roots: new Set(roots) };
  };
  const human = peer => {
    // This Peer is supplied by Connection after Host/Origin + signed-cookie admission, never by JSON.
    if (closed || peer !== operator || connection.operator !== operator || operator.ctx !== operatorContext ||
        !root || ctx.root !== root || root.fiber !== rootFiber || ctx.fiber !== ownerFiber || operatorContext?.root !== root ||
        operatorContext?.fiber !== operatorFiber || !active(rootFiber, rootUid) || !active(ownerFiber, ownerUid) || !active(operatorFiber, operatorUid)) fail('operator-required');
  };
  function live(id, api) {
    const agent = api.agents.get(id);
    if (!agent || !api.roots.has(agent) || agent.id !== id || agent.session?.id !== id ||
        agent.session.header?.id !== id || agent.session.header.agentPreset !== 'companion' || agent.session.header.origin !== undefined ||
        agent.session.header.isSeeded !== false || api.presets.composedPreset(agent.ctx) !== 'companion' ||
        !scopeChainOf(scopeOf(agent.ctx)).includes(scope)) fail('not-live-owned');
    return agent;
  }
  function incarnation(agent) {
    let value = incarnations.get(agent);
    if (!value) { value = mint(); incarnations.set(agent, value); }
    return value;
  }
  function current(agent, api) {
    const snapshot = api.projections.snapshot(agent.session, ['goal', 'todos']);
    if (!snapshot || !Object.hasOwn(snapshot.values, 'goal') || !Object.hasOwn(snapshot.values, 'todos')) fail('projections-unavailable');
    const projections = safeValue({ goal: snapshot.values.goal, todos: snapshot.values.todos });
    const goal = api.goals.get(agent);
    const projected = projections.goal;
    if ((goal === undefined) !== (projected === null) || goal && (goal.id !== projected.goal.id || goal.revision !== projected.goal.revision ||
        goal.phase !== projected.goal.phase || goal.roundsStarted !== projected.roundsStarted || goal.maxGoalRounds !== projected.goal.maxGoalRounds)) fail('source-changed');
    if (goal && !['armed', 'disarmed'].includes(goal.activation)) fail('invalid-observation');
    // Validate portable budgets before returning ANY objective/list bytes to the carrier.
    if (goal && (!positive(goal.revision) || !positive(goal.maxGoalRounds) || !integer(goal.roundsStarted) || goal.roundsStarted > goal.maxGoalRounds ||
        typeof goal.objective !== 'string' || goal.objective.length > 32768)) fail('observation-limit');
    if (projections.todos !== null && (!Array.isArray(projections.todos) || projections.todos.length > 256 || projections.todos.some(todo =>
      typeof todo.content !== 'string' || todo.content.length > 4096 || !['pending', 'in_progress', 'completed'].includes(todo.status)))) fail('observation-limit');
    if (!Number.isSafeInteger(snapshot.asOfSeq) || snapshot.asOfSeq < -1) fail('invalid-observation');
    return { projections, goal, asOfSeq: snapshot.asOfSeq };
  }
  function prune() {
    for (const [key, row] of permits) if (row.expires <= now()) permits.delete(key);
    while (permits.size >= MAX_PERMITS) permits.delete(permits.keys().next().value);
  }
  function observation(agent, api, generation, peer) {
    const { projections, goal, asOfSeq } = current(agent, api);
    const liveIncarnation = incarnation(agent);
    let permit = null;
    if (goal && goal.phase !== 'complete') {
      prune(); permit = mint();
      permits.set(permit, { peer, agent, generation, services: api, incarnation: liveIncarnation, id: goal.id, revision: goal.revision,
        phase: goal.phase, activation: goal.activation, rounds: goal.roundsStarted, cap: goal.maxGoalRounds, expires: now() + TTL });
    }
    return { version: 1, sessionId: agent.id, generation, sourceId, incarnation: liveIncarnation,
      projections, asOfSeq, activation: goal?.activation ?? 'unknown', permit };
  }
  function read(raw, peer, signal) {
    human(peer); signal?.throwIfAborted(); fields(raw, ['sessionId', 'generation']);
    if (!token(raw.sessionId) || !integer(raw.generation)) fail('invalid-request');
    const api = services(); return observation(live(raw.sessionId, api), api, raw.generation, peer);
  }
  function catalog(raw, peer, signal) {
    human(peer); signal?.throwIfAborted(); fields(raw, ['sessionIds']);
    if (!Array.isArray(raw.sessionIds) || raw.sessionIds.length > 100 || raw.sessionIds.some(id => !token(id)) || new Set(raw.sessionIds).size !== raw.sessionIds.length) fail('invalid-request');
    const api = services();
    return { version: 1, activities: raw.sessionIds.map(sessionId => {
      signal?.throwIfAborted();
      // Only exact live roots are inspected. Cold/foreign/unsupported all look UNKNOWN; no disk/history is opened.
      let goalRunning = null, responding = null;
      try {
        const agent = live(sessionId, api);
        const goal = api.goals.get(agent);
        if (!['idle', 'running'].includes(agent.status)) fail('invalid-observation');
        if (goal && !['armed', 'disarmed'].includes(goal.activation)) fail('invalid-observation');
        goalRunning = !!goal && goal.phase === 'active' && goal.activation === 'armed'; responding = agent.status === 'running';
      } catch { /* Do not infer idle from absent live evidence. */ }
      return { sessionId, goalRunning, responding };
    }) };
  }
  function control(raw, peer, signal) {
    human(peer); signal?.throwIfAborted();
    fields(raw, ['sessionId', 'goalId', 'revision', 'sourceId', 'incarnation', 'generation', 'permit', 'action']);
    if (![raw.sessionId, raw.goalId, raw.sourceId, raw.incarnation, raw.permit].every(token) || !positive(raw.revision) || !integer(raw.generation) || !['pause', 'resume'].includes(raw.action)) fail('invalid-request');
    const captured = permits.get(raw.permit);
    if (!captured || captured.peer !== peer) fail('stale-control');
    permits.delete(raw.permit); // Consume BEFORE every subsequent check and before the native side effect.
    const api = services();
    const agent = live(raw.sessionId, api);
    const goal = api.goals.get(agent);
    if (['agents', 'goals', 'projections', 'presets'].some(key => identityOf(api[key]) !== identityOf(captured.services[key])) || captured.expires <= now() || raw.sourceId !== sourceId || captured.agent !== agent || raw.incarnation !== captured.incarnation ||
        incarnation(agent) !== captured.incarnation || raw.generation !== captured.generation || raw.goalId !== captured.id || raw.revision !== captured.revision ||
        !goal || goal.id !== captured.id || goal.revision !== captured.revision || goal.phase !== captured.phase || goal.activation !== captured.activation ||
        goal.roundsStarted !== captured.rounds || goal.maxGoalRounds !== captured.cap) fail('stale-control');
    if (raw.action === 'pause' ? goal.phase !== 'active' : goal.phase === 'complete' || goal.phase === 'active' && goal.activation !== 'disarmed' || goal.roundsStarted >= goal.maxGoalRounds) fail('invalid-transition');
    // No await, model message, recapture or command parser between final CAS check and PUBLIC native mutation.
    const ref = { id: goal.id, revision: goal.revision };
    if (raw.action === 'pause') api.goals.pause(agent, ref); else api.goals.resume(agent, ref);
    // The response is a fresh observation. An ambiguous transport outcome must never retry the old permit.
    return observation(agent, api, raw.generation, peer);
  }
  async function dispatch(endpoint, payload, signal, peer) {
    try {
      fields(payload, ['args']); fields(payload.args, ['request']);
      const operation = { 'nativeGoals/read': read, 'nativeGoals/catalog': catalog, 'nativeGoals/control': control }[endpoint];
      if (!operation) fail('invalid-request');
      return { ok: true, value: operation(payload.args.request, peer, signal) };
    } catch (error) {
      const code = typeof error?.code === 'string' && /^nativeGoals\/[a-z-]+$/.test(error.code) ? error.code : 'nativeGoals/unconfirmed';
      return { ok: false, error: { code, message: 'Native goal operation unavailable; refresh without replaying controls.', details: {} } };
    }
  }
  return Object.freeze({ dispatch,
    ownsSession(id, peer) { try { human(peer); if (!token(id)) return false; live(id, services()); return true; } catch { return false; } },
    close() { closed = true; permits.clear(); } });
}
