import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCompanionNativeHost } from './index.mjs';
import { control, fixture, sdk, value } from './test-fixture.mjs';
const { scopeOf, scopeChainOf } = await sdk('dsh-scope');
const { standingMountFor } = await sdk('dsh-agent-preset-registry');
let externalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { externalCalls++; throw new Error('OWN host fixture forbids external fetch'); };

test('default disabled assembly never reads context, imports frozen entries, leases or opens files', async () => {
  let reads = 0;
  const assembly = await createCompanionNativeHost({ get() { reads++; throw new Error('must not read'); } });
  assert.equal(assembly.status().phase, 'disabled'); assert.equal(assembly.status().pushLoaded, false); assert.equal(reads, 0); await assembly.close();
});

test('public acquireScope retains genuine preset before ANY agents; native RPC unavailable then actual roots become readable', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true);
    const assembly = await f.mount(); assert.equal(assembly.status().phase, 'ready'); assert.equal(assembly.status().pushLoaded, false);
    assert.equal(f.app.agents.roots().length, 0);
    const absent = await f.rpc('nativeGoals/read', { sessionId: 'own-not-created', generation: 1 });
    assert.equal(absent.ok, false); assert.equal(absent.error.code, 'nativeGoals/not-live-owned');
    assert.equal((await f.rpc('goalPush/status', {})).status, 404); assert.equal(f.pushStoreExists(), false);
    const agent = await f.create(), second = await f.create();
    const native = f.app.get('companionNativeGoals'), lease = await f.app.agentPresets.acquireScope('companion');
    try {
      assert.equal(scopeChainOf(scopeOf(agent.ctx)).includes(lease.key), true);
      assert.equal(standingMountFor(agent.ctx).key, lease.key); assert.equal(standingMountFor(second.ctx).key, lease.key);
    } finally { await lease[Symbol.asyncDispose](); }
    assert.equal(native.ownsSession(agent.id, f.app.connection.operator), true);
    let goal = f.app.goals.create(agent, { objective: 'OWN native host goal', maxGoalRounds: 4 });
    const first = value(await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 3 }));
    const paused = value(await f.rpc('nativeGoals/control', control(first, 'pause'))); assert.equal(paused.projections.goal.goal.phase, 'paused');
    const stale = await f.rpc('nativeGoals/control', control(first, 'pause')); assert.equal(stale.ok, false);
    const resumed = value(await f.rpc('nativeGoals/control', control(paused, 'resume'))); assert.equal(resumed.projections.goal.goal.phase, 'active');
    assert.equal(f.app.goals.get(agent).revision, goal.revision + 2); assert.equal(f.app.goals.get(agent).roundsStarted, 0);
    assert.equal(agent.session.snapshotEvents().some(event => event.type.startsWith('tool/') || event.type === 'user/message'), false);
    const foreign = await f.create('foreign'); assert.equal(native.ownsSession(foreign.id, f.app.connection.operator), false);
    assert.equal((await f.rpc('nativeGoals/read', { sessionId: foreign.id, generation: 3 })).ok, false);
    await assert.rejects(native.read({ sessionId: agent.id, generation: 3 }), error => error.code === 'nativeGoals/operator-required');
    assert.equal((await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 3 }, { authenticated: false })).status, 401);
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true);
    await assembly.close(); assert.equal(native.ownsSession(agent.id, f.app.connection.operator), false);
    const removed = await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 3 }); assert.equal(removed.ok, false);
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true);
    assert.equal(f.modelCalls, 0); assert.equal(externalCalls, 0);
  } finally { await f.close(); }
});

test('missing preset stays pending through initial declaration+root creation and arms only at successful startup commit', { timeout: 20000 }, async () => {
  const f = await fixture({ presetInitially: false, autoReady: false }); let unregister;
  try {
    const assembly = await f.mount(); assert.equal(assembly.status().phase, 'pending');
    assert.equal((await f.rpc('nativeGoals/read', { sessionId: 'own-absent', generation: 1 })).status, 404);
    unregister = await f.app.agentPresets.register(f.definition);
    const agent = await f.create(); assert.equal(assembly.status().phase, 'pending');
    assert.equal(f.app.get('companionNativeGoals'), undefined);
    assert.equal((await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 })).status, 404);
    await f.commitReady(); assert.equal(assembly.status().phase, 'ready');
    const read = value(await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 })); assert.equal(read.sessionId, agent.id);
    assert.equal(read.projections.goal, null); assert.equal(read.projections.todos, null); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); await unregister?.(); }
});

