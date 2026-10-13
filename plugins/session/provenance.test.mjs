import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hashValue, signPayload, verifyPayload, foldExecution, captureProvenance, readProvenance, atomicPrivate, executionProof } from './provenance.mjs';
import { prepareRoot } from './bridge-security.mjs';
import { assertSnapshot, preflightResume } from './resume-preflight.mjs';
import { consumeResumeGrant } from './resume-worker.mjs';

test('canonical HMAC rejects altered destination, text, policy and checkpoint', () => {
  const key = Buffer.alloc(32, 7), payload = { sessionId: 'fixture', text: 'literal', execution: { approval: 'ask' } };
  const signed = signPayload(payload, key);
  assert.equal(verifyPayload(signed, key), true);
  for (const changed of [{ ...payload, text: 'changed' }, { ...payload, sessionId: 'other' }, { ...payload, execution: { approval: 'never' } }]) assert.equal(verifyPayload({ ...signed, payload: changed }, key), false);
  assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }));
});
test('durable last preset/model/policy wins without synthesizing a profile', () => {
  const events = [{ type: 'request/header', data: { header: { config: { provider: 'p', model: 'old', reasoningEffort: 'low' } } } }, { type: 'model/selection', data: { provider: 'p', model: 'new', reasoningEffort: 'high' } }, { type: 'agent-preset/selected', data: { agentPreset: 'selected' } }, { type: 'approval/policy', data: { policy: 'never' } }, { type: 'sandbox/mode', data: { mode: 'read-only' } }];
  assert.deepEqual(foldExecution({ agentPreset: 'initial' }, events), { preset: 'selected', model: { provider: 'p', model: 'new', reasoningEffort: 'high' }, sandbox: 'read-only', approval: 'never', openTurn: false });
  assert.equal(foldExecution({}, []).model, undefined);
});
test('missing metadata cannot mint provenance or acquire any writer', async () => {
  const agent = { id: 'old-session', status: 'idle' };
  const ctx = { agents: { get: () => agent, list: () => [agent] } };
  assert.equal((await captureProvenance(ctx, agent)).ok, false);
  let opens = 0;
  const result = await preflightResume({ ...ctx, agents: { get: () => undefined }, sessionPersistence: { open: () => { opens++; } } }, { sessionId: '../wrong', text: 'resume' });
  assert.equal(result.ok, false); assert.equal(opens, 0);
});
test('private provenance rejects changed HMAC and IDs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-provenance-'));
  const prepared = await prepareRoot(root);
  await mkdir(path.join(root, 'provenance'), { mode: 0o700 });
  const payload = { version: 1, kind: 'session-provenance', sessionId: 'fixture' };
  const file = path.join(root, 'provenance', 'fixture.json');
  await atomicPrivate(file, signPayload(payload, prepared.key));
  assert.deepEqual(await readProvenance(root, 'fixture'), payload);
  await atomicPrivate(file, { ...signPayload(payload, prepared.key), payload: { ...payload, sessionId: 'changed' } });
  await assert.rejects(readProvenance(root, 'fixture'), /signature|destination/);
  await assert.rejects(readProvenance(root, '../escape'), /Invalid/);
});
test('snapshot gate rejects any prefix or cwd drift', () => {
  const model = { provider: 'p', model: 'm' }, events = [{ type: 'request/header', data: { header: { config: model } } }];
  const snapshot = { header: { id: 'fixture', cwd: '/fixture' }, revision: 'r1', eventHash: hashValue(events), headerHash: 'h1', eventCount: 1, events };
  const checkpoint = { sessionId: 'fixture', cwd: '/fixture', log: { revision: 'r1', eventCount: 1, eventHash: snapshot.eventHash, headerHash: 'h1' }, execution: { preset: null, model, policies: { approval: 'ask', sandbox: 'read-only' } } };
  assert.doesNotThrow(() => assertSnapshot(checkpoint, snapshot));
  for (const changed of [{ ...snapshot, revision: 'r2' }, { ...snapshot, eventHash: 'changed' }, { ...snapshot, header: { ...snapshot.header, cwd: '/other' } }]) assert.throws(() => assertSnapshot(checkpoint, changed), /changed/);
});
test('pending inbox, background jobs and absent goal proof fail before any catalog admission', async () => {
  const snapshot = { header: {}, events: [{ type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'fixture' } } } }] };
  const agent = { id: 'fixture', session: {}, ctx: { get: () => undefined } };
  const queued = { sessionProjections: { stateOf: () => ({ 'next-turn': [{ id: 'queued' }], 'next-step': [] }) } };
  await assert.rejects(executionProof(queued, agent, snapshot), /Pending inbox/);
  const pendingJobs = { sessionProjections: { stateOf: () => ({ 'next-turn': [], 'next-step': [] }) }, get: key => key === 'jobs' ? { list: () => [{ status: 'running' }] } : undefined };
  await assert.rejects(executionProof(pendingJobs, agent, snapshot), /Pending background/);
  const noGoal = { sessionProjections: { stateOf: (_session, key) => key === 'inbox' ? { 'next-turn': [], 'next-step': [] } : undefined }, get: key => key === 'jobs' ? { list: () => [] } : undefined };
  await assert.rejects(executionProof(noGoal, agent, snapshot), /goal state unavailable/);
});
test('expired or malformed resume grant never consumes a nonce', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-resume-grant-'));
  const prepared = await prepareRoot(root);
  await mkdir(path.join(root, 'resume-requests'), { mode: 0o700 });
  const requestPath = path.join(root, 'resume-requests', 'fixture.json');
  await writeFile(requestPath, JSON.stringify(signPayload({ version: 1, kind: 'session-resume-grant', operation: 'resume', requestId: 'fixture', plan: { root, sessionId: 'fixture' }, nonce: 'a'.repeat(48), issuedAt: 10, expiresAt: 20 }, prepared.key)), { mode: 0o600 });
  await assert.rejects(consumeResumeGrant(root, requestPath, { now: 21 }), /expired/);
});
