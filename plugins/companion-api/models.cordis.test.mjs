import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHost } from '../common.mjs';
import { apply } from './index.mjs';
const [{ Context }, { default: Registry }, { default: Gateway }, sessionSdk] = await Promise.all([
  import(resolveHost('@deepseek-ai/cordis')),
  import(resolveHost('@deepseek-ai/dsh-typert-registry')),
  import(resolveHost('@deepseek-ai/dsh-api-gateway')),
  import(resolveHost('@deepseek-ai/dsh-session')),
]);

// Real Cordis dependency enforcement and Gateway codecs, synthetic public providers
// only. No native controller, credentials, backend, network or model turn is created.
async function host(t) {
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  await ctx.plugin(Registry); await ctx.plugin(Gateway);
  ctx.provide('profileContext', { name: 'companion', dir: '/synthetic-companion' });
  ctx.provide('sessionPersistence', { list: async () => [{ header: { id: 'synthetic-chat', agentPreset: 'companion', createdAt: 1 } }] });
  // The real lightweight Session registry supplies the public post-commit feed; no Agent/model services are needed.
  await ctx.plugin(sessionSdk.default);
  let ownerContext;
  await ctx.plugin({ name: 'synthetic-companion-api-owner', inject: ['typert', 'sessionPersistence'], apply: async scoped => {
    ownerContext = scoped;
    await apply(scoped);
  } });
  return { ctx, ownerContext, invoke: (method, request) => ctx.typertGateway.invoke({ namespace: 'companion', method,
    args: { request }, signal: new AbortController().signal }) };
}
async function addModelProviders(ctx) {
  const calls = { catalog: 0, current: 0, resolve: 0, save: 0 };
  const selected = { provider: 'synthetic', model: 'model/fixture', reasoningEffort: 'low' };
  let withdraw;
  await ctx.plugin({ name: 'synthetic-model-providers', apply: provider => {
  withdraw = provider.provide('sessionController', { async modelCatalog() {
    calls.catalog++;
    return { default: { ...selected }, routableProviders: ['synthetic'], failures: [],
      groups: [{ id: 'synthetic', name: 'Synthetic provider', models: [{ id: 'model/fixture', name: 'Fixture model',
        reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }] }] };
  } });
  provider.provide('agentDefaultModel', { currentSelection() { calls.current++; return { ...selected }; },
    saveSelection() { calls.save++; assert.fail('Metadata regression must never mutate a default'); } });
  provider.provide('llm', { resolveCallConfig() { calls.resolve++; assert.fail('Metadata regression must never resolve a model call'); } });
  provider.provide('settings', { writable: true });
  provider.provide('configEditor', {});
  } });
  return { calls, selected, withdraw };
}

test('actual Cordis plugin context reads optional model providers via public get', async t => {
  const fixture = await host(t); const models = await addModelProviders(fixture.ctx);
  const ownerContext = fixture.ownerContext;
  // This is the exact access trap the old plain-object fixture could not detect.
  assert.throws(() => ownerContext.sessionController, /without inject/);
  assert.ok(ownerContext.get('sessionController'));
  const result = await fixture.invoke('modelCatalog', {});
  assert.deepEqual(result.current, models.selected);
  assert.equal(result.groups[0].models[0].id, 'model/fixture'); assert.equal(result.writable, true);
  assert.deepEqual(models.calls, { catalog: 1, current: 1, resolve: 0, save: 0 });
});

test('missing model services never gate the ordinary companion chat catalog', async t => {
  const fixture = await host(t);
  assert.deepEqual((await fixture.invoke('listChats', {})).chats, [{ id: 'synthetic-chat', createdAt: 1 }]);
  await assert.rejects(fixture.invoke('modelCatalog', {}), error => error.code === 'companion/model-catalog-unavailable');
  assert.deepEqual((await fixture.invoke('listChats', {})).chats, [{ id: 'synthetic-chat', createdAt: 1 }]);
});

test('optional metadata services are looked up fresh after withdrawal', async t => {
  const fixture = await host(t); const models = await addModelProviders(fixture.ctx);
  await fixture.invoke('modelCatalog', {}); models.withdraw();
  await assert.rejects(fixture.invoke('modelCatalog', {}), error => error.code === 'companion/model-catalog-unavailable');
  assert.equal(models.calls.catalog, 1);
  assert.equal((await fixture.invoke('listChats', {})).chats.length, 1);
});
