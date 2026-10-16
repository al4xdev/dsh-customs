import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHost } from '../common.mjs';
import { createDeletion } from './deletion.mjs';
import { apply } from './index.mjs';
const [{ Context }, { default: Backend }, sessions, { default: Registry }, { default: Gateway }] = await Promise.all([
  import(resolveHost('@deepseek-ai/cordis')), import(resolveHost('@deepseek-ai/dsh-session-persistence-jsonl')), import(resolveHost('@deepseek-ai/dsh-session')),
  import(resolveHost('@deepseek-ai/dsh-typert-registry')), import(resolveHost('@deepseek-ai/dsh-api-gateway')),
]);
const marker = '/synthetic-private-marker/never-disclose';
const command = { id: 'error-fixture', createdAt: 1, confirmation: 'delete-companion-chat' };
const refusal = code => error => {
  assert.equal(error.code, `companion/${code}`);
  assert.ok(!error.message.includes(marker));
  assert.deepEqual(error.details, {});
  return true;
};
async function native(t) {
  await mkdir('.dumps/session-tests', { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), '.dumps/session-tests/delete-errors-'));
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Backend, { root: join(directory, 'sessions'), compression: 'none' });
  const p = ctx.sessionPersistence;
  const handle = await p.create({ version: sessions.SESSION_FORMAT_VERSION, id: sessions.SessionId(command.id), cwd: directory, agentPreset: 'companion', createdAt: 1, isSeeded: false });
  await handle.flush(); await handle.close();
  const source = { name: p.name, config: p.config, stat: p.stat.bind(p), resolveCurrentLog: p.resolveCurrentLog.bind(p),
    hasPendingSession: p.hasPendingSession.bind(p), acquireWriteLease: p.acquireWriteLease.bind(p) };
  return { ctx, p, source, trashRoot: join(directory, 'trash') };
}

test('native metadata/path failures become a sanitized pre-mutation refusal', async () => {
  const source = { name: 'session-persistence-jsonl', config: { root: marker }, resolveCurrentLog() {}, acquireWriteLease() {},
    async stat() { throw new Error(`EACCES: ${marker}`); } };
  await assert.rejects(createDeletion(source)(command), refusal('delete-unavailable'));
});

test('non-contention lease failures never claim that a writer is active', async t => {
  const f = await native(t);
  f.source.acquireWriteLease = async () => { throw new Error(`EACCES: ${marker}`); };
  await assert.rejects(createDeletion(f.source, { trashRoot: f.trashRoot })(command), refusal('delete-unavailable'));
  assert.ok(await f.p.stat(sessions.SessionId(command.id)));
});

test('release failure after a real native archive stays uncertain and exposes no paths', async t => {
  const f = await native(t);
  f.source.acquireWriteLease = async header => {
    const lease = await f.p.acquireWriteLease(header);
    return { release: async () => { await lease.release(); throw new Error(`close failure: ${marker}`); } };
  };
  await assert.rejects(createDeletion(f.source, { trashRoot: f.trashRoot })(command), refusal('delete-unconfirmed'));
  assert.equal(await f.p.stat(sessions.SessionId(command.id)), undefined);
});

test('the real Gateway deletion error face never serializes private filesystem messages', async t => {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Registry); await ctx.plugin(Gateway);
  ctx.provide('profileContext', { name: 'companion', dir: '/synthetic-companion' });
  ctx.provide('sessionPersistence', { name: 'session-persistence-jsonl', config: { root: marker },
    async stat() { throw new Error(`corrupt header: ${marker}`); }, resolveCurrentLog() {}, acquireWriteLease() {} });
  await ctx.plugin(sessions.default);
  await apply(ctx);
  await assert.rejects(ctx.typertGateway.invoke({ namespace: 'companion', method: 'deleteChat', args: { request: command }, signal: new AbortController().signal }), refusal('delete-unavailable'));
});
