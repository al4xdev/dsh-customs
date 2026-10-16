import test from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { createHostController } from './controller.mjs';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const key = {}, rootFiber = { uid: 1 }, ownerFiber = { uid: 1 };
  const profile = { name: 'companion', dir: '/OWN/fixture' };
  const values = Object.fromEntries(['connection', 'agents', 'goals', 'sessionProjections', 'typert', 'typertGateway'].map(k => [k, {}]));
  values.connection.operator = { ctx: { fiber: { uid: 1 } } };
  values.profileContext = profile;
  let currentKey = key, leases = 0, locks = 0, maximum = 0, installs = 0, closes = 0, configOkay = true, mountPresent = true;
  let acquireGate, disposeGate, installGate, disposeFails = false;
  values.agentPresets = { async acquireScope() { const issued = currentKey; if (acquireGate) await acquireGate.promise; leases++; let disposed = false; return { key: issued, async [Symbol.asyncDispose]() { if (!disposed) { disposed = true; leases--; } } }; } };
  const root = { fiber: rootFiber, get: k => values[k] }, aliases = {};
  const ctx = { root, fiber: ownerFiber, get: k => k in aliases ? aliases[k] : values[k] };
  const boundaries = [], sources = [];
  const controller = createHostController(ctx, { identityOf: x => x, configCurrent: () => configOkay,
    livePresetMounts: within => { assert.equal(within, rootFiber); return mountPresent ? [{ key, presetId: 'companion', fiber: { uid: 1 } }] : []; },
    createScope(_ctx, issued) { assert.equal(issued, key); locks++; maximum = Math.max(maximum, locks); let disposed = false;
      return { ctx, async dispose() { if (disposeGate) await disposeGate.promise; if (disposeFails) throw new Error('OWN teardown failed'); if (!disposed) { locks--; disposed = true; } } }; }
  }, async (_ctx, boundary) => { installs++; boundaries.push(boundary); const source = { closed: false, close() { this.closed = true; closes++; } }; sources.push(source); if (installGate) await installGate.promise; return { sources: [source], pushLoaded: false }; });
  return { controller, values, root, ctx, aliases, boundaries, sources, profile, rootFiber, ownerFiber,
    get metrics() { return { leases, locks, maximum, installs, closes }; },
    replaceKey() { currentKey = {}; }, missingMount() { mountPresent = false; }, configDrift() { configOkay = false; },
    gateAcquire(gate) { acquireGate = gate; }, gateDispose(gate) { disposeGate = gate; }, gateInstall(gate) { installGate = gate; }, failDispose() { disposeFails = true; } };
}
test('1000 successful guarded runs do not retain lifetime cancellation Promise reactions', async t => {
  const f = fixture(); await f.controller.commit();
  const pending = new Set();
  const hook = createHook({ init(id, type) { if (type === 'PROMISE') pending.add(id); }, promiseResolve(id) { pending.delete(id); } });
  hook.enable();
  try {
    for (let n = 0; n < 10; n++) assert.equal(await f.controller.run(() => 1), 1);
    const before = pending.size;
    for (let n = 0; n < 1000; n++) assert.equal(await f.controller.run(() => 1), 1);
    t.diagnostic(`pending PROMISE resources before=${before}, after1000=${pending.size}`);
    assert.ok(pending.size <= before + 16, `pending Promise growth must be bounded: before=${before}, after=${pending.size}`);
    assert.equal(f.metrics.leases, 1);
  } finally { hook.disable(); await f.controller.close(); }
  assert.equal(f.metrics.leases, 0);
});
test('same public provenance recreates exactly once, old incarnation stays denied and teardown precedes reinstall', async () => {
  const f = fixture(); await f.controller.commit(); const old = f.boundaries[0];
  const gate = deferred(), task = f.controller.reconcile(() => gate.promise);
  assert.equal(f.controller.status().phase, 'suspended'); assert.equal(f.controller.status().available, false);
  assert.equal(f.sources[0].closed, true); await assert.rejects(old.run(() => assert.fail()), /unavailable/);
  gate.resolve(); await task;
  assert.equal(f.controller.status().phase, 'ready'); assert.equal(f.metrics.installs, 2); assert.equal(f.metrics.maximum, 1);
  await assert.rejects(old.run(() => assert.fail()), /unavailable/); assert.equal(await f.boundaries[1].run(() => 42), 42);
  await f.controller.close(); assert.equal(f.metrics.leases, 0); assert.equal(f.metrics.locks, 0);
});
for (const [name, drift] of [
  ['actual operator replaced', f => { f.values.connection.operator = { ctx: { fiber: { uid: 1 } } }; }],
  ['actual operator context replaced', f => { f.values.connection.operator.ctx = { fiber: { uid: 1 } }; }],
  ['root service replaced behind stale injected alias', f => { f.aliases.agents = f.values.agents; f.values.agents = {}; }],
  ['alias replaced while root survives', f => { f.aliases.agents = {}; }],
  ['profile replacement', f => { f.values.profileContext = { ...f.profile }; }],
  ['profile mutation', f => { f.profile.dir = '/OWN/other'; }],
  ['owner disposed', f => { f.ownerFiber.uid = null; }],
  ['root disposed', f => { f.rootFiber.uid = null; }],
  ['own configuration changed', f => f.configDrift()],
  ['registry generation changed', f => f.replaceKey()],
  ['scope mount unavailable', f => f.missingMount()],
]) test(`${name} cannot heal or recapture aliases`, async () => {
  const f = fixture(); await f.controller.commit(); drift(f); await f.controller.reconcile(async () => {});
  assert.equal(f.controller.status().phase, 'stale'); assert.equal(f.controller.status().requiresRecreate, true);
  await f.controller.start(); assert.equal(f.metrics.installs, 1); await f.controller.close();
});
test('required-entry audit failure never reinstalls', async () => {
  const f = fixture(); await f.controller.commit(); await f.controller.reconcile(async () => { throw new Error('OWN required entry failed'); });
  assert.equal(f.controller.status().phase, 'stale'); assert.equal(f.metrics.installs, 1); await f.controller.close();
});
test('dispose cancels never-settling Loader without own-initializer deadlock or late rearm', async () => {
  const f = fixture(); await f.controller.commit(); const gate = deferred(), task = f.controller.reconcile(() => gate.promise);
  await f.controller.close(); await task; assert.equal(f.metrics.leases, 0); gate.resolve();
  await Promise.resolve(); assert.equal(f.controller.status().phase, 'closed'); assert.equal(f.metrics.installs, 1);
});
test('single writer awaits lock teardown, disposal racing it prevents reinstall', async () => {
  const f = fixture(); await f.controller.commit(); const gate = deferred(); f.gateDispose(gate);
  const task = f.controller.reconcile(async () => {});
  for (let n = 0; n < 12; n++) await Promise.resolve();
  assert.equal(f.metrics.installs, 1); const closing = f.controller.close(); gate.resolve(); await Promise.all([task, closing]);
  assert.equal(f.metrics.installs, 1); assert.equal(f.metrics.locks, 0); assert.equal(f.metrics.leases, 0);
});
test('unconfirmed teardown never installs another writer', async () => {
  const f = fixture(); await f.controller.commit(); f.failDispose(); await f.controller.reconcile(async () => {});
  assert.equal(f.controller.status().phase, 'stale'); assert.equal(f.metrics.installs, 1); assert.equal(f.metrics.maximum, 1);
  await assert.rejects(f.controller.close(), /teardown failed/);
});
test('Loader epoch changing during acquire denies stale invocation before any operation', async () => {
  const f = fixture(); await f.controller.commit(); const gate = deferred(); f.gateAcquire(gate); let called = 0;
  const read = f.boundaries[0].run(() => called++); const settling = f.controller.reconcile(async () => {});
  gate.resolve(); await assert.rejects(read, /unavailable/); await settling; assert.equal(called, 0); await f.controller.close();
});
test('close cancels pending public registry diagnostic and disposes a late issued lease', async () => {
  const f = fixture(), gate = deferred(); f.gateAcquire(gate);
  const committing = f.controller.commit();
  for (let n = 0; n < 5; n++) await Promise.resolve();
  await f.controller.close(); await committing;
  gate.resolve(); for (let n = 0; n < 12; n++) await Promise.resolve();
  assert.equal(f.metrics.installs, 0); assert.equal(f.metrics.leases, 0); assert.equal(f.controller.status().phase, 'closed');
});
test('close during asynchronous source installation denies and closes late incarnation without reinstall', async () => {
  const f = fixture(), gate = deferred(); f.gateInstall(gate);
  const committing = f.controller.commit();
  for (let n = 0; n < 16; n++) await Promise.resolve();
  assert.equal(f.metrics.installs, 1);
  await f.controller.close(); await committing; gate.resolve();
  for (let n = 0; n < 12; n++) await Promise.resolve();
  assert.equal(f.sources[0].closed, true); assert.equal(f.metrics.leases, 0); assert.equal(f.metrics.locks, 0);
});
test('cancelled public acquisition can reject late without an unhandled rejection or rearm', async () => {
  const f = fixture(), gate = deferred(); f.gateAcquire(gate);
  const committing = f.controller.commit();
  for (let n = 0; n < 5; n++) await Promise.resolve();
  await f.controller.close(); await committing; gate.reject(new Error('OWN late acquisition rejection'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.metrics.leases, 0); assert.equal(f.metrics.installs, 0); assert.equal(f.controller.status().phase, 'closed');
});
test('cancelled source installation can reject late without an unhandled rejection or authority', async () => {
  const f = fixture(), gate = deferred(); f.gateInstall(gate);
  const committing = f.controller.commit();
  for (let n = 0; n < 16; n++) await Promise.resolve();
  assert.equal(f.metrics.installs, 1); await f.controller.close(); await committing;
  gate.reject(new Error('OWN late installation rejection')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.boundaries[0].valid(), false); assert.equal(f.metrics.leases, 0); assert.equal(f.metrics.locks, 0);
});
test('one-shot reconciliation deadline fails closed and cannot rearm after late Loader settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.controller.commit(); const gate = deferred();
  const settling = f.controller.reconcile(() => gate.promise);
  await Promise.resolve(); t.mock.timers.tick(15000); await settling;
  assert.equal(f.controller.status().reason, 'loader-settlement-timeout'); assert.equal(f.controller.status().requiresRecreate, true);
  gate.resolve(); await Promise.resolve(); assert.equal(f.metrics.installs, 1); await f.controller.close();
});
test('event storms coalesce and finite settlement budget latches closed', async () => {
  const f = fixture(); await f.controller.commit(); let audits = 0;
  const settle = async () => { audits++; void f.controller.reconcile(settle); };
  await f.controller.reconcile(settle); assert.equal(audits, 8); assert.equal(f.controller.status().reason, 'loader-change-budget-exhausted');
  assert.equal(f.metrics.installs, 1); await f.controller.close();
});
