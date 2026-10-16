import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validId } from './contracts.mjs';

export const DEFAULT_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'session-companion');
export async function mountHints({ path = join(homedir(), '.dsh-tui/session-mounts.json'), signal, pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  signal?.throwIfAborted();
  let handle;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > 262144) return { hints: [], warning: 'mount ledger invalid or oversized' };
    const buffer = Buffer.alloc(262145);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 262144) return { hints: [], warning: 'mount ledger oversized' };
    signal?.throwIfAborted();
    const ledger = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (ledger.version !== 1 || !Array.isArray(ledger.owners)) return { hints: [], warning: 'mount ledger unsupported' };
    const hints = [];
    for (const owner of ledger.owners.slice(0, 512)) {
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Array.isArray(owner.sessionIds)) continue;
      const alive = pidAlive(owner.pid);
      for (const sessionId of owner.sessionIds.slice(0, 128)) if (validId(sessionId)) hints.push({ sessionId, pid: owner.pid, pidAlive: alive, source: 'tui-mount-ledger', authoritative: false });
    }
    return { hints };
  } catch (error) {
    signal?.throwIfAborted();
    return { hints: [], ...(error.code === 'ENOENT' ? {} : { warning: 'mount ledger unavailable or malformed' }) };
  } finally { await handle?.close(); }
}

export async function discoverTargets(ctx, bridge, { root = DEFAULT_ROOT, signal, ledgerPath } = {}) {
  signal?.throwIfAborted();
  const targets = new Map();
  for (const agent of ctx.agents.list()) {
    if (!validId(agent.id) || agent.status === 'disposed' || ctx.agents.get(agent.id) !== agent) continue;
    targets.set(agent.id, { sessionId: agent.id, source: 'local-agent', state: 'alive', agent, status: agent.status, evidence: ['exact live process-local registry entry'], header: agent.session.header });
  }
  const warnings = [];
  let discovered;
  try { discovered = await bridge.discoverBridges({ root, signal }); }
  catch { signal?.throwIfAborted(); warnings.push('bridge discovery unavailable'); }
  for (const record of discovered?.bridges ?? []) {
    try {
      // Registry records alone are hints; handshake status is the live proof.
      const result = await bridge.queryBridge(record, { operation: 'list' }, signal);
      if (!result.ok) { warnings.push('bridge handshake unavailable'); continue; }
      for (const remote of result.agents ?? []) {
        if (!validId(remote.sessionId) || targets.has(remote.sessionId)) continue;
        targets.set(remote.sessionId, { sessionId: remote.sessionId, source: 'bridge', state: 'alive', record, remote, status: remote.status, evidence: ['validated bridge handshake and live agent lookup'], header: { id: remote.sessionId, cwd: remote.cwd }, identity: remote.agentIdentity });
      }
    } catch { signal?.throwIfAborted(); warnings.push('bridge handshake unavailable'); }
  }
  const ledger = await mountHints({ path: ledgerPath, signal });
  for (const hint of ledger.hints) {
    if (!targets.has(hint.sessionId)) targets.set(hint.sessionId, { sessionId: hint.sessionId, source: 'tui-mount-ledger', state: 'unknown', hint, evidence: [hint.pidAlive ? 'ledger PID exists; session identity and control unverified' : 'ledger PID no longer exists; historical session lifecycle unknown'] });
  }
  if (ledger.warning) warnings.push(ledger.warning);
  if (discovered?.errors?.length) warnings.push('some bridge records could not be validated');
  return { targets, warnings: [...new Set(warnings)] };
}
