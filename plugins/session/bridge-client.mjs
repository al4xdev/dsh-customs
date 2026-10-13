import * as fs from 'node:fs/promises';
import path from 'node:path';
import { exchange } from './bridge-transport.mjs';
import { DEFAULT_ROOT, capabilities, failure, privateStat, readKey, grantPayload, signGrant, validId, validateSend } from './bridge-security.mjs';

export async function discoverBridges({ root = DEFAULT_ROOT, signal } = {}) {
  root = path.resolve(root);
  const bridges = [], errors = [];
  try {
    signal?.throwIfAborted();
    await privateStat(root, 'dir', 0o700);
    await privateStat(path.join(root, 'bridges'), 'dir', 0o700);
    const files = await fs.readdir(path.join(root, 'bridges'));
    if (files.length > 512) return failure('discovery_limit', 'Discovery directory exceeds budget', { bridges, errors });
    for (const file of files) {
      signal?.throwIfAborted();
      if (!file.endsWith('.json')) continue;
      try {
        const filePath = path.join(root, 'bridges', file);
        const stat = await privateStat(filePath, 'file', 0o600);
        if (stat.size > 4096) throw new Error('Discovery record exceeds budget');
        const record = { ...JSON.parse(await fs.readFile(filePath, 'utf8')), root };
        if (record.version !== 1 || file !== `${record.bridgeId}.json`) throw new Error('Invalid discovery record');
        const result = await queryBridge(record, { operation: 'list' }, signal);
        signal?.throwIfAborted();
        if (result.ok) bridges.push({ ...record, agents: result.agents, observedAt: result.observedAt, capabilities: result.capabilities });
        else errors.push({ file, ...result.error });
      } catch (error) {
        if (signal?.aborted) throw error;
        errors.push({ file, code: 'invalid_discovery', message: error.message });
      }
    }
    return { ok: true, bridges, errors, capabilities, observedAt: new Date().toISOString() };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, bridges, errors, capabilities, observedAt: new Date().toISOString() };
    return failure(signal?.aborted ? 'cancelled' : 'discovery_unavailable', error.message, { bridges, errors });
  }
}

export async function queryBridge(record, { operation, sessionId } = {}, signal) {
  if (!['list', 'inspect'].includes(operation) || (operation === 'inspect' && !validId(sessionId)) || (operation === 'list' && sessionId !== undefined)) return failure('invalid_request', 'Expected list or inspect with an exact session ID');
  return exchange(record, { operation, ...(sessionId === undefined ? {} : { sessionId }) }, signal);
}

// This trusted host-side API must only be called by the companion tool AFTER native allowed-once approval.
// An approval boolean from a model or a transport caller is never accepted as authority.
export async function sendBridge(record, { sessionId, text, requestId } = {}, signal) {
  const request = { operation: 'send', sessionId, text, requestId };
  if (!validateSend(request)) return failure('invalid_request', 'Invalid destination, request ID or text');
  const agent = Array.isArray(record?.agents) ? record.agents.find(agent => agent?.sessionId === sessionId) : undefined;
  if (!agent || !validId(agent.agentIdentity)) return failure('agent_not_live', 'Destination must come from a live discovery handshake');
  try {
    signal?.throwIfAborted();
    const key = await readKey(record.root);
    request.grant = signGrant(grantPayload(request, record, agent.agentIdentity), key);
    signal?.throwIfAborted();
    return await exchange(record, request, signal);
  } catch (error) { return failure(signal?.aborted ? 'cancelled' : 'grant_unavailable', error.message, { retrySafe: true }); }
}
