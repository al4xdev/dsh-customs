import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startBridge, apply } from './bridge.mjs';
import { discoverBridges, queryBridge, sendBridge } from './bridge-client.mjs';
import { exchange } from './bridge-transport.mjs';
import { grantPayload, signGrant, readKey, MAX_TEXT } from './bridge-security.mjs';

async function fixture(t, { send } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-br-'));
  const calls = [];
  const agent = { id: 'session-1', status: 'idle', session: { header: { cwd: '/synthetic', title: 'Synthetic' } }, send: send ?? ((...args) => calls.push(args)) };
  const registry = new Map([[agent.id, agent]]);
  const ctx = { agents: { list: () => [...registry.values()], get: id => registry.get(id) } };
  const bridge = await startBridge(ctx, { root });
  t.after(async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); });
  const found = await discoverBridges({ root });
  assert.equal(found.ok, true); assert.equal(found.bridges.length, 1);
  return { root, bridge, record: found.bridges[0], calls, agent, registry, ctx };
}
async function signed(record, request, overrides = {}) {
  const payload = { ...grantPayload(request, record, record.agents[0].agentIdentity), ...overrides };
  return { ...request, operation: 'send', grant: signGrant(payload, await readKey(record.root)) };
}

test('private atomic discovery and exact public registry list/inspect; no tool registration', async t => {
  const { root, bridge, record, ctx } = await fixture(t);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(root, 'grant.key'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(record.socketPath)).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(ctx), ['agents']);
  assert.equal(record.pid, process.pid); assert.match(record.startTime, /^\d+$/);
  const inspect = await queryBridge(record, { operation: 'inspect', sessionId: 'session-1' });
  assert.equal(inspect.ok, true); assert.equal(inspect.agent.agentIdentity, record.agents[0].agentIdentity);
  assert.equal(inspect.agent.state, 'live-confirmed'); assert.equal(inspect.capabilities.resume, false);
  assert.equal((await queryBridge(record, { operation: 'inspect', sessionId: 'gone' })).error.code, 'agent_not_live');
  await bridge.close();
  assert.equal((await discoverBridges({ root })).bridges.length, 0);
});

