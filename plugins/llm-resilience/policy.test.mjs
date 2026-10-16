import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_POLICY, QUOTA_CODE, isEligibleFailure, policyFromKey, policyKey, resolveConfig, resolvePolicy } from './policy.mjs';

const defaults = resolveConfig();
const resolve = (provider, registered) => resolvePolicy(defaults, provider, registered);

test('every route inherits one global baseline independently of native resolved defaults', () => {
  for (const provider of ['unregistered-new-route', 'strata-local', 'openai-codex', 'google-antigravity', 'native']) {
    for (const registered of [undefined, { mode: 'normal', maxRetries: 5, initialDelayMs: 500, maxDelayMs: 10000, retryableCodes: ['SERVER'] }, { mode: 'always', initialDelayMs: 3, maxDelayMs: 4 }]) {
      const policy = resolve(provider, registered);
      for (const field of Object.keys(DEFAULT_POLICY)) assert.deepEqual(policy[field], DEFAULT_POLICY[field]);
      assert.equal(Object.isFrozen(policy), true);
      assert.equal(Object.isFrozen(policy.retryableCodes), true);
      assert.equal(Object.isFrozen(policy.sourceExtension), true);
    }
  }
  assert.equal(defaults.auxiliary.maxBufferBytes, 16777216);
  assert.deepEqual(defaults.auxiliary.replaySafePurposes, ['compaction', 'session-title']);
  assert.deepEqual(defaults.selfHeal, { maxCycles: 10, initialDelayMs: 7031.25, maxDelayMs: 3600000, jitterRatio: 0 });
});

test('sparse explicit global/provider patches detach inputs; normal zero is always honored', () => {
  const input = { policy: { maxRetries: 7, initialDelayMs: 100 }, providers: { local: { maxRetries: 2 } }, auxiliary: { replaySafePurposes: ['summary'] } };
  const config = resolveConfig(input);
  input.policy.initialDelayMs = 999;
  input.auxiliary.replaySafePurposes.push('unsafe');
  const effective = resolvePolicy(config, 'local', { mode: 'normal', maxRetries: 5 });
  assert.equal(effective.maxRetries, 2); assert.equal(effective.initialDelayMs, 100); assert.equal(effective.maxDelayMs, 3600000);
  assert.equal(resolvePolicy(config, 'other').maxRetries, 7);
  assert.equal(resolvePolicy(config, 'local', { mode: 'normal', maxRetries: 0 }).maxRetries, 0);
  assert.deepEqual(config.auxiliary.replaySafePurposes, ['summary']);
  assert.equal(Object.isFrozen(config.providers.local), true);
  assert.equal(resolvePolicy(config, 'constructor').maxRetries, 7);
});

test('quota extension requires exact provider and registered captured normal code gate', () => {
  const registered = { mode: 'normal', maxRetries: 5, retryableCodes: [QUOTA_CODE] };
  for (const [provider, policy, expected] of [['google-antigravity', registered, true], ['other', registered, false], ['google-antigravity', undefined, false], ['google-antigravity', { mode: 'always', retryableCodes: [QUOTA_CODE] }, false]]) {
    const effective = resolve(provider, policy);
    assert.equal(effective.sourceExtension.antigravityQuotaReset, expected);
    assert.equal(effective.retryableCodes.includes(QUOTA_CODE), expected);
    assert.equal(effective.maxRetries, 10);
  }
});

test('unknown/permanent/cancel/auth/context codes and conflicting permanent facts fail closed', () => {
  const policy = resolve('new');
  for (const code of ['UNKNOWN', 'AUTH', 'QUOTA_EXCEEDED', 'ABORTED', 'CONTEXT_LENGTH', 'POLICY', 'IMAGE_OFFLOAD_REQUIRED', 'INVALID_REQUEST']) assert.equal(isEligibleFailure('new', { code }, policy), false);
  for (const extra of [{ status: 401 }, { status: 403 }, { status: 400 }, { status: 413 }, { status: 600 }, { status: 0 }, { status: NaN }, { status: Infinity }, { status: '503' }, { status: 500.5 }, { invalidFailureFacts: true }, { category: 'auth' }, { category: 'permanent' }, { category: 'cancelled' }, { cancelled: true }, { aborted: true }, { permanent: true }]) assert.equal(isEligibleFailure('new', { code: 'SERVER', ...extra }, policy), false);
  for (const failure of [{ code: 'SERVER', status: 503 }, { code: 'RATE_LIMIT', status: 429 }, { code: 'TIMEOUT', status: 408 }, { code: 'TRANSPORT' }, { code: 'PI_AI_ERROR', status: 503 }, { code: 'INVALID_REQUEST', diagnosticCategory: 'malformed-tool-call' }]) assert.equal(isEligibleFailure('new', failure, policy), true);
});

