import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBroker } from './broker.mjs';
import { DEFAULT_CONFIG } from './config.mjs';

function deferred() { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; }
function fixture() {
  const broker = new BrowserBroker({});
  const agent = { session: { header: { cwd: process.cwd() } } };
  const record = broker.owner(agent);
  const settings = { config: DEFAULT_CONFIG, revision: 'fixture', root: null };
  broker.files.policy = () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() });
  const entered = deferred(), gate = deferred();
  let lateLookups = 0;
  broker.files.bootstrap = async () => { entered.resolve(); await gate.promise; };
  broker.files.fs = () => { lateLookups++; throw new Error('Disposed startup must not reach worker lookup'); };
  return { broker, agent, record, settings, entered, gate, lateLookups: () => lateLookups };
}

test('global close during bootstrap cannot install a late worker slot', async () => {
  const f = fixture();
  const start = f.broker.start(f.record, f.settings);
  f.record.queue = start.then(() => {}, () => {});
  await f.entered.promise;
  const closing = f.broker.close();
  f.gate.resolve();
  await assert.rejects(start);
  await closing;
  assert.equal(f.record.slot, null); assert.equal(f.lateLookups(), 0); assert.equal(f.broker.records.size, 0);
});

test('Agent disposal tombstones synchronously and prevents queued reopening', async () => {
  const f = fixture();
  const start = f.broker.start(f.record, f.settings);
  f.record.queue = start.then(() => {}, () => {});
  await f.entered.promise;
  const disposal = f.broker.disposeAgent(f.agent);
  assert.equal(f.record.disposed, true);
  assert.throws(() => f.broker.owner(f.agent), { code: 'WORKER_DISCONNECTED' });
  f.gate.resolve();
  await assert.rejects(start); await disposal;
  assert.equal(f.record.slot, null); assert.equal(f.lateLookups(), 0);
  await f.broker.close();
});

test('native policy revocation aborts startup before slot creation', async () => {
  const f = fixture();
  const start = f.broker.start(f.record, f.settings);
  await f.entered.promise;
  await f.broker.revokeSession(f.agent.session);
  f.gate.resolve(); await assert.rejects(start);
  assert.equal(f.record.slot, null); assert.equal(f.lateLookups(), 0);
  await f.broker.close();
});

test('SDK timeout without caller abort still joins the owned range before rejection', async () => {
  const f = fixture();
  f.broker.configuration = async () => f.settings;
  let joined = false;
  f.record.slot = {
    fingerprint: `${JSON.stringify(f.broker.files.policy())}:fixture`,
    connected: false, controller: new AbortController(),
    client: { async callTool() { throw Object.assign(new Error('Fixture timeout'), { code: 'REQUEST_TIMEOUT' }); }, async close() {} },
    transport: { closed: false, async close() { joined = true; } },
  };
  const signal = new AbortController().signal;
  await assert.rejects(f.broker.invoke({ operation: 'session.open', args: {} }, { agent: f.agent, callId: 'sdk-timeout', signal }), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(signal.aborted, false); assert.equal(joined, true); assert.equal(f.record.slot, null);
  await f.broker.close();
});

test('global capacity admission precedes bootstrap across Agents and unload releases suspended starts', async () => {
  const f = fixture(), entered = deferred();
  let bootstraps = 0;
  f.broker.files.bootstrap = async () => { if (++bootstraps === 4) entered.resolve(); await f.gate.promise; };
  const pending = [];
  for (let index = 0; index < 4; index++) {
    const agent = { session: { header: { cwd: process.cwd() } } };
    const record = f.broker.owner(agent);
    const start = f.broker.start(record, f.settings);
    record.queue = start.then(() => {}, () => {});
    pending.push(start);
  }
  await entered.promise;
  const rejected = f.broker.owner({ session: { header: { cwd: process.cwd() } } });
  await assert.rejects(f.broker.start(rejected, f.settings), { code: 'LIMIT_EXCEEDED' });
  assert.equal(bootstraps, 4);
  assert.equal(f.broker.capacity.snapshot().reserved.workers, 4);
  const close = f.broker.close(); f.gate.resolve();
  await Promise.all(pending.map(start => assert.rejects(start))); await close;
  assert.equal(f.lateLookups(), 0);
  assert.deepEqual(f.broker.capacity.snapshot().reserved, { workers: 0, contexts: 0, ownerBytes: 0 });
});

test('lifecycle history is bounded without evicting a live owned session', () => {
  const f = fixture();
  f.broker.rememberSession(f.record, { sessionId: 'bs_live', generation: 1, state: 'ready' });
  for (let index = 0; index < 100; index++) f.broker.rememberSession(f.record, { sessionId: `bs_closed_${index}`, generation: 1, state: 'closed' });
  assert.equal(f.record.sessions.size, 16); assert.equal(f.record.sessions.has('bs_live'), true);
  assert.equal(f.record.sessions.has('bs_closed_0'), false); assert.equal(f.record.sessions.has('bs_closed_99'), true);
});

test('capture history evicts old recording caches from dead generations, never current recordings', () => {
  const f = fixture();
  f.broker.rememberSession(f.record, { sessionId: 'bs_live', generation: 2, state: 'ready' });
  f.broker.rememberCapture(f.record, { sessionId: 'bs_live', data: { captureId: 'bc_live', generation: 2, state: 'recording' } });
  for (let index = 0; index < 1010; index++) f.broker.rememberCapture(f.record, { sessionId: 'bs_live', data: { captureId: `bc_stale_${index}`, generation: 1, state: 'recording' } });
  assert.equal(f.record.captures.size, 1000); assert.equal(f.record.captures.has('bc_live'), true);
  assert.equal(f.record.captures.has('bc_stale_0'), false); assert.equal(f.record.captures.has('bc_stale_1009'), true);
});

test('private finalization RPC preserves the absolute caller deadline and never sends expired work', async () => {
  const f = fixture(); f.record.config = DEFAULT_CONFIG;
  const deadlineMs = Date.now() + 1000;
  const seen = [];
  const slot = { client: { async callTool(input, options) { seen.push({ input, options }); return { structuredContent: { artifacts: [] } }; } } };
  const request = { operation: '__delivered', args: { artifactIds: [] } };
  await f.broker.rpc(f.record, request, { deadlineMs, callId: 'absolute-budget' }, slot);
  assert.equal(seen[0].input.arguments.authority.deadlineMs, deadlineMs);
  assert.ok(seen[0].options.timeout <= 2000);
  await assert.rejects(f.broker.rpc(f.record, request, { deadlineMs: Date.now() - 1, callId: 'expired-budget' }, slot), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(seen.length, 1);
});