test('real preset generation replacement via public declaration lifecycle permanently closes old capabilities; no auto-remount/rearm', { timeout: 20000 }, async () => {
  const f = await fixture({ presetInitially: false }); let unregister, unregisterNext;
  try {
    unregister = await f.app.agentPresets.register(f.definition);
    const assembly = await f.mount(), agent = await f.create();
    f.app.goals.create(agent, { objective: 'OWN unchanged during preset replacement', maxGoalRounds: 4 });
    const old = value(await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 4 })), native = f.app.get('companionNativeGoals');
    await unregister(); unregister = undefined;
    unregisterNext = await f.app.agentPresets.register({ ...f.definition, description: 'OWN next native generation' });
    assert.equal(assembly.status().available, false); await assembly.settled();
    assert.equal(assembly.status().phase, 'stale');
    assert.equal(native.ownsSession(agent.id, f.app.connection.operator), false);
    const result = await f.rpc('nativeGoals/control', control(old, 'pause')); assert.equal(result.ok, false);
    assert.equal(f.app.goals.get(agent).phase, 'active'); assert.equal(f.app.goals.get(agent).revision, old.projections.goal.goal.revision);
    await f.create(); assert.equal(assembly.status().phase, 'stale');
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true); assert.equal(f.modelCalls, 0); assert.equal(externalCalls, 0);
  } finally { await f.close(); await unregister?.(); await unregisterNext?.(); }
});

test('missing native TODO projection fails read closed rather than inventing a standing list', { timeout: 20000 }, async () => {
  const f = await fixture({ todos: false });
  try {
    await f.mount(); const agent = await f.create(); f.app.goals.create(agent, { objective: 'OWN no native TODO projection' });
    const result = await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'nativeGoals/projections-unavailable'); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('push is not loaded for partial/unconfigured config; profile drift closes native guarded calls', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const assembly = await f.mount({ enabled: true, push: { enabled: true } });
    assert.equal(assembly.status().pushLoaded, false); assert.equal(f.app.get('companionGoalPush'), undefined); assert.equal(f.pushStoreExists(), false);
    const agent = await f.create(); f.app.goals.create(agent, { objective: 'OWN profile drift' });
    f.app.get('profileContext').name = 'foreign';
    const result = await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 });
    assert.equal(result.ok, false); assert.equal(assembly.status().phase, 'stale'); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('configured push denies all methods before commit, then registers through genuine retained scope and authenticated Gateway', { timeout: 20000 }, async () => {
  const f = await fixture({ autoReady: false });
  try {
    const projectId = 'authored-host-fixture', senderId = '123456789012', appId = '1:123456789012:android:0123456789abcdef';
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }), path = join(f.directory, 'AUTHORED-NOT-A-CLOUD-KEY.json');
    writeFileSync(path, JSON.stringify({ type: 'service_account', project_id: projectId, client_email: `authored@${projectId}.iam.gserviceaccount.com`, token_uri: 'https://oauth2.googleapis.com/token',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
    const assembly = await f.mount({ enabled: true, push: { enabled: true, publicConfig: { projectId, appId, senderId, androidPackage: 'dev.alex.dsh.companion' }, serviceAccountFile: path } });
    assert.equal(assembly.status().phase, 'pending'); assert.equal(assembly.status().pushLoaded, false);
    assert.equal(f.app.get('companionGoalPush'), undefined); assert.equal(f.pushStoreExists(), false);
    const agent = await f.create(), hash = s => createHash('sha256').update(s).digest('hex');
    const request = { version: 1, deviceId: randomUUID(), token: 'authored-never-real-host-token', tokenDigest: hash('authored-never-real-host-token'),
      configDigest: hash([projectId, appId, senderId, 'dev.alex.dsh.companion'].join('|')), authGeneration: 1, sessionIds: [agent.id] };
    const statusRequest = { version: 1, deviceId: request.deviceId, authGeneration: 1 };
    for (const [method, args] of [['register', request], ['status', statusRequest], ['unregister', { ...statusRequest, registrationId: randomUUID() }]]) {
      assert.equal((await f.rpc(`goalPush/${method}`, args)).status, 404);
    }
    await f.commitReady(); assert.equal(assembly.status().phase, 'ready');
    const registered = value(await f.rpc('goalPush/register', request)); assert.equal(registered.profile, 'companion'); assert.deepEqual(registered.sessionIds, [agent.id]);
    assert.equal(value(await f.rpc('goalPush/status', { version: 1, deviceId: request.deviceId, authGeneration: 1 })).registrationReady, true);
    assert.equal(f.pushStoreExists(), true); assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true);
    const before = value(await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 }));
    f.app.emit('loader/config-update'); await assembly.settled();
    assert.equal(assembly.status().phase, 'ready'); assert.equal(assembly.status().pushLoaded, true);
    const after = value(await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 }));
    assert.notEqual(after.sourceId, before.sourceId); assert.notEqual(after.incarnation, before.incarnation);
    const restored = value(await f.rpc('goalPush/status', statusRequest));
    assert.equal(restored.registrationReady, true); assert.equal(restored.receipt.registrationId, registered.registrationId);
    assert.equal(f.modelCalls, 0); assert.equal(externalCalls, 0);
  } finally { await f.close(); }
});

