import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject, name } from './retired.mjs';

test('retired quota compatibility marker fails closed without unified contract2', () => {
  assert.deepEqual(inject, []);
  assert.equal(name, 'antigravity-quota-retry-retired');
  for (const service of [undefined, { recoveryVersion: 1, plan() {}, wait() {} }, { recoveryVersion: 2 }]) {
    assert.throws(() => apply({ get: () => service }), /retired.*contract2/);
  }
});

test('retired quota marker never registers a second budget, timer or recovery hook', () => {
  const calls = [];
  const ctx = {
    get(key) { calls.push(key); return { recoveryVersion: 2, plan() { assert.fail('delegated planner must not run during mount'); }, wait() { assert.fail('second timer'); } }; },
    on() { assert.fail('second recovery hook'); },
    effect() { assert.fail('second lifecycle owner'); },
    sessionProjections: { register() { assert.fail('second accounting projection'); } },
  };
  assert.equal(apply(ctx), undefined);
  assert.deepEqual(calls, ['llmResilience']);
});

test('retired quota marker cannot restore the independent24h configuration', () => {
  for (const config of [null, [], { maxQuotaWaitMs: 86_400_000 }, { enabled: true }]) {
    assert.throws(() => apply({ get() { assert.fail('configuration refused first'); } }, config), /retired.*shared/);
  }
});
