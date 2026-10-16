import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exchange, SIDE_CLIENT_MS } from './bridge-transport.mjs';
import { DEFAULT_ROOT, capabilities, failure, privateStat, procReliable, processStart, readKey, grantPayload, signGrant, sideGrantPayload, signSideGrant, validId, validateSend, validateSideRequest } from './bridge-security.mjs';

// Budgets count discovery RECORDS (.json), not directory entries: every bridge
// also owns a .sock, and crashed hosts used to leave both behind, so 260 dead
// hosts were enough to hide every live bridge behind discovery_limit.
export const MAX_DISCOVERY_RECORDS = 512;
const MAX_DIRECTORY_RECORDS = 4096;

// A record is provably stale only when the kernel says its process is gone
// (no /proc entry) or the PID was reused (other numeric start ticks), and only
// for a record this host wrote, seen through a procfs that shows our own entry.
// Any other probe result is not evidence: that record is kept and reported.
async function processState(record, reliable) {
  if (!reliable || !Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.startTime !== 'string' || (record.host !== undefined && record.host !== os.hostname())) return 'unknown';
  try {
    const start = await processStart(record.pid);
    return start === record.startTime ? 'alive' : /^\d+$/.test(start ?? '') ? 'dead' : 'unknown';
  } catch (error) { return error?.code === 'ENOENT' ? 'dead' : 'unknown'; }
}
// Only the dead record's own random paths in the private directory. Bridge IDs
// are random UUIDs, so a later host can never be published under these names.
async function removeStale(directory, bridgeId) {
  for (const suffix of ['.json', '.sock']) await fs.unlink(path.join(directory, `${bridgeId}${suffix}`)).catch(() => {});
}

export async function discoverBridges({ root = DEFAULT_ROOT, signal } = {}) {
  root = path.resolve(root);
  const bridges = [], errors = [];
  let stale = 0, examined = 0;
  try {
    signal?.throwIfAborted();
    await privateStat(root, 'dir', 0o700);
    const directory = path.join(root, 'bridges');
    await privateStat(directory, 'dir', 0o700);
    const all = (await fs.readdir(directory)).filter(file => file.endsWith('.json'));
    // Bounded work per call, but never a permanent refusal: each discovery
    // still cleans up to this many records, so a flood of dead ones drains.
    const files = all.slice(0, MAX_DIRECTORY_RECORDS);
    if (all.length > files.length) errors.push({ code: 'discovery_limit', message: `${all.length - files.length} records were not examined in this pass` });
    const reliable = await procReliable();
    for (const file of files) {
      signal?.throwIfAborted();
      try {
        const filePath = path.join(directory, file);
        const stat = await privateStat(filePath, 'file', 0o600);
        if (stat.size > 4096) throw new Error('Discovery record exceeds budget');
        const record = { ...JSON.parse(await fs.readFile(filePath, 'utf8')), root };
        if (record.version !== 1 || !validId(record.bridgeId) || file !== `${record.bridgeId}.json`) throw new Error('Invalid discovery record');
        if (await processState(record, reliable) === 'dead') { await removeStale(directory, record.bridgeId); stale++; continue; }
        // Dead records no longer consume the budget; live-looking ones still do.
        if (++examined > MAX_DISCOVERY_RECORDS) { errors.push({ file, code: 'discovery_limit', message: 'Remaining records were not queried' }); break; }
        const result = await queryBridge(record, { operation: 'list' }, signal);
        signal?.throwIfAborted();
        if (result.ok) bridges.push({ ...record, agents: result.agents, observedAt: result.observedAt, capabilities: result.capabilities });
        else errors.push({ file, ...result.error });
      } catch (error) {
        if (signal?.aborted) throw error;
        // A concurrent discoverer may have just removed this stale record.
        if (error?.code === 'ENOENT') continue;
        errors.push({ file, code: 'invalid_discovery', message: error.message });
      }
    }
    return { ok: true, bridges, errors, stale, capabilities, observedAt: new Date().toISOString() };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, bridges, errors, stale, capabilities, observedAt: new Date().toISOString() };
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

/**
 * ask/recap on a live agent of `record`'s host. No approval: the grant only
 * proves key possession (own MAC domain). Read-like, so every transport
 * failure is retry-safe; the caller still never retries automatically.
 */
export async function sideQueryBridge(record, { kind, sessionId, question, requestId } = {}, signal) {
  const request = { operation: kind, sessionId, requestId, ...(kind === 'ask' ? { question } : {}) };
  if (!validateSideRequest(request)) return failure('invalid_request', 'Invalid side query destination, request ID or question');
  if (record?.capabilities?.sideQuery !== 1) return failure('host_outdated', 'This dsh-tui bridge predates ask/recap; reload that dsh-tui or use read', { retrySafe: true });
  const agent = Array.isArray(record?.agents) ? record.agents.find(agent => agent?.sessionId === sessionId) : undefined;
  if (!agent || !validId(agent.agentIdentity)) return failure('agent_not_live', 'Destination must come from a live discovery handshake', { retrySafe: true });
  try {
    signal?.throwIfAborted();
    const key = await readKey(record.root);
    request.grant = signSideGrant(sideGrantPayload(request, record, agent.agentIdentity), key);
    signal?.throwIfAborted();
  } catch (error) { return failure(signal?.aborted ? 'cancelled' : 'grant_unavailable', error.message, { retrySafe: true }); }
  return exchange(record, request, signal, { timeoutMs: SIDE_CLIENT_MS });
}
