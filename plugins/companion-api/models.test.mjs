import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelSettings, MODEL_MAX_BYTES, parseModelCatalogRequest, parseSelectDefaultModelRequest, modelCodecs } from './models.mjs';

function fixture(options = {}) {
  let selected = { provider: 'openai-codex', model: 'gpt-6-sol', reasoningEffort: 'low' };
  const calls = { catalog: 0, resolve: 0, save: 0 };
  const source = options.catalog ?? { default: { ...selected }, routableProviders: ['openai-codex'], failures: [], groups: [{
    id: 'openai-codex', name: 'Codex', models: [{ id: 'gpt-6-sol', name: 'GPT 6 Sol', reasoning: {
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low',
    } }, { id: 'model/alternate', name: 'Alternate', description: 'Synthetic model' }],
  }] };
  const ctx = {
    get(name) {
      if (name === 'configEditor') return options.noEditor ? undefined : {};
      if (name === 'settings') return { writable: options.writable !== false };
      if (name === 'agentDefaultModel' && options.disappearAfterSave && calls.save > 0) return undefined;
      if (['sessionController', 'agentDefaultModel', 'llm'].includes(name)) return ctx[name];
      return undefined;
    },
    agentDefaultModel: { currentSelection: () => {
      if (options.currentErrorAfterSave && calls.save > 0) throw new Error('secret-provider-key');
      return { ...selected };
    }, async saveSelection(next) {
      calls.save++; if (options.saveError) throw new Error('secret-provider-key');
      if (!options.noop) selected = { ...next };
    } },
    sessionController: { async modelCatalog() { calls.catalog++; if (options.catalogError) throw new Error('secret-provider-key'); return source; },
      selectModel() { throw new Error('Must not resume a Session'); }, initializeDefaultModel() { throw new Error('Must not initialize OAuth'); } },
    llm: { async resolveCallConfig(choice) { calls.resolve++; return options.resolved ?? choice; } },
  };
  return { api: createModelSettings(ctx), calls, current: () => ({ ...selected }) };
}
const original = { provider: 'openai-codex', model: 'gpt-6-sol', reasoningEffort: 'low' };
const request = { provider: 'openai-codex', model: 'model/alternate', expectedCurrent: original };

test('catalog is metadata-only and preserves explicit current effort without mutation', async () => {
  const { api, calls } = fixture();
  const result = await api.modelCatalog({});
  assert.deepEqual(result.current, original); assert.equal(result.writable, true);
  assert.equal(result.nextCursor, null); assert.deepEqual(calls, { catalog: 1, resolve: 0, save: 0 });
});
test('explicit selection validates, normalizes, awaits save and reads back', async () => {
  const { api, calls, current } = fixture();
  const result = await api.selectDefaultModel(request);
  assert.deepEqual(result, { profile: 'companion', current: { provider: 'openai-codex', model: 'model/alternate' }, scope: 'unconfigured-agents' });
  assert.deepEqual(result.current, current()); assert.deepEqual(calls, { catalog: 1, resolve: 1, save: 1 });
});
test('profile no-op, failed persistence and missing editor never claim a change', async () => {
  for (const options of [{ noop: true }, { saveError: true }, { noEditor: true }, { writable: false }]) {
    const f = fixture(options);
    await assert.rejects(f.api.selectDefaultModel(request), error => /^companion\/model-(save-unconfirmed|read-only)$/.test(error.code));
    assert.deepEqual(f.current(), original);
  }
});
test('unadvertised routes and efforts are refused before persistence', async () => {
  for (const choice of [{ ...request, provider: 'other' }, { ...request, model: 'secret' }, { ...request, reasoningEffort: 'high' },
    { ...request, model: 'gpt-6-sol', reasoningEffort: 'unknown' }]) {
    const f = fixture(); await assert.rejects(f.api.selectDefaultModel(choice), { code: 'companion/model-unavailable' });
    assert.equal(f.calls.save, 0);
  }
});
test('normalized adapter result cannot cross provider/model routes', async () => {
  const f = fixture({ resolved: { provider: 'other', model: 'model/alternate' } });
  await assert.rejects(f.api.selectDefaultModel(request), { code: 'companion/model-unavailable' }); assert.equal(f.calls.save, 0);
});
test('stale choices and serialized competing writes fail closed', async () => {
  const f = fixture();
  const values = await Promise.allSettled([f.api.selectDefaultModel(request), f.api.selectDefaultModel(request)]);
  assert.equal(values[0].status, 'fulfilled'); assert.equal(values[1].status, 'rejected');
  assert.equal(values[1].reason.code, 'companion/model-default-conflict'); assert.equal(f.calls.save, 1);
});
test('failure diagnostics and unknown provider metadata never cross the DTO', async () => {
  const catalog = { routableProviders: ['p'], groups: [{ id: 'p', name: 'Provider', apiKey: 'secret-key', models: [{ id: 'm', name: 'Model', cachedKeys: ['secret-key'] }] }], failures: [{ message: 'secret-key', id: 'broken' }] };
  const f = fixture({ catalog }); const result = await f.api.modelCatalog({});
  assert.equal(result.unavailableProviders, 1); assert.equal(JSON.stringify(result).includes('secret-key'), false);
  const failed = fixture({ catalogError: true }); await assert.rejects(failed.api.modelCatalog({}), error => error.code === 'companion/model-catalog-unavailable' && !error.message.includes('secret'));
});
test('large inventories paginate without dropping models and reject stale cursors', async () => {
  const catalog = { routableProviders: ['p'], failures: [], groups: [{ id: 'p', name: 'Provider', models: [...Array(500).keys()].map(index => ({ id: `model/${index}`, name: `Model ${index}`, description: 'd'.repeat(400) })) }] };
  const f = fixture({ catalog }); let cursor; const ids = [];
  do {
    const page = await f.api.modelCatalog(cursor ? { cursor } : {});
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MODEL_MAX_BYTES);
    ids.push(...page.groups.flatMap(group => group.models.map(model => model.id))); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 500); assert.equal(new Set(ids).size, 500);
  const page = await f.api.modelCatalog({ limit: 1 }); catalog.groups[0].models[0].name = 'Changed';
  await assert.rejects(f.api.modelCatalog({ cursor: page.nextCursor }), { code: 'companion/model-cursor-stale' });
});
test('strict requests reject unknown fields, null efforts, controls and sessions', () => {
  for (const value of [{ sessionId: 'real' }, { limit: null }, { limit: 0 }, { limit: 65 }, { cursor: 'bad' }]) assert.throws(() => parseModelCatalogRequest(value));
  for (const value of [{ ...request, sessionId: 'real' }, { ...request, reasoningEffort: null }, { ...request, model: 'x\n' }, { ...request, expectedCurrent: null }]) assert.throws(() => parseSelectDefaultModelRequest(value));
});
test('pre-admission cancellation prevents metadata resolution and mutation', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.api.selectDefaultModel(request, controller.signal));
  assert.deepEqual(f.calls, { catalog: 0, resolve: 0, save: 0 });
});
test('post-save default read failure or disappearance stays an uncertain write', async () => {
  for (const options of [{ currentErrorAfterSave: true }, { disappearAfterSave: true }]) {
    const f = fixture(options);
    await assert.rejects(f.api.selectDefaultModel(request), error =>
      error.code === 'companion/model-save-unconfirmed' && !error.message.includes('secret'));
    assert.equal(f.calls.save, 1);
  }
});
test('all new Remote faces have strict codecs', () => {
  assert.equal(Object.keys(modelCodecs).length, 4);
  for (const codec of Object.values(modelCodecs)) assert.equal(codec.mode, 'strict');
});
