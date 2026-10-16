import * as fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { attachProtocol } from './bridge-transport.mjs';
import { captureProvenance } from './provenance.mjs';
import { createProfileHost } from '../session-create/profile-host.mjs';
import { prepareRoot, processStart, capabilities, failure, sameIdentity, SIDE_OPERATIONS, validId, validateSend, validateSideRequest, verifyGrant, verifySideGrant } from './bridge-security.mjs';
import { refusedCharacter } from './approval-text.mjs';
import { runSideQuery, SIDE_TIMEOUT_MS } from './side-query.mjs';

export const name = 'session-companion-bridge';
export const inject = ['agents'];
const REQUEST_LIMIT = 4096;

const CLOSE_TIMEOUT_MS = 5000;
// Per target agent: one side query at a time and at most SIDE_RATE_LIMIT
// started per minute. They are cheap, but each is a real model call billed to
// that agent's route, and a looping caller must not hammer it.
const SIDE_RATE_LIMIT = 6, SIDE_RATE_WINDOW_MS = 60_000, SIDE_NONCE_LIMIT = 4096;
// Bounded wait: shutdown proceeds (and unpublishes) even if a drain step hangs.
const settleWithin = (promise, ms) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms); timer.unref?.();
  Promise.resolve(promise).catch(() => {}).finally(() => { clearTimeout(timer); resolve(); });
});

