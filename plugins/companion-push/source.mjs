import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { envelope, eventId, fields, generation, LEASE_MS, MAX_ATTEMPTS, MAX_DEVICES, MAX_EVENTS, METHODS, publicConfig, refuse, uuid, validPayload, validRegistration } from './contracts.mjs';
import { PrivateStore } from './store.mjs';
import { createFcmSender } from './sender.mjs';

export const matchesGoalPush = endpoint => METHODS.includes(endpoint);
/** UNUSED factory. Only Parent's eventual scoped public Gateway contribution may expose dispatch.
 * ownsSession must synchronously prove a CURRENT native root using SDK services; never a disk loader,
 * request profile, caller list, cached catalog, bearer claim, or generic in-process fallback operator. */
export function createGoalPush(ctx, helpers = {}, config = {}) {
  const { scopeOf, scopeChainOf, foldGoal, ownsSession, identityOf = value => value, now = Date.now } = helpers;
  const profile = ctx.get('profileContext'), connection = ctx.get('connection');
  const directory = profile?.dir;
  const operator = connection?.operator;
  const scope = typeof scopeOf === 'function' ? scopeOf(ctx) : undefined;
  if (profile?.name !== 'companion' || !isAbsolute(profile?.dir ?? '') || !scope || !connection?.operator) refuse('scope-unavailable');
  const captured = { agents: ctx.get('agents'), goals: ctx.get('goals'), presets: ctx.get('agentPresets') };
  const p = publicConfig(config);
  const enabled = config.enabled === true;
  const sender = helpers.sender ?? createFcmSender(config, { now });
  let store, storeError = false, closed = false, flushing = false;
  // No private directory, credential read, sender request, or listener when unconfigured.
  if (enabled && p && typeof ownsSession === 'function' && sender.ready()) {
    // A held or orphaned writer lock is a specific, actionable state for the
    // operator; every other store failure stays the generic store-unavailable.
    try { store = new PrivateStore(profile.dir); }
    catch (error) { storeError = ['goalPush/store-locked', 'goalPush/store-lock-orphaned'].includes(error?.code) ? error.code.slice('goalPush/'.length) : 'store-unavailable'; }
  }
  const contextCurrent = () => !closed && ctx.get('profileContext') === profile && profile.name === 'companion' && profile.dir === directory &&
    identityOf(ctx.get('connection')) === identityOf(connection) && connection.operator === operator && !operator.ctx?.fiber?.isDisposed &&
    typeof scopeOf === 'function' && scopeOf(ctx) === scope &&
    identityOf(ctx.get('agents')) === identityOf(captured.agents) && identityOf(ctx.get('goals')) === identityOf(captured.goals) &&
    identityOf(ctx.get('agentPresets')) === identityOf(captured.presets);
  const ready = () => contextCurrent() && enabled && !!p && !!store && !store.closed && !storeError && sender.ready() && typeof ownsSession === 'function';
  function human(peer) {
    if (!contextCurrent() || peer !== connection.operator || !peer?.ctx || peer.ctx.fiber?.isDisposed) refuse('operator-required');
  }
  const owned = sessionId => {
    try { return contextCurrent() && ownsSession(sessionId, connection.operator) === true; } catch { return false; }
  };
  // Lifetime limits are never evicted (that would forget delivered IDs), so a
  // full ledger must show in status instead of a misleading "ready".
  // event-limit: no new completion can be recorded; device-limit: only devices
  // the ledger already knows can (re)register.
  const capacity = deviceId => {
    if (!store || store.closed) return undefined;
    const usage = store.usage(deviceId);
    if (usage.events >= MAX_EVENTS) return 'event-limit';
    if (usage.devices >= MAX_DEVICES && !usage.knownDevice) return 'device-limit';
    return undefined;
  };
  const status = deviceId => {
    const full = ready() ? capacity(deviceId) : undefined;
    return { version: 1, profile: 'companion', enabled, configured: !!p,
      registrationReady: ready() && !full, reason: ready() ? full ?? 'ready' : !contextCurrent() ? 'source-changed' : storeError ? storeError : store?.closed ? 'store-unavailable' : !enabled ? 'disabled' : !p ? 'unconfigured' :
        typeof ownsSession !== 'function' ? 'ownership-unavailable' : sender.status?.() ?? 'unavailable' };
  };
  function register(raw, peer) {
    human(peer);
    if (!ready()) refuse('not-ready');
    if (!validRegistration(raw)) refuse('invalid-request');
    if (capacity(raw.deviceId) === 'event-limit') refuse('event-limit');
    if (raw.configDigest !== p.configDigest) refuse('config-mismatch');
    if (!raw.sessionIds.every(owned)) refuse('not-owned');
    const requestedSessions = [...raw.sessionIds].sort();
    return store.change(state => {
      let device = state.devices.find(d => d.deviceId === raw.deviceId);
      if (device) {
        const receipt = device.receipt;
        if (device.active && receipt.expiresAt > now() && raw.authGeneration === device.generation && raw.tokenDigest === receipt.tokenDigest &&
            raw.configDigest === receipt.configDigest && isDeepStrictEqual(requestedSessions, [...receipt.sessionIds].sort())) return structuredClone(receipt);
        // Expiry, token rotation, subscription change, logout/re-register all require a fresh
        // persisted client epoch. A stale authenticated replay must never resurrect a binding.
        if (raw.authGeneration <= device.generation) refuse('stale-generation');
      } else {
        if (state.devices.length >= MAX_DEVICES) refuse('device-limit');
        device = { deviceId: raw.deviceId, generation: raw.authGeneration, active: false, token: null, receipt: null };
        state.devices.push(device);
      }
      for (const event of state.events) for (const target of event.targets) if (target.deviceId === device.deviceId && target.state === 'pending') target.state = 'revoked';
      const issuedAt = now();
      const receipt = { version: 1, registrationId: randomUUID(), bindingId: randomUUID(), profile: 'companion', ownerScopeId: state.ownerScopeId,
        authGeneration: raw.authGeneration, deviceId: raw.deviceId, tokenDigest: raw.tokenDigest, configDigest: p.configDigest,
        expiresAt: issuedAt + LEASE_MS, issuedAt, sessionIds: requestedSessions };
      Object.assign(device, { generation: raw.authGeneration, active: true, token: raw.token, receipt });
      return structuredClone(receipt);
    });
  }
  function unregister(raw, peer) {
    human(peer); fields(raw, ['version', 'deviceId', 'registrationId', 'authGeneration']);
    if (raw.version !== 1 || !uuid(raw.deviceId) || !uuid(raw.registrationId) || !generation(raw.authGeneration)) refuse('invalid-request');
    if (!store) refuse('not-ready');
    return store.change(state => {
      const device = state.devices.find(d => d.deviceId === raw.deviceId);
      if (!device || !device.active || device.receipt.registrationId !== raw.registrationId || raw.authGeneration !== device.generation) refuse('stale-registration');
      device.active = false; device.token = null; device.receipt = null;
      for (const event of state.events) for (const target of event.targets) if (target.deviceId === device.deviceId && target.state === 'pending') target.state = 'revoked';
      return { version: 1, unregistered: true };
    });
  }
  function readStatus(raw, peer) {
    human(peer); fields(raw, ['version', 'deviceId', 'authGeneration']);
    if (raw.version !== 1 || !uuid(raw.deviceId) || !generation(raw.authGeneration)) refuse('invalid-request');
    const device = store?.read().devices.find(d => d.deviceId === raw.deviceId);
    return { ...status(raw.deviceId), receipt: ready() && device?.active && device.generation === raw.authGeneration &&
      device.receipt.configDigest === p.configDigest && device.receipt.expiresAt > now() && device.receipt.sessionIds.every(owned) ? structuredClone(device.receipt) : null };
  }
  async function dispatch(endpoint, payload, signal, peer) {
    try {
      human(peer); signal?.throwIfAborted(); fields(payload, ['args']); fields(payload.args, ['request']);
      const operation = { 'goalPush/register': register, 'goalPush/unregister': unregister, 'goalPush/status': readStatus }[endpoint];
      if (!operation) refuse('invalid-request');
      return { ok: true, value: operation(payload.args.request, peer) };
    } catch (error) {
      const code = typeof error?.code === 'string' && /^goalPush\/[a-z-]+$/.test(error.code) ? error.code : 'goalPush/unavailable';
      return { ok: false, error: { code, message: 'Companion push unavailable; refresh authenticated state.', details: {} } };
    }
  }
  function enqueue(payload) {
    if (!ready() || !validPayload(payload) || !owned(payload.sessionId)) return false;
    return store.change(state => {
      if (state.events.some(e => e.payload.eventId === payload.eventId)) return false;
      if (state.events.length >= MAX_EVENTS) refuse('event-limit');
      const targets = state.devices.filter(d => d.active && d.receipt.expiresAt > now() && d.receipt.configDigest === p.configDigest && d.receipt.sessionIds.includes(payload.sessionId))
        .map(d => ({ deviceId: d.deviceId, registrationId: d.receipt.registrationId, bindingId: d.receipt.bindingId, state: 'pending', attempts: 0, nextAt: now() }));
      // Zero-recipient events are remembered too: a later registration is not permission to replay old completions.
      state.events.push({ payload: structuredClone(payload), targets }); return true;
    });
  }
  async function flush() {
    if (!ready() || flushing) return 0;
    flushing = true; let processed = 0;
    try {
      const batch = store.read().events.flatMap(e => e.targets.filter(t => t.state === 'pending' && t.nextAt <= now()).map(t => ({ eventId: e.payload.eventId, deviceId: t.deviceId }))).slice(0, 32);
      for (const key of batch) {
        if (!ready()) break;
        let work;
        store.change(state => {
          const event = state.events.find(e => e.payload.eventId === key.eventId), target = event.targets.find(t => t.deviceId === key.deviceId);
          const device = state.devices.find(d => d.deviceId === key.deviceId);
          if (target.state !== 'pending') return;
          if (!device?.active || device.receipt.registrationId !== target.registrationId || device.receipt.bindingId !== target.bindingId ||
              device.receipt.expiresAt <= now() || device.receipt.configDigest !== p.configDigest || !device.receipt.sessionIds.includes(event.payload.sessionId) || !owned(event.payload.sessionId)) { target.state = 'revoked'; return; }
          if (target.attempts >= MAX_ATTEMPTS) { target.state = 'exhausted'; return; }
          target.attempts++; target.nextAt = now() + 1000 * 2 ** target.attempts;
          work = { token: device.token, data: envelope(event.payload, device.receipt), registrationId: target.registrationId };
        });
        if (!work) continue;
        let result;
        try { result = await sender.send(work); } catch { result = { ok: false, retryable: true }; }
        if (closed) break;
        store.change(state => {
          const target = state.events.find(e => e.payload.eventId === key.eventId).targets.find(t => t.deviceId === key.deviceId);
          // Logout/rotation may occur while FCM is in flight. Never ack or revive its successor.
          if (target.state !== 'pending' || target.registrationId !== work.registrationId) return;
          if (result?.ok === true) target.state = 'delivered';
          else if (result?.unregistered === true) {
            target.state = 'revoked';
            const device = state.devices.find(d => d.deviceId === key.deviceId);
            if (device?.receipt?.registrationId === work.registrationId) { device.active = false; device.token = null; device.receipt = null; }
          } else if (result?.retryable !== true || target.attempts >= MAX_ATTEMPTS) target.state = 'exhausted';
        });
        processed++;
      }
      return processed;
    } finally { flushing = false; }
  }
  function onGoalChanged({ agent, change } = {}) {
    try {
      if (!ready() || typeof foldGoal !== 'function' || typeof scopeChainOf !== 'function' || !owned(agent?.id) ||
          captured.agents.get(agent.id) !== agent || !captured.agents.roots().includes(agent) ||
          agent.session.id !== agent.id || agent.session.header.id !== agent.id || agent.session.header.agentPreset !== 'companion' ||
          agent.session.header.origin !== undefined || agent.session.header.isSeeded !== false || captured.presets.composedPreset(agent.ctx) !== 'companion' ||
          !scopeChainOf(scopeOf(agent.ctx)).includes(scope) || change?.operation !== 'complete' || change.goal?.phase !== 'complete') return false;
      const current = captured.goals.get(agent);
      if (!isDeepStrictEqual(current, change.goal) || change.ref?.id !== current.id || change.ref?.revision !== current.revision) return false;
      const events = agent.session.snapshotEvents(), terminal = events.at(-1);
      if (terminal?.type !== 'goal/change' || terminal.data.operation !== 'complete' || terminal.data.goal.id !== current.id || terminal.data.goal.revision !== current.revision) return false;
      const before = foldGoal(events.slice(0, -1)), after = foldGoal(events);
      if (before.goal?.id !== current.id || before.goal.phase === 'complete' || before.goal.revision + 1 !== current.revision || !isDeepStrictEqual(after.goal, terminal.data.goal)) return false;
      return enqueue({ version: 1, eventId: eventId(agent.id, current.id, current.revision), goalId: current.id, revision: current.revision,
        sessionId: agent.id, phase: 'completed', timestamp: after.updatedAt });
    } catch {
      ctx.logger?.warn('companion-push: delivery unavailable; native goal unchanged'); return false;
    }
  }
  return Object.freeze({ dispatch, status: () => status(), onGoalChanged, flush,
    close() { if (closed) return; closed = true; sender.close?.(); store?.close(); } });
}
