import * as fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { attachProtocol } from './bridge-transport.mjs';
import { captureProvenance } from './provenance.mjs';
import { prepareRoot, processStart, capabilities, failure, sameIdentity, validId, validateSend, verifyGrant } from './bridge-security.mjs';

export const name = 'session-companion-bridge';
export const inject = ['agents'];
const REQUEST_LIMIT = 4096;

export async function startBridge(ctx, { root } = {}) {
  if (!ctx.agents?.list || !ctx.agents?.get) throw new Error('The public agents registry is required');
  const prepared = await prepareRoot(root);
  const identity = { bridgeId: randomUUID(), pid: process.pid, startTime: await processStart(process.pid) };
  const socketPath = path.join(prepared.root, 'bridges', `${identity.bridgeId}.sock`);
  if (Buffer.byteLength(socketPath) > 103) throw new Error('Unix socket path is too long');
  const recordPath = path.join(prepared.root, 'bridges', `${identity.bridgeId}.json`);
  const record = { version: 1, ...identity, socketPath };
  const agentIds = new WeakMap(), requests = new Map(), nonces = new Set();
  let closed = false, chain = Promise.resolve();
  const captures = new Map(), captureResults = new Map();
  function capture(agent) {
    if (closed || captures.has(agent) || agent.status !== 'idle') return;
    const pending = Promise.resolve().then(() => captureProvenance(ctx, agent, { root: prepared.root, bridgeIdentity: identity }));
    captures.set(agent, pending);
    pending.then(result => captureResults.set(agent.id, result)).finally(() => captures.delete(agent));
  }
  const unlisten = typeof ctx.on === 'function' && ctx.profileContext ? [
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
    return { sessionId: agent.id, agentIdentity: agentIds.get(agent), status: agent.status ?? 'unknown', state: 'live-confirmed', cwd: typeof header.cwd === 'string' ? header.cwd.slice(0, 2048) : undefined, title: typeof header.title === 'string' ? header.title.slice(0, 256) : undefined };
  }
  function envelope(result) { return { source: 'bridge', observedAt: new Date().toISOString(), capabilities, identity, ...result }; }
  function handle(request) {
    if (closed || !sameIdentity(request?.identity, identity)) return envelope(failure('identity_mismatch', 'Bridge identity changed'));
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
  const server = net.createServer();
  const disconnect = attachProtocol(server, request => {
    const pending = chain.then(() => handle(request));
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
    disconnect(); if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.unlink(socketPath).catch(() => {});
    throw error;
  }
  async function close() {
    if (closed) return;
    closed = true; disconnect();
    for (const dispose of unlisten) dispose?.();
    await Promise.all([...captures.values()]);
    await new Promise(resolve => server.close(resolve));
    await chain;
    // Only this instance's random paths are removed; no registry locks or other sessions are touched.
    await fs.unlink(recordPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { record: { ...record, root: prepared.root }, close, captureResults, captureProvenance: async agent => {
    capture(agent);
    await captures.get(agent);
    return captureResults.get(agent.id);
  } };
}

export async function apply(ctx, config = {}) {
  const bridge = await startBridge(ctx, { root: config.root });
  ctx.on('dispose', () => bridge.close());
  return bridge;
}
