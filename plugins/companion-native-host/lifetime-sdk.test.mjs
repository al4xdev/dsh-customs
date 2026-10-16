import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostController } from './controller.mjs';
import { sdk } from './test-fixture.mjs';

// Actual Cordis lifetimes with synthetic controller collaborators. This proves the lifetime contract,
// not a bypass of the complete Loader/native-scope/permit boundary or a live-runtime exploit.
async function fixture(t, { operatorOwner = false, acquireGate } = {}) {
  const { Context, symbols } = await sdk('cordis');
  const root = new Context();
  let ctx, operatorCtx;
  const owner = root.plugin({ name: 'own-host-lifetime', apply(value) { ctx = value; } }); await owner.await();
  let operatorFiber;
  if (operatorOwner) { operatorFiber = root.plugin({ name: 'own-operator-lifetime', apply(value) { operatorCtx = value; } }); await operatorFiber.await(); }
  else operatorCtx = root;
  const key = {}, identities = new Map(); let leases = 0, armed = false, ran = 0;
  const values = Object.fromEntries(['agents', 'goals', 'sessionProjections', 'typert', 'typertGateway'].map(name => [name, {}]));
  values.profileContext = { name: 'companion', dir: '/OWN/lifetime-sdk' };
  values.connection = { operator: { ctx: operatorCtx } };
  values.agentPresets = { async acquireScope() {
    if (armed && acquireGate) await acquireGate.promise;
    leases++; let closed = false;
    return { key, async [Symbol.asyncDispose]() { if (!closed) { closed = true; leases--; } } };
  } };
  const providers = new Map(Object.entries(values).map(([name, value]) => [name, root.provide(name, value)]));
  const identityOf = value => value?.[symbols.original] ?? value;
  for (const name of Object.keys(values)) identities.set(name, identityOf(root.get(name)));
  let boundary;
  const controller = createHostController(ctx, { identityOf,
    livePresetMounts: () => [{ key, presetId: 'companion', fiber: owner }],
    createScope: () => ({ ctx, async dispose() {} }),
  }, async (_ctx, value) => { boundary = value; return { sources: [{ close() {} }], pushLoaded: false }; });
  t.after(async () => { await controller.close(); await owner.dispose(); await operatorFiber?.dispose(); await root.fiber.dispose(); });
  await controller.commit(); assert.equal(controller.status().available, true);
  return { root, ctx, owner, operatorFiber, controller, identities, identityOf, boundary,
    restoreAlias(name) {
      providers.get(name)();
      const withdrawTemporary = root.provide(name, {}); withdrawTemporary();
      providers.set(name, root.provide(name, values[name]));
    },
    arm() { armed = true; }, operation() { ran++; }, get ran() { return ran; }, get leases() { return leases; } };
}

test('actual SDK uid0 root works; disposed owner has no isDisposed flag and cannot regain Host authority through restored root aliases', async t => {
  const f = await fixture(t);
  assert.equal(f.root.fiber.uid, 0); assert.equal(f.owner.isDisposed, undefined);
  assert.equal(typeof f.owner.uid, 'number'); f.owner.assertActive();
  await f.owner.dispose();
  assert.equal(f.owner.uid, null); assert.equal(f.owner.isDisposed, undefined);
  assert.equal(!f.owner.isDisposed, true, 'the removed boolean predicate incorrectly calls this actual disposed fiber active');
  assert.throws(() => f.owner.assertActive(), error => error.code === 'INACTIVE_EFFECT');
  f.restoreAlias('agents');
  // Restore through public provide/dispose, before consulting controller status; no private SDK state is mutated.
  for (const [name, value] of f.identities) assert.equal(f.identityOf(f.root.get(name)), value);
  assert.equal(f.controller.status().available, false); assert.equal(f.controller.status().requiresRecreate, true);
  await assert.rejects(f.boundary.run(() => f.operation()), error => error.code === 'companionHost/unavailable');
  await f.controller.reconcile(async () => {}); await f.controller.start();
  assert.equal(f.ran, 0); assert.equal(f.controller.status().available, false);
});

test('actual disposed operator-context fiber is denied although owner, root and all canonical service bindings survive', async t => {
  const f = await fixture(t, { operatorOwner: true });
  await f.operatorFiber.dispose(); assert.equal(f.operatorFiber.uid, null);
  assert.equal(typeof f.owner.uid, 'number'); assert.equal(f.root.fiber.uid, 0);
  for (const [name, value] of f.identities) assert.equal(f.identityOf(f.root.get(name)), value);
  await assert.rejects(f.controller.run(() => f.operation()), error => error.code === 'companionHost/unavailable');
  assert.equal(f.ran, 0); assert.equal(f.controller.status().requiresRecreate, true);
});

test('actual owner disposal while registry acquisition awaits prevents the callback and still drains the late check lease', async t => {
  const gate = Promise.withResolvers();
  const f = await fixture(t, { acquireGate: gate }); f.arm();
  const running = f.controller.run(() => f.operation());
  await f.owner.dispose(); gate.resolve();
  await assert.rejects(running, error => error.code === 'companionHost/unavailable');
  await f.controller.close(); assert.equal(f.ran, 0); assert.equal(f.leases, 0);
});
