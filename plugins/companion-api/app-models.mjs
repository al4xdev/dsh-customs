// STAGED ONLY. Native Session selection remains the sole route/effort owner.
import { resolveHost } from '../common.mjs';
import { AGY_PROVIDER } from './agy-budget.mjs';
const { RemoteError } = await import(resolveHost('@deepseek-ai/dsh-typert-protocol'));
const { symbols } = await import(resolveHost('@deepseek-ai/cordis'));
// Public Cordis export canonicalizes only source identity, never private controller selection state.
const original = service => service?.[symbols.original] ?? service;
export const APP_MODEL_MAX_ROOTS = 32;
const codes = ['model-apply-failed', 'model-session-changed', 'model-unavailable'];
const same = (a, b) => a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort;
export function appModelError(code) { return new RemoteError(`companion/${code}`, 'App model operation was refused or could not be confirmed.', {}); }
function object(value, keys, code = 'model-invalid-request') {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw appModelError(code);
}
function identity(value, code = 'model-invalid-request') {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) throw appModelError(code);
  return value;
}
export function appModelContracts(parseChoice, parseChoiceRequest) {
  const strictChoice = (value, code = 'model-invalid-request') => { object(value, ['provider', 'model', 'reasoningEffort'], code); return parseChoice(value, code); };
  const selectRequest = value => {
    object(value, ['provider', 'model', 'reasoningEffort', 'expectedCurrent']);
    strictChoice(value.expectedCurrent);
    return parseChoiceRequest(value);
  };
  const applyRequest = value => {
    object(value, ['sessionId', 'createdAt', 'expectedCurrent']);
    if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw appModelError('model-invalid-request');
    return { sessionId: identity(value.sessionId), createdAt: value.createdAt, expectedCurrent: strictChoice(value.expectedCurrent) };
  };
  const output = value => {
    const invalid = 'model-invalid-output';
    object(value, ['version', 'profile', 'current', 'scope', 'applied', 'failed', 'cold'], invalid);
    if (value.version !== 1 || value.profile !== 'companion' || value.scope !== 'all-companion-conversations' || value.cold !== 'on-next-user-send' ||
      !Array.isArray(value.applied) || !Array.isArray(value.failed) || value.applied.length + value.failed.length > APP_MODEL_MAX_ROOTS) throw appModelError(invalid);
    strictChoice(value.current, invalid);
    const seen = new Set();
    for (const [rows, failed] of [[value.applied, false], [value.failed, true]]) for (const row of rows) {
      object(row, failed ? ['sessionId', 'createdAt', 'code'] : ['sessionId', 'createdAt'], invalid);
      identity(row.sessionId, invalid);
      if (!Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || seen.has(row.sessionId) || (failed && !codes.includes(row.code))) throw appModelError(invalid);
      seen.add(row.sessionId);
    }
    if (Buffer.byteLength(JSON.stringify(value)) > 16384) throw appModelError(invalid);
    return value;
  };
  const codec = (name, parse) => ({ mode: 'strict', typeSymbol: name, create: () => ({ parse }) });
  return { selectRequest, applyRequest, output, codecs: {
    selectAppModelRequest: codec('CompanionSelectAppModelRequest', selectRequest),
    selectAppModelOutput: codec('CompanionSelectAppModelOutput', output),
    applyAppModelRequest: codec('CompanionApplyAppModelRequest', applyRequest),
    applyAppModelOutput: codec('CompanionApplyAppModelOutput', output),
  } };
}

