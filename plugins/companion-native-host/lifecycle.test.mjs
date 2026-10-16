import test from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { fixture, sdk, value, control } from './test-fixture.mjs';
import { createCompanionNativeHost } from './index.mjs';
const originalFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = async () => { externalCalls++; throw new Error('OWN fixture forbids network/provider calls'); };
const read = (f, agent) => f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 });
const status = f => f.rpc('companionHost/status', undefined, { args: {} });

test('actual SDK public Loader unrelated config change suspends then restores fresh genuine sources, not old incarnations', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.app.loader.create({ id: 'own-default-model-fixture', name: fileURLToPath(new URL('./test-fixture.mjs', import.meta.url)), config: { fixtureModel: true, defaultModel: 'OWN-first-no-provider' } });
    const assembly = await f.mount(), agent = await f.create();
    const old = value(await read(f, agent)), oldSource = f.app.get('companionNativeGoals').source;
    assert.equal(value(await status(f)).available, true);
    const entry = [...f.app.loader.entries()].find(e => e.options.id === 'own-default-model-fixture');
    await f.app.loader.update(entry.id, { config: { fixtureModel: true, defaultModel: 'OWN-second-no-provider' } });
    assert.equal(assembly.status().available, false);
    assert.equal(oldSource.ownsSession(agent.id, f.app.connection.operator), false);
    await f.app.loader.await(); await assembly.settled();
    assert.equal(assembly.status().phase, 'ready'); assert.equal(value(await status(f)).available, true);
    const fresh = value(await read(f, agent));
    assert.notEqual(fresh.sourceId, old.sourceId); assert.notEqual(fresh.incarnation, old.incarnation);
    assert.equal(fresh.sessionId, agent.id); assert.equal(oldSource.ownsSession(agent.id, f.app.connection.operator), false);
    assert.deepEqual(value(await f.rpc('nativeGoals/catalog', { sessionIds: [agent.id] })).activities.map(a => a.sessionId), [agent.id]);
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('real SDK default-model saveSelection through real ConfigEditor preserves native catalog and rejects old permits', { timeout: 10000 }, async () => {
  const f = await fixture({ withDefaultModelEditor: true });
  try {
    const assembly = await f.mount(), agent = await f.create();
    const goal = f.app.goals.create(agent, { objective: 'OWN synthetic no-provider model-default lifecycle proof' });
    const old = value(await read(f, agent)), oldSource = f.app.get('companionNativeGoals').source;
    const defaults = f.app.get('agentDefaultModel');
    assert.deepEqual(defaults.currentSelection(), { provider: 'own-never-provider', model: 'own-first', reasoningEffort: 'low' });
    const next = { provider: 'own-never-provider', model: 'own-second', reasoningEffort: 'high' };
    await defaults.saveSelection(next);
    assert.deepEqual(defaults.currentSelection(), next);
    await f.app.loader.await(); await assembly.settled();
    assert.equal(assembly.status().phase, 'ready');
    assert.equal(f.app.get('agentDefaultModel').currentSelection().model, 'own-second');
    assert.equal(oldSource.ownsSession(agent.id, f.app.connection.operator), false);
    const fresh = value(await read(f, agent)); assert.notEqual(fresh.sourceId, old.sourceId); assert.notEqual(fresh.incarnation, old.incarnation);
    assert.notEqual(fresh.permit, old.permit); assert.ok(fresh.permit);
    const stale = await f.rpc('nativeGoals/control', control(old, 'pause')); assert.equal(stale.ok, false); assert.equal(stale.error.code, 'nativeGoals/stale-control');
    assert.equal(f.app.goals.get(agent).revision, goal.revision); assert.equal(f.app.goals.get(agent).phase, 'active');
    const activities = value(await f.rpc('nativeGoals/catalog', { sessionIds: [agent.id] })).activities;
    assert.equal(activities.length, 1); assert.equal(activities[0].sessionId, agent.id); assert.equal(activities[0].responding, false);
    assert.equal(value(await status(f)).available, true); assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

// Deployed layout: the host row is in the profile layer. A real ConfigEditor save (the app's
// model picker) re-reconciles that layer with raw plugin paths, then the HMR watcher with
// file URLs. Unchanged module and config: the same assembly must recover, no restart.
test('in-profile host survives real ConfigEditor saves that respell its own row without a service restart', { timeout: 20000 }, async () => {
  const f = await fixture({ hostInProfile: true });
  try {
    const assembly = f.hosted(), initial = assembly.status(), agent = await f.create();
    assert.equal(initial.phase, 'ready');
    const old = value(await read(f, agent)), oldSource = f.app.get('companionNativeGoals').source, defaults = f.app.get('agentDefaultModel');
    await defaults.saveSelection(defaults.currentSelection());
    await f.app.loader.await(); await assembly.settled();
    let observed = value(await status(f));
    // A reconcile did reach the host (the selection itself did not change).
    assert.ok(observed.generation > initial.generation);
    assert.equal(observed.phase, 'ready'); assert.equal(observed.available, true); assert.equal(observed.instanceId, initial.instanceId);
    assert.equal(oldSource.ownsSession(agent.id, f.app.connection.operator), false);
    const fresh = value(await read(f, agent)); assert.notEqual(fresh.sourceId, old.sourceId); assert.equal(fresh.sessionId, agent.id);
    await defaults.saveSelection({ provider: 'own-never-provider', model: 'own-second', reasoningEffort: 'high' });
    await f.reload(); // the HMR watcher's follow-up over the bytes ConfigEditor just wrote
    await f.app.loader.await(); await assembly.settled();
    observed = value(await status(f));
    assert.equal(observed.phase, 'ready'); assert.equal(observed.instanceId, initial.instanceId);
    assert.equal(f.app.get('agentDefaultModel').currentSelection().model, 'own-second');
    assert.equal(value(await read(f, agent)).sessionId, agent.id);
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('in-profile host: raw path spelling recovers, a different owner module stays stale and never re-arms', { timeout: 20000 }, async () => {
  const f = await fixture({ hostInProfile: true });
  try {
    const assembly = f.hosted(), initial = assembly.status(), agent = await f.create();
    const raw = row => row.name.startsWith('file:') ? { ...row, name: fileURLToPath(row.name) } : row;
    await f.reload(raw); await f.app.loader.await(); await assembly.settled();
    assert.equal(assembly.status().phase, 'ready'); assert.ok(assembly.status().generation > initial.generation);
    const before = value(await read(f, agent)), source = f.app.get('companionNativeGoals').source;
    // Same row, another module: the Loader applies a name-only change without restarting
    // the fiber, so only an explicit recreation may grant native authority again.
    const other = fileURLToPath(new URL('./index.mjs', import.meta.url));
    await f.reload(row => row.id === 'companion-native-host' ? { ...row, name: other } : row);
    await f.app.loader.await(); await assembly.settled();
    let observed = value(await status(f));
    assert.equal(observed.phase, 'stale'); assert.equal(observed.requiresRecreate, true); assert.equal(observed.instanceId, initial.instanceId);
    assert.equal(source.ownsSession(agent.id, f.app.connection.operator), false);
    assert.notEqual((await read(f, agent)).ok, true);
    const stale = await f.rpc('nativeGoals/read', { sessionId: before.sessionId, generation: 1 }); assert.notEqual(stale.ok, true);
    // Restoring the original spelling must not silently re-arm the latched assembly.
    await f.reload(); await f.app.loader.await(); await assembly.settled();
    observed = value(await status(f)); assert.equal(observed.phase, 'stale'); assert.equal(observed.requiresRecreate, true);
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('actual SDK current preset replacement cannot heal even when old retained mount survives', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const assembly = await f.mount(), agent = await f.create(); const oldSource = f.app.get('companionNativeGoals').source;
    const entry = [...f.app.loader.entries()].find(e => e.options.config?.id === 'companion');
    await entry.update({ config: { ...f.definition, description: 'OWN replacement generation' } });
    await f.app.loader.await(); await assembly.settled();
    assert.equal(assembly.status().phase, 'stale'); assert.equal(value(await status(f)).requiresRecreate, true);
    assert.notEqual((await read(f, agent)).ok, true); assert.equal(oldSource.ownsSession(agent.id, f.app.connection.operator), false);
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('availability is ordinary operator-only unary RPC, independent of absent agents and closed native source', { timeout: 10000 }, async () => {
  const f = await fixture({ autoReady: false });
  try {
    const assembly = await f.mount(); assert.equal(value(await status(f)).phase, 'pending');
    assert.equal((await f.rpc('companionHost/status', undefined, { args: {}, authenticated: false })).status, 401);
    const { OperatorPeer } = await sdk('dsh-client-connection');
    await assert.rejects(f.app.get('typertGateway').invoke({ namespace: 'companionHost', method: 'status', args: {}, peer: new OperatorPeer(f.app) }), e => e.code === 'companionHost/operator-required');
    await f.commitReady(); assert.equal(value(await status(f)).available, true);
    f.app.get('profileContext').name = 'foreign';
    assert.equal(value(await status(f)).available, false);
    assert.equal(assembly.status().available, false); assert.equal(f.app.agents.roots().length, 0);
  } finally { await f.close(); }
});

test('actual SDK scope teardown unregisters old Gateway contribution before reinstallation and repeated updates never duplicate writer', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const assembly = await f.mount(), agent = await f.create(); let previous = value(await read(f, agent));
    for (let n = 0; n < 3; n++) {
      f.app.emit('loader/config-update'); await assembly.settled();
      assert.equal(assembly.status().phase, 'ready');
      const fresh = value(await read(f, agent)); assert.notEqual(fresh.sourceId, previous.sourceId); previous = fresh;
      assert.equal(value(await status(f)).available, true);
    }
    await assembly.close(); assert.notEqual((await read(f, agent)).ok, true);
    // Explicit actual plugin recreation, never controller rearm after close.
    const next = await f.mount(); assert.equal(next.status().phase, 'ready'); assert.equal(value(await read(f, agent)).sessionId, agent.id);
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});
test('actual public required-entry audit refuses reconciliation even with unchanged native preset and core', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const assembly = await f.mount(), agent = await f.create(); const old = f.app.get('companionNativeGoals').source;
    await f.app.loader.create({ id: 'webserver', name: fileURLToPath(new URL('./test-fixture.mjs', import.meta.url)), inject: ['ownNeverProvided'], config: { fixtureModel: true } });
    await f.app.loader.await(); await assembly.settled();
    assert.equal(assembly.status().phase, 'stale'); assert.equal(assembly.status().reason, 'loader-reconciliation-unproven');
    assert.equal(old.ownsSession(agent.id, f.app.connection.operator), false); assert.notEqual((await read(f, agent)).ok, true);
    assert.equal(value(await status(f)).requiresRecreate, true); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});
test('actual public owner raw config drift cannot hide behind the unchanged factory argument', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const assembly = await f.mount(), agent = await f.create(); const old = f.app.get('companionNativeGoals').source;
    const entry = [...f.app.loader.entries()].find(e => e.options.config?.fixtureHost === true);
    // Raw public row mutation models an update hook retaining a stale factory alias.
    entry.options.config = { ...entry.options.config, push: { enabled: true, serviceAccountFile: '/OWN/changed-path' } };
    f.app.emit('loader/config-update'); await assembly.settled();
    assert.equal(assembly.status().phase, 'stale'); assert.equal(old.ownsSession(agent.id, f.app.connection.operator), false);
    assert.equal(value(await status(f)).requiresRecreate, true); assert.equal(f.pushStoreExists(), false);
  } finally { await f.close(); }
});
test('public instanceId is stable across unary reads, reconciliation and stale closure but changes on actual assembly recreation', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const assembly = await f.mount(), initial = value(await status(f));
    assert.match(initial.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(initial).sort(), ['version', 'instanceId', 'phase', 'reason', 'pushLoaded', 'startupCommitted', 'available', 'retryable', 'requiresRecreate', 'generation'].sort());
    assert.equal(initial.generation, 0); assert.equal(value(await status(f)).instanceId, initial.instanceId);
    const { instanceId, ...withoutNonce } = initial;
    assert.ok(Buffer.byteLength(JSON.stringify(initial)) - Buffer.byteLength(JSON.stringify(withoutNonce)) <= 128);
    f.app.emit('loader/config-update'); await assembly.settled();
    const reconciled = value(await status(f)); assert.equal(reconciled.available, true);
    assert.equal(reconciled.instanceId, initial.instanceId); assert.ok(reconciled.generation > initial.generation);
    f.app.get('profileContext').name = 'foreign';
    const stale = value(await status(f)); assert.equal(stale.instanceId, initial.instanceId); assert.equal(stale.available, false); assert.equal(stale.requiresRecreate, true);
    await assembly.close(); assert.equal(assembly.status().instanceId, initial.instanceId); assert.equal(assembly.status().available, false);
    f.app.get('profileContext').name = 'companion';
    const next = await f.mount(), recreated = value(await status(f));
    assert.equal(next.status().available, true); assert.equal(recreated.generation, 0); assert.notEqual(recreated.instanceId, initial.instanceId);
    assert.equal(value(await status(f)).instanceId, recreated.instanceId); assert.equal(f.app.agents.roots().length, 0); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});
test('disabled assemblies mint independent stable diagnostic nonces without reading context', async () => {
  const ctx = { get() { assert.fail('disabled assembly must not read context'); } };
  const first = await createCompanionNativeHost(ctx), second = await createCompanionNativeHost(ctx);
  assert.match(first.status().instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first.status().instanceId, first.status().instanceId); assert.notEqual(first.status().instanceId, second.status().instanceId);
  assert.equal(first.status().available, false); await first.close(); await second.close();
});
test('1000 genuine SDK unary native catalog RPCs leave bounded pending Promise resources without runtime debug exposure', { timeout: 10000 }, async t => {
  const f = await fixture(); let hook;
  try {
    const assembly = await f.mount(), agent = await f.create();
    const pending = new Set();
    hook = createHook({ init(id, type) { if (type === 'PROMISE') pending.add(id); }, promiseResolve(id) { pending.delete(id); } });
    hook.enable();
    for (let n = 0; n < 10; n++) value(await f.rpc('nativeGoals/catalog', { sessionIds: [agent.id] }));
    const before = pending.size;
    for (let n = 0; n < 1000; n++) {
      const result = value(await f.rpc('nativeGoals/catalog', { sessionIds: [agent.id] }));
      assert.equal(result.activities[0].sessionId, agent.id);
    }
    const after = pending.size; hook.disable();
    t.diagnostic(`genuine SDK pending PROMISE resources before=${before}, after1000=${after}`);
    assert.ok(after <= before + 32, `genuine SDK pending Promise growth must be bounded: before=${before}, after=${after}`);
    assert.equal(assembly.status().available, true); assert.equal(f.modelCalls, 0);
    assert.equal(Object.hasOwn(value(await status(f)), 'pendingCancel'), false);
  } finally { hook?.disable(); await f.close(); }
});
test.after(() => { globalThis.fetch = originalFetch; assert.equal(externalCalls, 0); });