test('actual public Loader Entry.update HMR latches assembly closed before old CAS can run', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const assembly = await f.mount(), agent = await f.create();
    f.app.goals.create(agent, { objective: 'OWN Loader HMR boundary' });
    const old = value(await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 }));
    const entry = [...f.app.loader.entries()].find(candidate => candidate.options.name.includes('dsh-agent-preset/') && candidate.options.config?.id === 'companion');
    assert.ok(entry, 'own Companion preset Loader row must exist');
    await entry.update({ config: { ...f.definition, description: 'OWN Loader HMR next generation' } });
    assert.equal(assembly.status().available, false); await f.app.loader.await(); await assembly.settled();
    assert.equal(assembly.status().phase, 'stale');
    assert.equal((await f.rpc('nativeGoals/control', control(old, 'pause'))).ok, false);
    assert.equal(f.app.goals.get(agent).phase, 'active'); assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true);
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('direct public unregister outside Loader is detected by next guarded RPC and never auto-rearms', { timeout: 20000 }, async () => {
  const f = await fixture({ presetInitially: false }); let unregister;
  try {
    unregister = await f.app.agentPresets.register(f.definition);
    const assembly = await f.mount(), agent = await f.create();
    f.app.goals.create(agent, { objective: 'OWN direct registry withdrawal' });
    const old = value(await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 }));
    await unregister(); unregister = undefined;
    assert.equal((await f.rpc('nativeGoals/control', control(old, 'pause'))).ok, false);
    assert.equal(assembly.status().phase, 'stale'); assert.equal(f.app.goals.get(agent).phase, 'active'); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); await unregister?.(); }
});

test('foreign invocation Peer cannot consume genuine permit; root disposal releases source and retained native scope', { timeout: 20000 }, async () => {
  const f = await fixture(); let closed = false;
  try {
    await f.mount(); const agent = await f.create();
    f.app.goals.create(agent, { objective: 'OWN foreign peer and disposal' });
    const old = value(await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 })), native = f.app.get('companionNativeGoals');
    const { OperatorPeer } = await sdk('dsh-client-connection'), foreignPeer = new OperatorPeer(f.app);
    await assert.rejects(f.app.get('typertGateway').invoke({ namespace: 'nativeGoals', method: 'control', args: { request: control(old, 'pause') }, peer: foreignPeer }), error => error.code === 'nativeGoals/operator-required');
    assert.equal(value(await f.rpc('nativeGoals/control', control(old, 'pause'))).projections.goal.goal.phase, 'paused');
    const ownPeer = f.app.connection.operator;
    await f.close(); closed = true; assert.equal(native.ownsSession(agent.id, ownPeer), false);
    const { livePresetMounts } = await sdk('dsh-agent-preset-registry');
    assert.equal(livePresetMounts(f.app.fiber).length, 0); assert.equal(f.modelCalls, 0); assert.equal(externalCalls, 0);
  } finally { if (!closed) await f.close(); }
});

