import assert from 'node:assert/strict';
import test from 'node:test';
import { createController } from './controller.mjs';
import { MAX_DELAY_MS, QUOTA_CODE } from './policy.mjs';

function clock() {
  let id = 0;
  const timers = new Map();
  return { timers, setTimeout(callback, delay) { const handle = ++id; timers.set(handle, { callback, delay }); return handle; }, clearTimeout(handle) { timers.delete(handle); }, fire() { for (const [handle, timer] of [...timers]) { timers.delete(handle); timer.callback(); } } };
}
const failure = { code: 'SERVER', message: 'Opaque transient failure', status: 500 };
const nominal = [7031.25, 14062.5, 28125, 56250, 112500, 225000, 450000, 900000, 1800000, 3600000];

test('the approved ten decisions double to thirty then sixty minutes without an eleventh', async () => {
  const c = clock(), controller = createController({}, { clock: c });
  assert.equal(controller.recoveryVersion, 2);
  assert.equal(controller.recoveryHistoryVersion, 2);
  const plans = nominal.map((delayMs, previousRetry) => controller.plan({ provider: 'brand-new', failure, previousRetry }));
  assert.deepEqual(plans.map(plan => plan.delayMs), nominal);
  assert.deepEqual(plans.map(plan => plan.retry), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(plans[8].delayMs, 30 * 60 * 1000);
  assert.equal(plans[9].delayMs, 60 * 60 * 1000);
  assert.equal(plans.reduce((sum, plan) => sum + plan.delayMs, 0), 7192968.75);
  assert.equal(new Set(plans.map(plan => plan.policyKey)).size, 1);
  assert.equal(plans[0].phase, 'recovery');
  assert(Object.isFrozen(plans[0]) && Object.isFrozen(plans[0].policy));
  assert.equal(c.timers.size, 0);
  assert.equal(controller.plan({ provider: 'brand-new', failure, previousRetry: 10 }), undefined);
  for (const previousRetry of [-1, .5, Infinity, NaN]) assert.equal(controller.plan({ provider: 'brand-new', failure, previousRetry }), undefined);
  await controller.dispose();
  assert.equal(controller.plan({ provider: 'brand-new', failure }), undefined);
});

for (const [sample, factor] of [[0, .9], [1, 1.1]]) test(`explicit jitter ${sample} is optional and still respects the hour ceiling`, () => {
  const controller = createController({ policy: { jitterRatio: .1 } }, { random: () => sample });
  assert.deepEqual(nominal.map((_, previousRetry) => controller.plan({ provider: 'x', failure, previousRetry }).delayMs), nominal.map(delay => Math.min(delay * factor, MAX_DELAY_MS)));
  assert.equal(controller.plan({ provider: 'x', failure: { ...failure, providerRetryAfterMs: 1 } }).delayMs, nominal[0] * factor);
});

test('server minima never shorten exponential waits or bypass the shared hour ceiling', () => {
  const controller = createController();
  for (const hint of [1, 5000, 30000, MAX_DELAY_MS]) assert.equal(controller.plan({ provider: 'x', failure: { ...failure, providerRetryAfterMs: hint } }).delayMs, Math.max(nominal[0], hint));
  assert.equal(controller.plan({ provider: 'x', previousRetry: 8, failure: { ...failure, providerRetryAfterMs: 30000 } }).delayMs, nominal[8]);
  for (const hint of [null, 0, -1, NaN, Infinity, '1000', MAX_DELAY_MS + 1]) assert.equal(controller.plan({ provider: 'x', failure: { ...failure, providerRetryAfterMs: hint } }), undefined);
});

test('AGY reset facts share ten attempts and the same hour ceiling, never a 24h timer', () => {
  const controller = createController();
  const registeredPolicy = { mode: 'normal', maxRetries: 9, retryableCodes: [QUOTA_CODE] };
  const policy = controller.policyFor('google-antigravity', registeredPolicy);
  const plans = [];
  for (let previousRetry = 0; previousRetry < 10; previousRetry++) plans.push(controller.plan({ provider: 'google-antigravity', policy, registeredPolicy, previousRetry, failure: previousRetry % 2 ? failure : { code: QUOTA_CODE, providerRetryAfterMs: MAX_DELAY_MS } }));
  assert.equal(new Set(plans.map(plan => plan.policyKey)).size, 1);
  assert.deepEqual(plans.map(plan => plan.retry), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(plans[0].delayMs, MAX_DELAY_MS);
  assert.equal(controller.plan({ provider: 'google-antigravity', policy, registeredPolicy, previousRetry: 10, failure }), undefined);
  for (const hint of [undefined, null, 0, -1, Infinity, NaN, MAX_DELAY_MS + 1, 86400000, '1000']) assert.equal(controller.plan({ provider: 'google-antigravity', policy, registeredPolicy, failure: { code: QUOTA_CODE, providerRetryAfterMs: hint } }), undefined);
  for (const [provider, registered] of [['other', registeredPolicy], ['google-antigravity', undefined]]) assert.equal(controller.plan({ provider, registeredPolicy: registered, failure: { code: QUOTA_CODE, providerRetryAfterMs: 1 } }), undefined);
});

test('opaque recovery is admitted but opt-outs, permanent facts and arbitrary invalid requests cannot be bypassed', () => {
  const controller = createController();
  assert.equal(controller.plan({ provider: 'x', registeredPolicy: { mode: 'normal', maxRetries: 0 }, failure }), undefined);
  assert.equal(controller.plan({ provider: 'x', failure: { code: 'PI_AI_ERROR', status: 503 } }).retry, 1);
  assert.equal(controller.plan({ provider: 'x', failure: { code: 'INVALID_REQUEST' } }), undefined);
  assert.equal(controller.plan({ provider: 'x', failure: { code: 'INVALID_REQUEST', diagnosticCategory: 'malformed-tool-call' } }).retry, 1);
  assert.equal(controller.plan({ provider: 'x', failure: { ...failure, status: 401 } }), undefined);
  for (const status of [600, '503', null, NaN, Infinity, 599.5]) assert.equal(controller.plan({ provider: 'x', failure: { ...failure, status } }), undefined);
  assert.equal(controller.plan({ provider: 'x', failure: { ...failure, invalidFailureFacts: true } }), undefined);
  assert.equal(controller.plan({ provider: 'x', registeredPolicy: { mode: 'normal', maxRetries: 0 }, policy: controller.policyFor('x'), failure }), undefined);
  const supplied = { ...controller.policyFor('x'), retryableCodes: ['SERVER'] };
  const plan = controller.plan({ provider: 'x', failure, policy: supplied });
  supplied.retryableCodes.push('PI_AI_ERROR'); supplied.maxRetries = Infinity;
  assert.deepEqual(plan.policy.retryableCodes, ['SERVER']); assert.equal(plan.policy.maxRetries, 10);
  assert.equal(controller.plan({ provider: 'x', failure, policy: supplied }), undefined);
});

test('captured legacy policies cannot widen current caps or evade a new explicit opt-out', () => {
  const controller = createController({ policy: { maxRetries: 2, maxDelayMs: 30000 } });
  const old = { ...controller.policyFor('x'), maxRetries: 99, initialDelayMs: 5000, maxDelayMs: 86400000 };
  const plan = controller.plan({ provider: 'x', failure, policy: old });
  assert.equal(plan.policy.maxRetries, 2); assert.equal(plan.policy.maxDelayMs, 30000);
  assert.equal(controller.plan({ provider: 'x', failure, policy: old, previousRetry: 2 }), undefined);
  const disabled = createController({ providers: { x: { maxRetries: 0 } } });
  assert.equal(disabled.plan({ provider: 'x', failure, policy: old }), undefined);
});

test('the deprecated semantic view is the same ten-interval algorithm, not another budget', () => {
  const controller = createController();
  const plans = nominal.map((_, index) => controller.selfHealPlan(index + 1));
  assert.deepEqual(plans.map(plan => plan.delayMs), nominal);
  assert(plans.every(plan => plan.phase === 'self-heal' && Object.isFrozen(plan)));
  assert.deepEqual(controller.selfHealPlan(1), plans[0]);
  for (const cycle of [0, 11, -1, 1.2, Infinity]) assert.equal(controller.selfHealPlan(cycle), undefined);
});

test('wait rounds up fractional timer minima and drains on caller cancellation or disposal', async () => {
  const c = clock(), controller = createController({}, { clock: c });
  const plan = controller.selfHealPlan(1);
  const elapsed = controller.wait(plan);
  assert.equal(c.timers.size, 1); assert.equal([...c.timers.values()][0].delay, 7032);
  c.fire(); assert.equal(await elapsed, true); assert.equal(c.timers.size, 0);
  const aborted = new AbortController(); aborted.abort(); assert.equal(await controller.wait(plan, aborted.signal), false); assert.equal(c.timers.size, 0);
  const caller = new AbortController(); const cancelled = controller.wait(plan, caller.signal); caller.abort(); assert.equal(await cancelled, false); assert.equal(c.timers.size, 0);
  const pending = Array.from({ length: 32 }, () => controller.wait(plan));
  assert.equal(c.timers.size, 32);
  await controller.dispose(); assert.deepEqual(await Promise.all(pending), Array(32).fill(false)); assert.equal(c.timers.size, 0);
  assert.equal(await controller.wait(plan), false); assert.equal(controller.signal.aborted, true);
  assert.equal(await controller.wait({ delayMs: MAX_DELAY_MS + 1 }), false);
});

test('timer setup failures reject without leaked waits', async () => {
  const controller = createController({}, { setTimeout() { throw new Error('clock failed'); }, clearTimeout() {} });
  await assert.rejects(controller.wait(controller.selfHealPlan(1)), /clock failed/);
  await controller.dispose();
});