/** Bound once to one real profile/source; invocation context is passed by the Remote Service, never by wire input. */
export function createAppModelOperations(ctx, hooks) {
  const profile = ctx.get('profileContext'), profileName = profile?.name, directory = profile?.dir, root = ctx.root;
  const ownerFiber = ctx.fiber, rootFiber = root?.fiber, ownerUid = ownerFiber?.uid, rootUid = rootFiber?.uid;
  let source, invalidOwner = false;
  const keys = ['connection', 'agents', 'sessions', 'sessionController', 'typertGateway', 'agentDefaultModel', 'llm', 'settings', 'configEditor', 'sessionQuery'];
  // Pin public lifetime tokens; Root uid0 is valid, missing/null tokens never authorize or get recaptured.
  const validUid = uid => Number.isSafeInteger(uid) && uid >= 0;
  const sameFiber = (fiber, uid) => !!fiber && validUid(uid) && fiber.uid === uid;
  const serviceFiber = value => original(value)?.ctx?.fiber;
  const serviceAlive = fiber => fiber === undefined || sameFiber(fiber, fiber?.uid);
  function ownerChanged() {
    // A failed caller or missing capability before first authenticated binding must not poison this owner.
    if (source) invalidOwner = true;
    throw appModelError('model-source-changed');
  }
  function boundary(invocationCtx) {
    if (invocationCtx?.root !== root) throw appModelError('model-source-changed');
    const peer = invocationCtx.invocation?.peer, operator = root?.get('connection')?.operator;
    // Authenticate independently of the owner's mutable service aliases before latching any owner failure.
    if (!peer || peer.ctx?.root !== root ||
      (peer !== operator && (!source || peer !== source.peer || peer.ctx !== source.peerCtx))) throw appModelError('model-operator-required');
    if (!validUid(peer.ctx?.fiber?.uid)) {
      if (source && peer === source.peer && peer.ctx === source.peerCtx) ownerChanged();
      throw appModelError('model-operator-required');
    }
    if (invocationCtx.get('profileContext') !== ctx.get('profileContext')) throw appModelError('model-source-changed');
    if (invalidOwner) throw appModelError('model-source-changed');
    if (!root || ctx.root !== root || ctx.fiber !== ownerFiber || root.fiber !== rootFiber ||
      !sameFiber(ownerFiber, ownerUid) || !sameFiber(rootFiber, rootUid) ||
      profileName !== 'companion' || typeof directory !== 'string' || !directory.startsWith('/') || ctx.get('profileContext') !== profile ||
      profile?.name !== profileName || profile?.dir !== directory) ownerChanged();
    const values = Object.fromEntries(keys.map(key => [key, ctx.get(key)]));
    if (keys.some(key => !values[key] || original(root.get(key)) !== original(values[key]))) ownerChanged();
    if (source && (keys.some(key => original(values[key]) !== source.identities[key] ||
      serviceFiber(values[key]) !== source.fibers[key] || (source.fibers[key] !== undefined && !sameFiber(source.fibers[key], source.uids[key]))) ||
      peer !== source.peer || peer.ctx !== source.peerCtx || peer.ctx.fiber !== source.peerFiber || !sameFiber(source.peerFiber, source.peerUid))) ownerChanged();
    if (keys.some(key => !serviceAlive(serviceFiber(values[key])))) ownerChanged();
    // Caller-scoped aliases are refusal-only: a foreign invoker must never invalidate the legitimate owner.
    if (!values.connection?.operator || peer !== values.connection.operator || invocationCtx.get('connection')?.operator !== peer) throw appModelError('model-operator-required');
    if (keys.some(key => original(invocationCtx.get(key)) !== original(values[key]))) throw appModelError('model-source-changed');
    if (!source) source = { ...values, identities: Object.fromEntries(keys.map(key => [key, original(values[key])])),
      fibers: Object.fromEntries(keys.map(key => [key, serviceFiber(values[key])])),
      uids: Object.fromEntries(keys.map(key => [key, serviceFiber(values[key])?.uid])),
      peer, peerCtx: peer.ctx, peerFiber: peer.ctx.fiber, peerUid: peer.ctx.fiber.uid };
    return source;
  }
  function ownedHeader(header) {
    return header?.agentPreset === 'companion' && !header.isSeeded && header.origin !== 'subagent' && header.parentSession === undefined &&
      typeof header.id === 'string' && Number.isSafeInteger(header.createdAt) && header.createdAt >= 0;
  }
  function live(agent, expected, owner) {
    return agent && ownedHeader(agent.session?.header) && agent.id === expected.sessionId && agent.session.header.id === agent.id &&
      agent.session.header.createdAt === expected.createdAt && owner.agents.get(agent.id) === agent && owner.sessions.get(agent.id) === agent.session && owner.agents.roots().includes(agent);
  }
  const dto = (current, applied, failed) => hooks.contracts.output({ version: 1, profile: 'companion', current, scope: 'all-companion-conversations', applied, failed, cold: 'on-next-user-send' });
  async function local(choice, signal) {
    if (choice.provider !== 'strata-local' && choice.provider !== AGY_PROVIDER) return;
    // Local identity and AGY request budget must be admissible before saving a global intent.
    if (typeof hooks.policy?.assertLocalModel !== 'function') throw appModelError('model-unavailable');
    try { await hooks.policy.assertLocalModel(choice, signal, ctx.get('llm')); } catch { throw appModelError('model-unavailable'); }
  }
  async function barrier(choice, invocationCtx) {
    const owner = boundary(invocationCtx);
    try { await owner.agentDefaultModel.saveSelection(choice); } catch { throw appModelError('model-save-unconfirmed'); }
    try {
      boundary(invocationCtx);
      const verified = hooks.current();
      if (!same(verified, choice)) throw appModelError('model-save-unconfirmed');
      return verified;
    } catch { throw appModelError('model-save-unconfirmed'); }
  }
  async function invoke(agent, expected, choice, invocationCtx, signal) {
    const owner = boundary(invocationCtx);
    if (!live(agent, expected, owner)) return { ...expected, code: 'model-session-changed' };
    await local(choice, signal);
    boundary(invocationCtx);
    if (!live(agent, expected, owner)) return { ...expected, code: 'model-session-changed' };
    try {
      const result = await owner.typertGateway.invoke({ namespace: 'session', method: 'selectModel', args: { request: { sessionId: agent.id, ...choice } }, peer: owner.peer, ...(signal ? { signal } : {}) });
      if (!live(agent, expected, owner)) return { ...expected, code: 'model-session-changed' };
      if (!same(result?.selected ?? {}, choice)) return { ...expected, code: 'model-apply-failed' };
      return null;
    } catch { return { ...expected, code: 'model-apply-failed' }; }
  }
  async function selectAppModel(raw, signal, invocationCtx) {
    const request = hooks.contracts.selectRequest(raw);
    boundary(invocationCtx);
    return hooks.serialize(async () => {
      signal?.throwIfAborted();
      const owner = boundary(invocationCtx);
      hooks.checkWritable();
      if (!same(hooks.current(), request.expectedCurrent)) throw appModelError('model-default-conflict');
      const normalized = await hooks.normalize(request, signal);
      await local(normalized, signal);
      boundary(invocationCtx);
      if (!same(hooks.current(), request.expectedCurrent)) throw appModelError('model-default-conflict');
      const targets = owner.agents.roots().filter(agent => ownedHeader(agent.session?.header)).map(agent => ({ agent,
        expected: { sessionId: identity(agent.id), createdAt: agent.session.header.createdAt } }));
      if (targets.length > APP_MODEL_MAX_ROOTS) throw appModelError('model-catalog-limit');
      if (targets.some(({ agent, expected }) => !live(agent, expected, owner))) throw appModelError('model-source-changed');
      signal?.throwIfAborted();
      await barrier(normalized, invocationCtx); // Intent commits first; no rollback of other conversations on partial failure.
      const applied = [], failed = [];
      for (const { agent, expected } of targets) {
        // Once intent commits cancellation can mean a partial operation; never pretend it was rolled back.
        try { boundary(invocationCtx); } catch { throw appModelError('model-save-unconfirmed'); }
        if (signal?.aborted) { failed.push({ ...expected, code: 'model-apply-failed' }); continue; }
        let failure;
        try { failure = await invoke(agent, expected, normalized, invocationCtx, signal); }
        catch (error) { if (error.code === 'companion/model-source-changed' || error.code === 'companion/model-operator-required') throw appModelError('model-save-unconfirmed'); failure = { ...expected, code: 'model-unavailable' }; }
        if (failure) failed.push(failure); else applied.push(expected);
      }
      // Public save serializes after every native background save before the next app/default choice enters this SAME lane.
      try { return dto(await barrier(normalized, invocationCtx), applied, failed); }
      catch { throw appModelError('model-save-unconfirmed'); }
    });
  }
  async function applyAppModel(raw, signal, invocationCtx) {
    const request = hooks.contracts.applyRequest(raw);
    boundary(invocationCtx);
    return hooks.serialize(async () => {
      signal?.throwIfAborted();
      const owner = boundary(invocationCtx);
      hooks.checkWritable();
      if (!same(hooks.current(), request.expectedCurrent)) throw appModelError('model-default-conflict');
      const choice = await hooks.normalize(request.expectedCurrent, signal);
      await local(choice, signal);
      let agent = owner.agents.get(request.sessionId);
      if (!agent) {
        // Read-only exact header observation first. This endpoint is only for explicit user SEND, never screen opening.
        let observation;
        try {
          observation = await owner.sessionQuery.observeSession(request.sessionId, { projectionMode: 'none', ...(signal ? { signal } : {}) });
          if (!ownedHeader(observation.header) || observation.header.id !== request.sessionId || observation.header.createdAt !== request.createdAt) throw appModelError('model-session-changed');
        } catch { throw appModelError('model-session-changed'); }
        finally { try { await observation?.[Symbol.dispose](); } catch { throw appModelError('model-session-changed'); } }
        boundary(invocationCtx); signal?.throwIfAborted();
        if (!same(hooks.current(), request.expectedCurrent)) throw appModelError('model-default-conflict');
        try { agent = (await owner.sessionController.resolveAgent(request.sessionId)).agent; }
        catch { throw appModelError('model-session-changed'); }
      }
      boundary(invocationCtx);
      if (!live(agent, request, owner)) throw appModelError('model-session-changed');
      if (!same(hooks.current(), request.expectedCurrent)) throw appModelError('model-default-conflict');
      const expected = { sessionId: request.sessionId, createdAt: request.createdAt };
      const failure = await invoke(agent, expected, choice, invocationCtx, signal);
      try { return dto(await barrier(choice, invocationCtx), failure ? [] : [expected], failure ? [failure] : []); }
      catch { throw appModelError('model-save-unconfirmed'); }
    });
  }
  return { selectAppModel, applyAppModel };
}

/** Proposed strict generated contribution; caller supplies its real owning Remote Service key. */
export function appModelContribution(codecs, service = 'companionCatalog') {
  return { package: 'dsh-customs-companion-app-model-stage', face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
    invocations: ['selectAppModel', 'applyAppModel'].map(method => ({ id: `companion/${method}`, service, namespace: 'companion', method,
      invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codecs[`${method}Request`] }],
      cancellation: { parameter: 'signal' }, result: codecs[`${method}Output`] })) };
}