test('native finite keys roundtrip captured budgets without provider-default heuristics', () => {
  for (const provider of ['new', 'google-antigravity']) {
    const policy = resolve(provider, { mode: 'normal', retryableCodes: [QUOTA_CODE] });
    const key = policyKey(policy);
    assert.equal(policyKey(policyFromKey(provider, key)), key);
    assert.equal(policyFromKey(provider, key).maxRetries, 10);
  }
  for (const key of ['null', '{}', '["always",5,10,0.1]', '["normal",-1,[],1,1,0]', '["normal",1,[],10,1,0]', '["normal",1,[],1,1,0,"extra"]']) assert.equal(policyFromKey('new', key), undefined);
});

test('configuration rejects misspellings, unknown codes, invalid or unbounded values', () => {
  for (const config of [{ retryPolicy: {} }, { policy: { backoff: {} } }, { policy: { mode: 'always' } }, { policy: { retryableCodes: ['UNKNOWN'] } }, { policy: { maxRetries: Infinity } }, { policy: { maxRetries: -1 } }, { policy: { maxRetries: 1.2 } }, { policy: { maxRetries: 11 } }, { policy: { jitterRatio: 2 } }, { policy: { initialDelayMs: 3600001 } }, { policy: { maxDelayMs: 3600001 } }, { auxiliary: { maxChunks: 0 } }, { auxiliary: { maxBufferBytes: Infinity } }, { selfHeal: { maxCycles: -1 } }, { selfHeal: { initialDelayMs: 30000 } }, { policy: null }, { providers: null }]) assert.throws(() => resolveConfig(config), TypeError);
});

test('self-heal compatibility fields cannot create a second backoff or extra allowance', () => {
  const config = resolveConfig({ policy: { maxRetries: 7, initialDelayMs: 100 }, selfHeal: { maxCycles: 3, initialDelayMs: 100 } });
  assert.deepEqual(config.selfHeal, { maxCycles: 3, initialDelayMs: 100, maxDelayMs: 3600000, jitterRatio: 0 });
  assert.equal(config.policy.maxRetries, 7);
  assert.equal(resolveConfig({ policy: { maxRetries: 2 }, selfHeal: { maxCycles: 3 } }).selfHeal.maxCycles, 2);
  for (const key of ['initialDelayMs', 'maxDelayMs', 'jitterRatio']) assert.throws(() => resolveConfig({ selfHeal: { [key]: .5 } }), /one backoff/);
});

test('main admission derives a route envelope, never an accidental second base-policy ceiling', () => {
  for (const base of [0, 7]) {
    const config = resolveConfig({ policy: { maxRetries: base }, providers: { enabled: { maxRetries: 9 }, disabled: { maxRetries: 0 }, narrowed: { maxRetries: 3 } } });
    assert.equal(config.selfHeal.maxCycles, 9);
    assert.equal(resolvePolicy(config, 'enabled').maxRetries, 9);
    assert.equal(resolvePolicy(config, 'disabled').maxRetries, 0);
    assert.equal(resolvePolicy(config, 'narrowed').maxRetries, 3);
    assert.equal(resolvePolicy(config, 'unlisted').maxRetries, base);
    assert.equal(resolvePolicy(config, 'enabled', { mode: 'normal', maxRetries: 0 }).maxRetries, 0);
  }
  assert.equal(resolveConfig({ policy: { maxRetries: 0 }, providers: { enabled: { maxRetries: 9 } }, selfHeal: { maxCycles: 3 } }).selfHeal.maxCycles, 3);
});
