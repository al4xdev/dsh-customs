import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolveHost } from '../common.mjs';
import { RECOVERY_CODES, DEFAULT_AUXILIARY } from './policy.mjs';

const plugin = await import(process.env.RESILIENCE_CONTROLLER_MODULE
  ? pathToFileURL(process.env.RESILIENCE_CONTROLLER_MODULE).href : './index.mjs');
const { Context } = await import(resolveHost('@deepseek-ai/cordis'));

async function configured(raw) {
  const ctx = new Context();
  const projections = [];
  ctx.provide('llm', {});
  ctx.provide('agents', {});
  ctx.provide('sessionProjections', { register(definition) { projections.push(definition); return () => {}; } });
  try {
    // Unlike direct apply(ctx, {}), native plugin loading applies Config first.
    // Schemastery's implicit [] used to disable every recoverable error here.
    await ctx.plugin(plugin, raw);
    const controller = ctx.get('llmRecoveryHistory');
    assert(controller, 'real native plugin must provide its readiness service');
    assert.equal(controller, ctx.get('llmRecovery'));
    assert.equal(controller, ctx.get('llmResilience'));
    assert.equal(controller.recoveryVersion, 2);
    assert.equal(controller.recoveryHistoryVersion, 2);
    assert(projections.some(definition => definition.key === 'llmRecoveryAccounting' && definition.stateVersion === 2));
    return { ctx, controller, async close() { await ctx.fiber.dispose(); } };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

test('native Config preserves absent lists rather than materializing opt-outs', () => {
  const parsed = plugin.Config({});
  assert(!Object.hasOwn(parsed.policy, 'retryableCodes'));
  assert(!Object.hasOwn(parsed.auxiliary, 'replaySafePurposes'));
  const sparse = plugin.Config({ providers: { arbitrary: { maxRetries: 2 } } });
  assert.deepEqual(sparse.providers.arbitrary, { maxRetries: 2 });
  assert(!Object.hasOwn(sparse.policy, 'retryableCodes'));
});

test('actual native plugin loading admits all default failures for generic and named providers', async () => {
  const h = await configured({});
  try {
    assert.deepEqual(h.controller.config.auxiliary.replaySafePurposes, DEFAULT_AUXILIARY.replaySafePurposes);
    for (const provider of ['arbitrary-provider', 'openai-codex', 'google-antigravity', 'deepseek-official', 'local-model']) {
      assert.deepEqual(h.controller.policyFor(provider).retryableCodes, RECOVERY_CODES);
      for (const code of RECOVERY_CODES) {
        const decision = h.controller.plan({ provider, failure: { code, ...(code === 'INVALID_REQUEST' ? { diagnosticCategory: 'malformed-tool-call' } : {}) } });
        assert(decision, `${provider}/${code} must remain globally eligible`);
        assert.equal(decision.retry, 1); assert.equal(decision.delayMs, 7031.25);
      }
    }
  } finally { await h.close(); }
});

test('native sparse provider overrides inherit error lists and preserve route caps', async () => {
  const h = await configured({ providers: { arbitrary: { maxRetries: 2 } } });
  try {
    assert.deepEqual(h.controller.policyFor('arbitrary').retryableCodes, RECOVERY_CODES);
    assert(h.controller.plan({ provider: 'arbitrary', failure: { code: 'TRANSPORT' }, previousRetry: 1 }));
    assert.equal(h.controller.plan({ provider: 'arbitrary', failure: { code: 'TRANSPORT' }, previousRetry: 2 }), undefined);
    assert(h.controller.plan({ provider: 'another', failure: { code: 'SERVER' }, previousRetry: 9 }));
  } finally { await h.close(); }
});

test('native explicit empty global lists are still opt-outs, not absent defaults', async () => {
  const h = await configured({ policy: { retryableCodes: [] }, auxiliary: { replaySafePurposes: [] } });
  try {
    assert.deepEqual(h.controller.policyFor('arbitrary').retryableCodes, []);
    assert.deepEqual(h.controller.config.auxiliary.replaySafePurposes, []);
    assert.equal(h.controller.plan({ provider: 'arbitrary', failure: { code: 'SERVER' } }), undefined);
  } finally { await h.close(); }
});

test('native explicit empty provider list disables only that route', async () => {
  const h = await configured({ providers: { disabled: { retryableCodes: [] } } });
  try {
    assert.equal(h.controller.plan({ provider: 'disabled', failure: { code: 'TRANSPORT' } }), undefined);
    assert(h.controller.plan({ provider: 'arbitrary', failure: { code: 'TRANSPORT' } }));
    assert.deepEqual(h.controller.config.auxiliary.replaySafePurposes, DEFAULT_AUXILIARY.replaySafePurposes);
  } finally { await h.close(); }
});

test('native explicit purpose selections and zero budgets retain their meaning', async () => {
  const h = await configured({ policy: { maxRetries: 0 }, auxiliary: { replaySafePurposes: ['session-title'] }, providers: { enabled: { maxRetries: 2 } } });
  try {
    assert.deepEqual(h.controller.config.auxiliary.replaySafePurposes, ['session-title']);
    assert.equal(h.controller.plan({ provider: 'disabled', failure: { code: 'SERVER' } }), undefined);
    assert(h.controller.plan({ provider: 'enabled', failure: { code: 'SERVER' } }));
  } finally { await h.close(); }
});
