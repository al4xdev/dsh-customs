import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeGoals } from './source.mjs';
import { fixture, sdk } from '../../../plugins/companion-native-host/test-fixture.mjs';

// Owned SDK fixture only: genuine registry-issued scope, native Agent/Goal projections and actual Connection operator.
// Calls the source directly, never native RPC or a live profile. No controller wrapper or source.close masks UID checks.
const originalFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = async () => { externalCalls++; throw new Error('Owned lifetime fixture forbids network'); };

async function owned(t) {
  const f = await fixture(); let lease, scope, owner, source;
  t.after(async () => {
    source?.close(); await owner?.dispose(); await scope?.dispose(); await lease?.[Symbol.asyncDispose](); await f.close();
    assert.equal(f.modelCalls, 0);
  });
  const [{ createScope, scopeOf, scopeChainOf }, { symbols }] = await Promise.all([sdk('dsh-scope'), sdk('cordis')]);
  const identityOf = value => value?.identity ?? value?.[symbols.original] ?? value;
  const agent = await f.create();
  f.app.goals.create(agent, { objective: 'Authored lifetime fixture', maxGoalRounds: 4 });
  lease = await f.app.agentPresets.acquireScope('companion'); scope = createScope(f.app, lease.key);
  owner = scope.ctx.plugin({ name: 'own-standalone-native-source-lifetime',
    inject: ['connection', 'agents', 'goals', 'sessionProjections', 'agentPresets', 'profileContext'],
    apply(ctx) { source = createNativeGoals(ctx, { scopeOf, scopeChainOf, identityOf }); },
  });
  await owner.await();
  const connection = f.app.get('connection'), peer = connection.operator;
  assert.equal(peer.ctx.root, f.app.root); assert.equal(f.app.root.fiber.uid, 0);
  const operatorUid = peer.ctx.fiber.uid;
  assert.ok(Number.isSafeInteger(operatorUid) && operatorUid >= 0);
  const aliases = Object.fromEntries(['connection', 'agents', 'goals', 'sessionProjections', 'agentPresets', 'profileContext'].map(name => [name, f.app.get(name)]));
  const originalSource = source;
  const dispatch = (method, request) => originalSource.dispatch(`nativeGoals/${method}`, { args: { request } }, undefined, peer);
  const initial = await dispatch('read', { sessionId: agent.id, generation: 1 }); assert.equal(initial.ok, true);
  const row = initial.value;
  const control = { sessionId: row.sessionId, goalId: row.projections.goal.goal.id, revision: row.projections.goal.goal.revision,
    sourceId: row.sourceId, incarnation: row.incarnation, generation: row.generation, permit: row.permit, action: 'pause' };
  assert.equal(source.ownsSession(agent.id, peer), true);
  return { f, owner, source: originalSource, peer, operatorUid, aliases, identityOf, agent, dispatch, control };
}

async function denied(value) {
  for (const [method, request] of [['read', { sessionId: value.agent.id, generation: 1 }], ['catalog', { sessionIds: [value.agent.id] }], ['control', value.control]]) {
    const result = await value.dispatch(method, request);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'nativeGoals/operator-required');
    assert.equal(JSON.stringify(result).includes('Authored lifetime fixture'), false);
  }
  assert.equal(value.source.ownsSession(value.agent.id, value.peer), false);
}

test('genuine retained-scope source owner disposal denies read/control while actual kernel operator and UID0 root survive', async t => {
  const value = await owned(t), revision = value.f.app.goals.get(value.agent).revision;
  await value.owner.dispose(); assert.equal(value.owner.uid, null);
  assert.equal(value.peer.ctx.fiber.uid, value.operatorUid); assert.equal(value.f.app.root.fiber.uid, 0);
  assert.equal(value.owner.isDisposed, undefined);
  for (const [name, alias] of Object.entries(value.aliases)) assert.equal(value.identityOf(value.f.app.get(name)), value.identityOf(alias));
  await denied(value); assert.equal(value.f.app.goals.get(value.agent).revision, revision);
});

test('actual SDK kernel operator fiber disposal denies raw source read/control while all original Root aliases remain registered', async t => {
  const value = await owned(t), operatorFiber = value.peer.ctx.fiber, revision = value.f.app.goals.get(value.agent).revision;
  await operatorFiber.dispose();
  assert.equal(operatorFiber.uid, null); assert.equal(operatorFiber.isDisposed, undefined);
  assert.equal(!operatorFiber.isDisposed, true, 'the removed predicate is true for the actual disposed operator');
  assert.throws(() => operatorFiber.assertActive(), error => error.code === 'INACTIVE_EFFECT');
  assert.equal(value.f.app.root.fiber.uid, 0);
  assert.equal(typeof value.owner.uid, 'number');
  for (const [name, alias] of Object.entries(value.aliases)) assert.equal(value.identityOf(value.f.app.get(name)), value.identityOf(alias));
  assert.equal(value.aliases.connection.operator, value.peer);
  assert.ok(value.aliases.agents && value.aliases.goals && value.aliases.sessionProjections && value.aliases.agentPresets);
  await denied(value); assert.equal(value.f.app.goals.get(value.agent).revision, revision);
});

test.after(() => { globalThis.fetch = originalFetch; assert.equal(externalCalls, 0); });
