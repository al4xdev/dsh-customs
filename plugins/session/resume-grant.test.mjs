import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareRoot } from './bridge-security.mjs';
import { hashValue, signPayload, atomicPrivate } from './provenance.mjs';
import { consumeResumeGrant } from './resume-worker.mjs';

test('worker grants are destination-bound, expiring and durably single-use', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-resume-replay-'));
  const prepared = await prepareRoot(root);
  await mkdir(path.join(root, 'resume-requests'), { mode: 0o700 });
  const requestPath = path.join(root, 'resume-requests', 'fixture.json');
  const payload = { version: 1, kind: 'session-resume-grant', operation: 'resume', requestId: 'fixture', plan: { root, sessionId: 'fixture', text: 'literal' }, nonce: 'a'.repeat(48), issuedAt: 100, expiresAt: 1000, workerHash: hashValue(await readFile(new URL('./resume-worker.mjs', import.meta.url), 'utf8')) };
  const signed = signPayload(payload, prepared.key);
  await atomicPrivate(requestPath, { ...signed, payload: { ...payload, plan: { ...payload.plan, text: 'altered' } } });
  await assert.rejects(consumeResumeGrant(root, requestPath, { now: 110 }), /signature/);
  await atomicPrivate(requestPath, signed);
  await assert.rejects(consumeResumeGrant(root, requestPath, { now: 99 }), /expired|malformed/);
  assert.deepEqual(await consumeResumeGrant(root, requestPath, { now: 110 }), payload);
  await assert.rejects(consumeResumeGrant(root, requestPath, { now: 111 }), error => error.code === 'EEXIST');
  assert.equal(JSON.parse(await readFile(`${requestPath}.consumed`, 'utf8')).nonce, payload.nonce);
});