test('pending host has no native receiver before AppReady; early agent events do not acquire and disposal cancels startup', { timeout: 20000 }, async () => {
  const f = await fixture({ autoReady: false }); let closed = false;
  try {
    const assembly = await f.mount(), native = f.app.get('companionNativeGoals'), agent = await f.create();
    const goal = f.app.goals.create(agent, { objective: 'OWN precommit goal stays unchanged' });
    assert.equal(assembly.status().phase, 'pending'); assert.equal(assembly.status().startupCommitted, false);
    assert.equal(native, undefined); assert.equal(f.app.get('companionNativeGoals'), undefined);
    const request = { sessionId: agent.id, goalId: goal.id, revision: goal.revision, sourceId: 'authored-early', incarnation: 'authored-early', generation: 1, permit: 'authored-early', action: 'pause' };
    for (const [method, args] of [['read', { sessionId: agent.id, generation: 1 }], ['catalog', { sessionIds: [agent.id] }], ['control', request]]) {
      assert.equal((await f.rpc(`nativeGoals/${method}`, args)).status, 404);
    }
    assert.equal(f.app.goals.get(agent).phase, 'active'); assert.equal(f.app.goals.get(agent).revision, goal.revision);
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true);
    const peer = f.app.connection.operator;
    await f.close(); closed = true; assert.equal(assembly.status().phase, 'closed');
    await f.commitReady(); assert.equal(assembly.status().phase, 'closed'); assert.equal(f.app.get('companionNativeGoals'), undefined);
    const { livePresetMounts } = await sdk('dsh-agent-preset-registry'); assert.equal(livePresetMounts(f.app.fiber).length, 0);
    assert.equal(f.modelCalls, 0); assert.equal(externalCalls, 0);
  } finally { if (!closed) await f.close(); }
});

test('startup commit revalidates actual profile identity before granting any native authority', { timeout: 20000 }, async () => {
  const f = await fixture({ autoReady: false });
  try {
    const assembly = await f.mount(), agent = await f.create(), native = f.app.get('companionNativeGoals');
    f.app.goals.create(agent, { objective: 'OWN profile changed before startup commit' });
    f.app.get('profileContext').name = 'foreign';
    await f.commitReady(); assert.equal(assembly.status().phase, 'stale');
    assert.equal(assembly.status().requiresRecreate, true);
    assert.equal(assembly.status().startupCommitted, true); assert.equal(native, undefined); assert.equal(f.app.get('companionNativeGoals'), undefined);
    assert.equal(f.app.goals.get(agent).phase, 'active');
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('startup commit first acquires actual current preset lease and refuses a withdrawn initial generation', { timeout: 20000 }, async () => {
  const f = await fixture({ presetInitially: false, autoReady: false }); let unregister;
  try {
    unregister = await f.app.agentPresets.register(f.definition);
    const assembly = await f.mount(), agent = await f.create(), native = f.app.get('companionNativeGoals');
    f.app.goals.create(agent, { objective: 'OWN staged generation withdrawn before commit' });
    await unregister(); unregister = undefined;
    await f.commitReady(); assert.equal(assembly.status().phase, 'pending');
    assert.equal(assembly.status().startupCommitted, true); assert.equal(native, undefined); assert.equal(f.app.get('companionNativeGoals'), undefined);
    assert.equal(f.app.goals.get(agent).phase, 'active');
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); await unregister?.(); }
});

test('Loader mutation during asynchronous startup revalidation is already fatal, never treated as late initial config', { timeout: 20000 }, async () => {
  const f = await fixture({ autoReady: false });
  try {
    const assembly = await f.mount(), agent = await f.create(); f.app.goals.create(agent, { objective: 'OWN startup handshake race' });
    const committing = f.commitReady();
    await f.app.loader.create({ name: '@deepseek-ai/cordis-plugin-group', config: [] });
    await committing; assert.equal(assembly.status().available, false); await f.app.loader.await(); await assembly.settled();
    assert.equal(assembly.status().phase, 'stale'); assert.equal(assembly.status().startupCommitted, true);
    assert.equal(f.app.goals.get(agent).phase, 'active'); assert.notEqual((await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 })).ok, true);
    assert.equal(value(await f.rpc('ownOrdinary/read')).operator, true); assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test.after(() => { globalThis.fetch = originalFetch; assert.equal(externalCalls, 0); });
