import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readKey, validId, GRANT_TTL } from './bridge-security.mjs';
import { signPayload, privateDirectory, atomicPrivate, profileFingerprint, hashValue } from './provenance.mjs';
import { assertCurrentModules } from './resume-preflight.mjs';

const workers = new Map(), completedWorkers = new Map();
export async function waitForResumeWorkers() {
  const completed = [...completedWorkers.values()];
  completedWorkers.clear();
  const active = await Promise.all([...workers.values()].map(worker => worker.done));
  for (const result of active) completedWorkers.delete(result.requestId);
  return [...completed, ...active];
}
export function resumeWorkerStatuses() { return [...workers.values()].map(worker => ({ requestId: worker.requestId, pid: worker.child.pid, admitted: worker.admitted })); }
export async function executeResume(prepared, { requestId, signal } = {}) {
  let launched = false;
  try {
    signal?.throwIfAborted();
    if (!prepared?.ok || !validId(requestId) || prepared.exactLiteral !== prepared.plan?.text || prepared.fingerprint !== prepared.plan?.fingerprint) throw new Error('Invalid approved resume preparation');
    const plan = prepared.plan;
    if (hashValue({ checkpoint: plan.checkpoint, current: plan.checkpoint.configFingerprint, text: plan.text }) !== plan.fingerprint) throw new Error('Prepared payload was altered');
    const current = await profileFingerprint(plan.checkpoint.origin);
    if (current.fingerprint !== plan.checkpoint.configFingerprint) throw new Error('Profile changed after confirmation');
    await assertCurrentModules(plan.checkpoint);
    const key = await readKey(plan.root);
    const requests = await privateDirectory(plan.root, 'resume-requests');
    const ledger = await privateDirectory(plan.root, 'resume-ledger');
    // This permanent, exclusive receipt is keyed by the CHECKPOINT rather than
    // the message: a retry after ambiguous launch cannot start another worker.
    const receipt = path.join(ledger, `${hashValue([plan.sessionId, plan.checkpoint.capturedAt, plan.checkpoint.log])}.json`);
    const exclusive = await fs.open(receipt, 'wx', 0o600);
    await exclusive.writeFile(JSON.stringify({ requestId, sessionId: plan.sessionId, state: 'reserved', at: Date.now() })); await exclusive.sync(); await exclusive.close();
    const requestPath = path.join(requests, `${requestId}.json`), overlayPath = path.join(requests, `${requestId}.patch.json`);
    const workerPath = fileURLToPath(new URL('./resume-worker.mjs', import.meta.url));
    const overlay = [...plan.checkpoint.rootComposition.excluded.map(row => ({ id: row.id, disabled: true })), { insert: [{ id: 'session-resume-worker', name: new URL('./resume-worker.mjs', import.meta.url).href, config: { root: plan.root, requestPath } }] }];
    const issuedAt = Date.now();
    const grant = { version: 1, kind: 'session-resume-grant', operation: 'resume', requestId, nonce: randomBytes(24).toString('hex'), issuedAt, expiresAt: issuedAt + GRANT_TTL, plan, overlayHash: hashValue(overlay), workerHash: hashValue(await fs.readFile(workerPath, 'utf8')) };
    await atomicPrivate(requestPath, signPayload(grant, key));
    await atomicPrivate(overlayPath, overlay);
    const manifest = JSON.parse(await fs.readFile(plan.checkpoint.origin.installAnchor, 'utf8'));
    if (typeof manifest.bin?.dsh !== 'string') throw new Error('Original CLI executable unavailable');
    const cli = path.resolve(path.dirname(plan.checkpoint.origin.installAnchor), manifest.bin.dsh);
    signal?.throwIfAborted();
    await atomicPrivate(receipt, { requestId, sessionId: plan.sessionId, state: 'launching', at: Date.now() });
    // Arguments contain paths only. Credentials remain resolved by the original
    // profile's providers; no credential file or launch environment is copied.
    const child = spawn(process.execPath, [cli, '--profile', plan.checkpoint.origin.name, '--patch', overlayPath], { cwd: plan.checkpoint.cwd, env: { ...process.env, DSH_HOME: plan.checkpoint.origin.home, ...(plan.checkpoint.origin.telemetryDisabledEnv ? { DSH_TELEMETRY_DISABLED: '1' } : { DSH_TELEMETRY_DISABLED: '' }) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    launched = true;
    const tracked = { child, requestId, admitted: false };
    tracked.done = new Promise(resolve => {
      const complete = (code, exitSignal) => {
        const result = { requestId, code, signal: exitSignal, admitted: tracked.admitted };
        workers.delete(requestId);
        completedWorkers.set(requestId, result);
        if (completedWorkers.size > 128) completedWorkers.delete(completedWorkers.keys().next().value);
        resolve(result);
      };
      child.once('exit', complete);
      child.once('error', () => complete(null, 'spawn-error'));
    });
    workers.set(requestId, tracked);
    const result = await new Promise(resolve => {
      let settled = false;
      const abort = () => finish({ ok: false, requestId, error: { code: 'resume_unknown', message: 'Caller cancelled after launch' }, effect: 'unknown', retrySafe: false });
      const timer = setTimeout(() => finish({ ok: false, requestId, error: { code: 'resume_unknown', message: 'No admission ACK within 30 seconds; worker may still own approved work' }, effect: 'unknown', retrySafe: false }), 30_000);
      const finish = value => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(value); } };
      child.on('message', message => {
        if (message?.requestId !== requestId || message?.sessionId !== plan.sessionId) return;
        if (message.ok && message.ack?.requestId === requestId && message.ack.sessionId === plan.sessionId && message.ack.accepted === true && message.ack.boundary === 'next-turn') {
          tracked.admitted = true;
          atomicPrivate(receipt, { requestId, sessionId: plan.sessionId, state: 'admitted', at: Date.now() }).then(() => finish({ ok: true, requestId, ack: message.ack, effect: 'admitted', completed: false })).catch(() => finish({ ok: false, requestId, error: { code: 'resume_unknown', message: 'Admission ACK received but durable receipt update failed' }, effect: 'unknown', retrySafe: false }));
        } else if (message.ok === false) finish({ ok: false, requestId, error: message.error, effect: message.effect === 'none' ? 'none' : 'unknown', retrySafe: false });
      });
      child.once('error', () => finish({ ok: false, requestId, error: { code: 'resume_unknown', message: 'Worker launch failed after reservation' }, effect: 'unknown', retrySafe: false }));
      child.once('exit', () => finish({ ok: false, requestId, error: { code: 'resume_unknown', message: 'Worker exited without an admission ACK; no automatic retry' }, effect: 'unknown', retrySafe: false }));
      // Once launched, cancellation is uncertainty, not permission to interrupt
      // the owner-approved work or manufacture a non-delivery result.
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    return result;
  } catch (error) {
    return { ok: false, requestId, error: { code: error.code === 'EEXIST' ? 'resume_deduplicated' : 'resume_unavailable', message: error.message }, effect: launched ? 'unknown' : 'none', retrySafe: false };
  }
}