/** `createHost` is a fixture seam only; production always uses the real profile host. */
export async function startBridge(ctx, { root, createHost = createProfileHost, closeTimeoutMs = CLOSE_TIMEOUT_MS, sideTimeoutMs = SIDE_TIMEOUT_MS, now = Date.now } = {}) {
  if (!ctx.agents?.list || !ctx.agents?.get) throw new Error('The public agents registry is required');
  const prepared = await prepareRoot(root);
  const identity = { bridgeId: randomUUID(), pid: process.pid, startTime: await processStart(process.pid) };
  const profileHost = createHost(ctx, { root: prepared.root, key: prepared.key, identity });
  const socketPath = path.join(prepared.root, 'bridges', `${identity.bridgeId}.sock`);
  if (Buffer.byteLength(socketPath) > 103) throw new Error('Unix socket path is too long');
  const recordPath = path.join(prepared.root, 'bridges', `${identity.bridgeId}.json`);
  // `host` lets discovery leave records from another machine sharing this home alone.
  const record = { version: 1, ...identity, socketPath, host: os.hostname() };
  const agentIds = new WeakMap(), requests = new Map(), nonces = new Set();
  let closed = false, chain = Promise.resolve();
  const captures = new Map(), captureResults = new Map();
  // Provenance is optional: do not turn it into required bridge dependencies,
  // or access undeclared services through a mounted Cordis plugin proxy.
  const optional = name => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name];
  const provenanceContext = () => ({
    ...Object.fromEntries(['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'profileContext', 'loader', 'tools', 'agentPresets'].map(name => [name, optional(name)])),
    get: optional,
  });
  function capture(agent) {
    if (closed || captures.has(agent) || agent.status !== 'idle') return;
    const pending = Promise.resolve().then(() => captureProvenance(provenanceContext(), agent, { root: prepared.root, bridgeIdentity: identity })).catch(error => ({ ok: false, reason: error.message }));
    captures.set(agent, pending);
    pending.then(result => captureResults.set(agent.id, result)).finally(() => captures.delete(agent));
  }
  const unlisten = typeof ctx.on === 'function' && optional('profileContext') ? [
    ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') capture(agent); }),
    ctx.on('agent/created', ({ agent }) => { capture(agent); }),
  ] : [];
  for (const agent of ctx.agents.list()) capture(agent);
  function live(id) {
    const agent = ctx.agents.get(id);
    return agent && agent.id === id && ctx.agents.list().includes(agent) && agent.status !== 'disposed' ? agent : undefined;
  }
  function describe(agent) {
    if (!agentIds.has(agent)) agentIds.set(agent, randomUUID());
    const header = agent.session?.header ?? {};
    return { sessionId: agent.id, agentIdentity: agentIds.get(agent), status: agent.status ?? 'unknown', state: 'live-confirmed', send: typeof agent.send === 'function', cwd: typeof header.cwd === 'string' ? header.cwd.slice(0, 2048) : undefined, title: typeof header.title === 'string' ? header.title.slice(0, 256) : undefined };
  }
  function envelope(result) { return { source: 'bridge', observedAt: new Date().toISOString(), identity, ...result, capabilities: { ...capabilities, createProfile: profileHost.capabilities() } }; }
  async function handle(request) {
    if (closed || !sameIdentity(request?.identity, identity)) return envelope(failure('identity_mismatch', 'Bridge identity changed'));
    if (request.operation === 'prepare-create' || request.operation === 'create-session') return envelope(await profileHost.handle(request));
    if (request.operation === 'list') {
      if (Object.keys(request).some(key => !['operation', 'identity'].includes(key))) return envelope(failure('invalid_request', 'Unexpected list fields'));
      const agents = ctx.agents.list().filter(agent => validId(agent.id) && live(agent.id) === agent).map(describe);
      if (agents.length > 128 || Buffer.byteLength(JSON.stringify(agents)) > 32 * 1024) return envelope(failure('output_limit', 'Registry exceeds bridge output budget'));
      return envelope({ ok: true, agents });
    }
    if (request.operation === 'inspect') {
      if (!validId(request.sessionId) || Object.keys(request).some(key => !['operation', 'identity', 'sessionId'].includes(key))) return envelope(failure('invalid_request', 'Invalid inspect destination'));
      const agent = live(request.sessionId);
      return envelope(agent ? { ok: true, agent: describe(agent) } : failure('agent_not_live', 'No exact live registry agent'));
    }
    if (request.operation !== 'send') return envelope(failure('operation_unavailable', 'Only list, inspect and send are supported'));
    if (!validateSend(request) || Object.keys(request).some(key => !['operation', 'identity', 'sessionId', 'text', 'requestId', 'grant'].includes(key))) return envelope(failure('invalid_request', 'Invalid send fields'));
    if (!verifyGrant(request.grant, request, identity, prepared.key)) return envelope(failure('grant_invalid', 'Grant is missing, altered, expired or invalid'));
    const fingerprint = JSON.stringify([request.sessionId, request.text, request.grant.agentIdentity]);
    const prior = requests.get(request.requestId);
    if (prior) return envelope(prior.fingerprint === fingerprint ? { ...prior.result, deduplicated: true } : failure('request_conflict', 'Request ID was already bound to another payload'));
    if (nonces.has(request.grant.nonce)) return envelope(failure('grant_replayed', 'Grant nonce was already consumed'));
    // Never evict accepted IDs within this bridge lifetime: eviction could turn a retry into a duplicate effect.
    if (requests.size >= REQUEST_LIMIT) return envelope(failure('dedup_capacity', 'Bridge request budget exhausted; sending is unavailable'));
    const agent = live(request.sessionId);
    if (!agent || describe(agent).agentIdentity !== request.grant.agentIdentity || typeof agent.send !== 'function') return envelope(failure('agent_not_live', 'Approved exact live agent no longer exists'));
    nonces.add(request.grant.nonce);
    // Reserve before invoking public runtime code, including code that synchronously throws after admission.
    const entry = { fingerprint, result: failure('delivery_unknown', 'Admission did not return an ACK; do not retry automatically', { retrySafe: false, requestId: request.requestId }) };
    requests.set(request.requestId, entry);
    try {
      agent.send({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: request.text }], source: { kind: 'user' } }, 'next-turn', true);
      entry.result = { ok: true, ack: { requestId: request.requestId, sessionId: request.sessionId, accepted: true, boundary: 'next-turn' }, deduplicated: false, retrySafe: false };
    } catch { /* A runtime exception can occur after inbox admission, so it is not proof of non-delivery. */ }
    return envelope(entry.result);
  }
  // ask/recap: authenticated like send, under their own MAC domain, but no human
  // approval and NOT serialized behind sends/creates: a 2-minute model call
  // must never delay a send, and nothing here touches the agent or its log.
  const sideNonces = new Map(), sideBusy = new WeakSet(), sideStarts = new WeakMap(), sideCalls = new Set();
  const sideLifetime = new AbortController();
  async function handleSide(request, signal) {
    if (closed || !sameIdentity(request?.identity, identity)) return envelope(failure('identity_mismatch', 'Bridge identity changed'));
    const allowed = ['operation', 'identity', 'sessionId', 'requestId', 'grant', ...(request.operation === 'ask' ? ['question'] : [])];
    if (!validateSideRequest(request) || Object.keys(request).some(key => !allowed.includes(key)) || (request.question !== undefined && refusedCharacter(request.question))) return envelope(failure('invalid_request', 'Invalid side query fields'));
    const at = now();
    // Grants use wall-clock time; `now` (a fixture seam) only drives the rate limiter.
    if (!verifySideGrant(request.grant, request, identity, prepared.key)) return envelope(failure('grant_invalid', 'Side-query grant is missing, altered, expired or of another domain'));
    // Side nonces may be forgotten once expired: an expired grant fails anyway.
    for (const [nonce, expiresAt] of sideNonces) if (expiresAt <= Date.now()) sideNonces.delete(nonce);
    if (sideNonces.has(request.grant.nonce)) return envelope(failure('grant_replayed', 'Grant nonce was already consumed'));
    if (sideNonces.size >= SIDE_NONCE_LIMIT) return envelope(failure('side_capacity', 'Too many side queries in flight; retry shortly', { retrySafe: true }));
    sideNonces.set(request.grant.nonce, request.grant.expiresAt);
    const agent = live(request.sessionId);
    if (!agent || describe(agent).agentIdentity !== request.grant.agentIdentity) return envelope(failure('agent_not_live', 'Target agent is no longer hosted here'));
    if (sideBusy.has(agent)) return envelope(failure('side_busy', 'Another side query for this session is still running; retry after it ends', { retrySafe: true }));
    const recent = (sideStarts.get(agent) ?? []).filter(started => at - started < SIDE_RATE_WINDOW_MS);
    if (recent.length >= SIDE_RATE_LIMIT) return envelope(failure('side_rate_limited', `At most ${SIDE_RATE_LIMIT} side queries per minute per session`, { retrySafe: true, retryAfterMs: SIDE_RATE_WINDOW_MS - (at - recent[0]) }));
    sideStarts.set(agent, [...recent, at]);
    sideBusy.add(agent);
    const run = runSideQuery({ llm: optional('llm'), agent, kind: request.operation, question: request.question, signal: AbortSignal.any([signal, sideLifetime.signal]), timeoutMs: sideTimeoutMs })
      .catch(error => ({ ok: false, code: 'side_failed', reason: String(error?.message ?? error).slice(0, 240) }));
    sideCalls.add(run);
    try {
      const result = await run;
      return envelope(result.ok ? { ok: true, sessionId: request.sessionId, requestId: request.requestId, answer: result.answer } : failure(result.code, result.reason, { retrySafe: true }));
    } finally { sideBusy.delete(agent); sideCalls.delete(run); }
  }
  const server = net.createServer();
  const disconnect = attachProtocol(server, (request, { current = () => true, signal = new AbortController().signal } = {}) => {
    if (SIDE_OPERATIONS.includes(request?.operation)) return current() ? handleSide(request, signal) : envelope(failure('request_expired', 'Request outlived its connection'));
    // Re-check at dequeue time: a send queued behind a slow create may have
    // outlived its client. Skipping it is the only outcome without an effect.
    const pending = chain.then(() => current() ? handle(request) : envelope(failure('request_expired', 'Request outlived its connection before it could run; it had no effect')));
    chain = pending.catch(() => {});
    return pending;
  });
  server.on('error', () => {});
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); }); });
    await fs.chmod(socketPath, 0o600);
    const temporary = `${recordPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, recordPath);
  } catch (error) {
    disconnect(); if (server.listening) await new Promise(resolve => { server.close(resolve); });
    await fs.unlink(socketPath).catch(() => {});
    throw error;
  }
  let closing;
  function close() {
    closing ??= (async () => {
      closed = true;
      const failures = [];
      const unlink = file => fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') failures.push(error); });
      // Unpublish first, so a hung drain can never leave a discoverable record
      // for a bridge that no longer serves. Only this instance's random paths
      // are removed; no registry locks or other sessions are touched.
      await unlink(recordPath);
      try {
        sideLifetime.abort();
        disconnect();
        for (const dispose of unlisten) { try { dispose?.(); } catch { /* Keep closing. */ } }
        const stopped = new Promise(resolve => { server.close(() => resolve()); });
        await settleWithin(Promise.allSettled([...captures.values(), stopped, chain, ...sideCalls]), closeTimeoutMs);
        // The host bounds each of its own steps (drain, flush, dispose) by the same timeout.
        await settleWithin(Promise.resolve().then(() => profileHost.close({ timeoutMs: closeTimeoutMs })), 3 * closeTimeoutMs);
      } finally { await unlink(socketPath); }
      if (failures.length) throw failures[0];
    })();
    return closing;
  }
  return { record: { ...record, root: prepared.root }, close, captureResults, captureProvenance: async agent => {
    capture(agent);
    await captures.get(agent);
    return captureResults.get(agent.id);
  } };
}

export async function apply(ctx, config = {}) {
  const bridge = await startBridge(ctx, { root: config.root });
  // Return the asynchronous disposer so Cordis owns and awaits socket/handle
  // shutdown; an ordinary dispose event listener is not a resource lifetime.
  return () => bridge.close();
}