test('send literal content goes to next-turn, wakes through Agent API, never UI', async t => {
  const { record, calls } = await fixture(t);
  const result = await sendBridge(record, { sessionId: 'session-1', text: 'literal\n  content ✅', requestId: 'request-1' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.ack, { requestId: 'request-1', sessionId: 'session-1', accepted: true, boundary: 'next-turn' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'next-turn'); assert.equal(calls[0][2], true);
  assert.equal(calls[0][0].role, 'user'); assert.deepEqual(calls[0][0].content, [{ type: 'text', text: 'literal\n  content ✅' }]);
  assert.deepEqual(calls[0][0].source, { kind: 'user' });
});

test('concurrent request IDs serialize and deduplicate; payload conflicts never enqueue', async t => {
  const { record, calls } = await fixture(t);
  const args = { sessionId: 'session-1', text: 'one', requestId: 'same-id' };
  const results = await Promise.all(Array.from({ length: 12 }, () => sendBridge(record, args)));
  assert.ok(results.every(result => result.ok)); assert.equal(calls.length, 1);
  assert.equal(results.filter(result => result.deduplicated).length, 11);
  const conflict = await sendBridge(record, { ...args, text: 'two' });
  assert.equal(conflict.error.code, 'request_conflict'); assert.equal(calls.length, 1);
});

test('no unsigned, altered, expired, future or other-destination mutation', async t => {
  const { record, calls } = await fixture(t);
  const args = { sessionId: 'session-1', text: 'approved literal', requestId: 'grant-test' };
  const unsigned = await exchange(record, { operation: 'send', ...args });
  assert.equal(unsigned.error.code, 'grant_invalid');
  const valid = await signed(record, args);
  for (const request of [
    { ...valid, text: 'changed' }, { ...valid, sessionId: 'other' }, { ...valid, requestId: 'other-request' },
    { ...valid, grant: { ...valid.grant, nonce: 'a'.repeat(48) } },
    { ...valid, grant: { ...valid.grant, agentIdentity: 'other-agent' } },
    await signed(record, args, { issuedAt: Date.now() - 30_000, expiresAt: Date.now() - 15_000 }),
    await signed(record, args, { issuedAt: Date.now() + 10_000, expiresAt: Date.now() + 20_000 }),
    await signed(record, args, { expiresAt: Date.now() + 60_000 }),
  ]) assert.equal((await exchange(record, request)).error.code, 'grant_invalid');
  assert.equal(calls.length, 0);
  assert.equal((await exchange(record, valid)).ok, true);
  assert.equal((await exchange(record, valid)).deduplicated, true);
  const replay = await signed(record, { ...args, requestId: 'nonce-reuse' }, { nonce: valid.grant.nonce });
  assert.equal((await exchange(record, replay)).error.code, 'grant_replayed');
  assert.equal(calls.length, 1);
});

test('replacing registry object with same session ID invalidates approval identity', async t => {
  const { record, registry, calls, agent, root } = await fixture(t);
  registry.set(agent.id, { ...agent });
  const result = await sendBridge(record, { sessionId: agent.id, text: 'old approval', requestId: 'replacement' });
  assert.equal(result.error.code, 'agent_not_live'); assert.equal(calls.length, 0);
  const fresh = (await discoverBridges({ root })).bridges[0];
  assert.notEqual(fresh.agents[0].agentIdentity, record.agents[0].agentIdentity);
  registry.delete(agent.id);
  assert.equal((await sendBridge(fresh, { sessionId: agent.id, text: 'gone', requestId: 'gone-request' })).error.code, 'agent_not_live');
  assert.equal(calls.length, 0);
});

test('unknown admission is retained and never re-enqueued', async t => {
  let attempts = 0;
  const { record } = await fixture(t, { send: () => { attempts++; throw new Error('after possible admission'); } });
  const args = { sessionId: 'session-1', text: 'ambiguous', requestId: 'unknown' };
  const result = await sendBridge(record, args);
  assert.equal(result.error.code, 'delivery_unknown'); assert.equal(result.retrySafe, false);
  const again = await sendBridge(record, args);
  assert.equal(again.error.code, 'delivery_unknown'); assert.equal(again.deduplicated, true); assert.equal(attempts, 1);
});

test('cancelled discovery/query/send and validation have zero effects', async t => {
  const { root, record, calls } = await fixture(t);
  const signal = AbortSignal.abort();
  assert.equal((await discoverBridges({ root, signal })).error.code, 'cancelled');
  assert.equal((await queryBridge(record, { operation: 'list' }, signal)).error.code, 'cancelled');
  assert.equal((await sendBridge(record, { sessionId: 'session-1', text: 'no', requestId: 'cancel' }, signal)).error.code, 'cancelled');
  for (const args of [ { sessionId: '../escape', text: 'x', requestId: 'r' }, { sessionId: 'session-1', text: 'x', requestId: '../r' }, { sessionId: 'session-1', text: 'x'.repeat(MAX_TEXT + 1), requestId: 'r' } ]) assert.equal((await sendBridge(record, args)).error.code, 'invalid_request');
  assert.equal((await queryBridge(record, { operation: 'resume', sessionId: 'session-1' })).error.code, 'invalid_request');
  assert.equal((await exchange(record, { operation: 'kill' })).error.code, 'operation_unavailable');
  assert.equal((await exchange(record, { operation: 'list', command: 'shell' })).error.code, 'invalid_request');
  assert.equal(calls.length, 0);
});

test('stale/corrupt discovery, PID reuse and path escape do not classify as alive', async t => {
  const { root, record } = await fixture(t);
  const dir = path.join(root, 'bridges');
  await fs.writeFile(path.join(dir, 'corrupt.json'), '{', { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'stale.json'), JSON.stringify({ ...record, bridgeId: 'stale', startTime: '0', socketPath: path.join(dir, 'stale.sock') }), { mode: 0o600 });
  const result = await discoverBridges({ root });
  assert.equal(result.bridges.length, 1); assert.equal(result.errors.length, 2);
  assert.equal((await queryBridge({ ...record, startTime: '0' }, { operation: 'list' })).error.code, 'bridge_unavailable');
  assert.equal((await queryBridge({ ...record, socketPath: '/tmp/other.sock' }, { operation: 'list' })).error.code, 'bridge_unavailable');
});

test('unsafe root/socket/key modes fail closed', async t => {
  const { root, record, calls } = await fixture(t);
  await fs.chmod(path.join(root, 'grant.key'), 0o644);
  assert.equal((await sendBridge(record, { sessionId: 'session-1', text: 'no', requestId: 'unsafe-key' })).error.code, 'grant_unavailable');
  await fs.chmod(record.socketPath, 0o666);
  assert.equal((await queryBridge(record, { operation: 'list' })).error.code, 'bridge_unavailable');
  await fs.chmod(root, 0o755);
  assert.equal((await discoverBridges({ root })).error.code, 'discovery_unavailable');
  assert.equal(calls.length, 0);
});

test('apply registers lifecycle disposal only, no tools', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-br-'));
  const ctx = { agents: { list: () => [], get: () => undefined } };
  const dispose = await apply(ctx, { root });
  t.after(async () => { await dispose(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal(typeof dispose, 'function'); await dispose();
  assert.deepEqual((await discoverBridges({ root })).bridges, []);
});

test('bounded registry output and malformed client records fail structurally', async t => {
  const { record, registry, agent, calls } = await fixture(t);
  assert.equal((await sendBridge({ ...record, agents: {} }, { sessionId: 'session-1', text: 'no', requestId: 'malformed' })).error.code, 'agent_not_live');
  for (let index = 0; index < 128; index++) registry.set(`session-${index + 2}`, { ...agent, id: `session-${index + 2}` });
  assert.equal((await queryBridge(record, { operation: 'list' })).error.code, 'output_limit');
  assert.equal(calls.length, 0);
});

test('concurrent hosts share one fully published private key and separate identities', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-br-'));
  const ctx = { agents: { list: () => [], get: () => undefined } };
  const hosts = await Promise.all(Array.from({ length: 6 }, () => startBridge(ctx, { root })));
  t.after(async () => { await Promise.all(hosts.map(host => host.close())); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal((await readKey(root)).length, 32);
  const result = await discoverBridges({ root });
  assert.equal(result.bridges.length, 6); assert.equal(result.errors.length, 0);
  assert.equal(new Set(result.bridges.map(record => record.bridgeId)).size, 6);
});

test('connection closes after possible send: delivery_unknown, never automatic retry', async t => {
  const { record, bridge } = await fixture(t);
  await bridge.close();
  let connections = 0;
  const server = net.createServer(socket => { connections++; socket.once('data', () => socket.destroy()); });
  await new Promise(resolve => { server.listen(record.socketPath, resolve); });
  await fs.chmod(record.socketPath, 0o600);
  t.after(() => new Promise(resolve => { server.close(resolve); }));
  const result = await sendBridge(record, { sessionId: 'session-1', text: 'ambiguous network', requestId: 'lost-ack' });
  assert.equal(result.error.code, 'delivery_unknown'); assert.equal(result.retrySafe, false); assert.equal(connections, 1);
});
