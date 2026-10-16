import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelCatalogOutput, parseSelectDefaultModelOutput } from './models.mjs';

function page() { return { profile: 'companion', current: { provider: 'p', model: 'm' }, groups: [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }] }], routableProviders: ['p'], writable: true, unavailableProviders: 0, nextCursor: null }; }

test('output codecs reject nested credential metadata and duplicate routes', () => {
  for (const mutate of [
    value => { value.groups[0].apiKey = 'secret'; },
    value => { value.groups[0].models[0].cachedKeys = ['secret']; },
    value => { value.groups[0].models[0].reasoning.efforts[0].key = 'secret'; },
    value => { value.groups[0].models.push(value.groups[0].models[0]); },
    value => { value.routableProviders.push('p'); },
    value => { value.current.token = 'secret'; },
    value => { value.groups[0].name = 'x'.repeat(129); },
    value => { value.groups[0].models[0].description = 'x'.repeat(161); },
    value => { value.groups[0].models[0].reasoning.defaultEffort = 'unsupported'; },
  ]) {
    const value = page(); mutate(value); assert.throws(() => parseModelCatalogOutput(value));
  }
});
test('strict output accepts page metadata but never promises a session mutation', () => {
  assert.deepEqual(parseModelCatalogOutput(page()), page());
  assert.deepEqual(parseSelectDefaultModelOutput({ profile: 'companion', current: { provider: 'p', model: 'm' }, scope: 'unconfigured-agents' }),
    { profile: 'companion', current: { provider: 'p', model: 'm' }, scope: 'unconfigured-agents' });
  assert.throws(() => parseSelectDefaultModelOutput({ profile: 'companion', current: { provider: 'p', model: 'm' }, scope: 'session' }));
});
