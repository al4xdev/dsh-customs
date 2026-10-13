import path from 'node:path';
import * as fs from 'node:fs/promises';
import { DEFAULT_ROOT, validId, MAX_TEXT } from './bridge-security.mjs';
import { readProvenance, profileFingerprint, persistedSnapshot, foldExecution, hashValue } from './provenance.mjs';
import { createHash } from 'node:crypto';

export async function assertCurrentModules(checkpoint) {
  for (const row of checkpoint.rootComposition.rows) {
    if (await fs.realpath(row.modulePath) !== row.modulePath || createHash('sha256').update(await fs.readFile(row.modulePath)).digest('hex') !== row.moduleHash) throw new Error('Current root plugin module changed since the bridge checkpoint');
  }
}

export function assertSnapshot(checkpoint, snapshot, { allowResumeSeed = false } = {}) {
  const suffix = snapshot.events.slice(checkpoint.log.eventCount);
  const coreSeed = allowResumeSeed && suffix.length === 1 && suffix[0].type === 'session/end-seed' && Object.keys(suffix[0].data ?? {}).length === 0;
  const unchanged = snapshot.eventCount === checkpoint.log.eventCount && snapshot.eventHash === checkpoint.log.eventHash && snapshot.revision === checkpoint.log.revision;
  const seeded = coreSeed && hashValue(snapshot.events.slice(0, checkpoint.log.eventCount)) === checkpoint.log.eventHash;
  if (snapshot.header.id !== checkpoint.sessionId || snapshot.header.cwd !== checkpoint.cwd || snapshot.headerHash !== checkpoint.log.headerHash || !(unchanged || seeded)) throw new Error('Session log changed since the bridge checkpoint');
  const fold = foldExecution(snapshot.header, snapshot.events);
  if (fold.openTurn || fold.preset !== checkpoint.execution.preset || hashValue(fold.model) !== hashValue(checkpoint.execution.model)) throw new Error('Durable execution context changed');
  if (fold.sandbox !== undefined && fold.sandbox !== checkpoint.execution.policies.sandbox || fold.approval !== undefined && fold.approval !== checkpoint.execution.policies.approval) throw new Error('Durable policy changed');
}
export async function preflightResume(ctx, { sessionId, text, root = DEFAULT_ROOT, signal } = {}) {
  try {
    signal?.throwIfAborted();
    if (!validId(sessionId) || typeof text !== 'string' || !text.length || Buffer.byteLength(text) > MAX_TEXT) throw new Error('Invalid resume destination or literal message');
    if (ctx.agents?.get(sessionId)) throw new Error('Destination is live: use send, not resume');
    const checkpoint = await readProvenance(root, sessionId);
    if (await fs.realpath(checkpoint.cwd) !== checkpoint.cwd || !(await fs.stat(checkpoint.cwd)).isDirectory()) throw new Error('Original cwd changed or disappeared');
    const current = await profileFingerprint(checkpoint.origin);
    if (current.fingerprint !== checkpoint.configFingerprint) throw new Error('Current profile differs from the latest bridge checkpoint; a new live checkpoint is required');
    await assertCurrentModules(checkpoint);
    const snapshot = await persistedSnapshot(ctx, sessionId, signal);
    assertSnapshot(checkpoint, snapshot);
    // No secret, prompt or transcript is part of this display descriptor.
    const descriptor = { sessionId, cwd: checkpoint.cwd, profile: { name: checkpoint.origin.name, dir: checkpoint.origin.dir }, preset: checkpoint.execution.preset, model: checkpoint.execution.model, policies: checkpoint.execution.policies, currentConfiguration: true, immutableOriginal: false, capturedAt: checkpoint.capturedAt };
    const plan = { version: 1, sessionId, text, root: path.resolve(root), checkpoint, fingerprint: hashValue({ checkpoint, current: current.fingerprint, text }) };
    return { ok: true, descriptor, plan, fingerprint: plan.fingerprint, exactLiteral: text, reason: 'Retomar a configuração ATUAL do profile de origem comprovado. Isto NÃO restaura a composição immutable original. Nenhum goal será rearmado. A API pode registrar fechamento de turno interrompido sob lock; ACK significa admissão, não conclusão.' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, code: 'resume_unavailable', effect: 'none', reason: error.message };
  }
}
