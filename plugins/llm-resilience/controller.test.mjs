import assert from 'node:assert/strict';
import test from 'node:test';
import { createController, REFUSAL_REASONS, WALL_CLOCK_SLICE_MS } from './controller.mjs';
import { MAX_DELAY_MS, MAX_PROVIDER_WAIT_MS, QUOTA_CODE, UNBOUNDED_RETRIES } from './policy.mjs';

function clock() {
  let id = 0, time = 0, wall = 1_800_000_000_000;
  const timers = new Map();
  // `now` is the monotonic view; `sleep` moves only the wall clock (suspend).
  return { timers, now: () => time, wallNow: () => wall, advance(ms) { time += ms; wall += ms; }, sleep(ms) { wall += ms; }, setTimeout(callback, delay) { const handle = ++id; timers.set(handle, { callback, delay }); return handle; }, clearTimeout(handle) { timers.delete(handle); }, fire() { for (const [handle, timer] of [...timers]) { timers.delete(handle); timer.callback(); } } };
}
const failure = { code: 'SERVER', message: 'Opaque transient failure', status: 500 };
const nominal = [7031.25, 14062.5, 28125, 56250, 112500, 225000, 450000, 900000, 1800000, 3600000];

test('the first ten decisions double to thirty then sixty minutes; later retries stay at the hour cap forever', async () => {
  const c = clock(), controller = createController({}, { clock: c });
  assert.equal(controller.recoveryVersion, 3);
  assert.equal(controller.recoveryHistoryVersion, 3);
  assert.equal(controller.config.policy.maxRetries, UNBOUNDED_RETRIES);
  const plans = nominal.map((delayMs, previousRetry) => controller.plan({ provider: 'brand-new', failure, previousRetry }));
  assert.deepEqual(plans.map(plan => plan.delayMs), nominal);
  assert.deepEqual(plans.map(plan => plan.retry), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(plans[8].delayMs, 30 * 60 * 1000);
  assert.equal(plans[9].delayMs, 60 * 60 * 1000);
  assert.equal(plans.reduce((sum, plan) => sum + plan.delayMs, 0), 7192968.75);
  // Retry 11, 12, 100 and 10000: same policy key, same 60-minute interval.
  for (const previousRetry of [10, 11, 99, 9999]) {
    const later = controller.plan({ provider: 'brand-new', failure, previousRetry });
    assert.equal(later.retry, previousRetry + 1); assert.equal(later.delayMs, MAX_DELAY_MS); assert.equal(later.policyKey, plans[0].policyKey);
  }
  assert.equal(new Set(plans.map(plan => plan.policyKey)).size, 1);
  assert.equal(plans[0].phase, 'recovery'); assert.equal(plans[0].kind, 'wait');
  assert(Object.isFrozen(plans[0]) && Object.isFrozen(plans[0].policy));
  assert.equal(c.timers.size, 0);
  for (const previousRetry of [-1, .5, Infinity, NaN]) assert.deepEqual(controller.schedule({ provider: 'brand-new', failure, previousRetry }), { kind: 'refused', reason: 'invalid-retry-ordinal' });
  await controller.dispose();
  assert.deepEqual(controller.schedule({ provider: 'brand-new', failure }), { kind: 'refused', reason: 'controller-disposed' });
});

test('explicit finite caps are still honored exactly, including the old ten', () => {
  for (const maxRetries of [1, 3, 10, 11]) {
    const controller = createController({ policy: { maxRetries } });
    assert(controller.plan({ provider: 'x', failure, previousRetry: maxRetries - 1 }));
    assert.deepEqual(controller.schedule({ provider: 'x', failure, previousRetry: maxRetries }), { kind: 'refused', reason: 'retry-budget-exhausted' });
  }
  const route = createController({ providers: { local: { maxRetries: 2 } } });
  assert.equal(route.plan({ provider: 'local', failure, previousRetry: 2 }), undefined);
  assert(route.plan({ provider: 'other', failure, previousRetry: 50 }), 'unlisted routes stay unbounded');
});

for (const [sample, factor] of [[0, .9], [1, 1.1]]) test(`explicit jitter ${sample} is optional and still respects the hour ceiling`, () => {
  const controller = createController({ policy: { jitterRatio: .1 } }, { random: () => sample });
  assert.deepEqual(nominal.map((_, previousRetry) => controller.plan({ provider: 'x', failure, previousRetry }).delayMs), nominal.map(delay => Math.min(delay * factor, MAX_DELAY_MS)));
  assert.equal(controller.plan({ provider: 'x', failure: { ...failure, providerRetryAfterMs: 1 } }).delayMs, nominal[0] * factor);
});

test('provider minima extend (never shorten) the local interval, generically for any provider, up to the 24h wait cap', () => {
  const controller = createController();
  for (const provider of ['x', 'vertex-fixture', 'openai-codex']) {
    for (const hint of [1, 5000, 30000, MAX_DELAY_MS, MAX_DELAY_MS + 1, 2 * MAX_DELAY_MS, MAX_PROVIDER_WAIT_MS]) {
      const plan = controller.plan({ provider, failure: { ...failure, code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: hint } });
      assert.equal(plan.delayMs, Math.max(nominal[0], hint)); assert.equal(plan.minimumDelayMs, hint);
    }
    assert.deepEqual(controller.schedule({ provider, failure: { ...failure, providerRetryAfterMs: MAX_PROVIDER_WAIT_MS + 1 } }), { kind: 'refused', reason: 'provider-wait-over-cap' });
  }
  assert.equal(controller.plan({ provider: 'x', previousRetry: 8, failure: { ...failure, providerRetryAfterMs: 30000 } }).delayMs, nominal[8]);
  // Malformed/zero minima are not terminal: they fall back to the local schedule.
  for (const hint of [null, 0, -1, NaN, Infinity, '1000']) {
    const plan = controller.plan({ provider: 'x', failure: { ...failure, providerRetryAfterMs: hint } });
    assert.equal(plan.delayMs, nominal[0]); assert.equal(plan.minimumDelayMs, undefined);
  }
});

test('an explicit lower provider-wait ceiling suspends long minima; a route may set its own', () => {
  const controller = createController({ policy: { maxProviderWaitMs: 2 * MAX_DELAY_MS }, providers: { patient: { maxProviderWaitMs: MAX_PROVIDER_WAIT_MS } } });
  assert.equal(controller.plan({ provider: 'x', failure: { ...failure, providerRetryAfterMs: 2 * MAX_DELAY_MS } }).delayMs, 2 * MAX_DELAY_MS);
  assert.equal(controller.schedule({ provider: 'x', failure: { ...failure, providerRetryAfterMs: 2 * MAX_DELAY_MS + 1 } }).reason, 'provider-wait-over-cap');
  assert.equal(controller.plan({ provider: 'patient', failure: { ...failure, providerRetryAfterMs: 20 * MAX_DELAY_MS } }).delayMs, 20 * MAX_DELAY_MS);
  // The hour cap is a floor for the ceiling: minima up to maxDelayMs always pass.
  const short = createController({ policy: { maxProviderWaitMs: 1 } });
  assert.equal(short.plan({ provider: 'x', failure: { ...failure, providerRetryAfterMs: MAX_DELAY_MS } }).delayMs, MAX_DELAY_MS);
  for (const maxProviderWaitMs of [0, MAX_PROVIDER_WAIT_MS + 1, Infinity]) assert.throws(() => createController({ policy: { maxProviderWaitMs } }), TypeError);
});

test('AGY reset facts (an adapter-typed minimum) share the one counter and wait until the reset up to 24h', () => {
  const controller = createController();
  const registeredPolicy = { mode: 'normal', maxRetries: 9, retryableCodes: [QUOTA_CODE] };
  const policy = controller.policyFor('google-antigravity', registeredPolicy);
  const plans = [];
  for (let previousRetry = 0; previousRetry < 14; previousRetry++) plans.push(controller.plan({ provider: 'google-antigravity', policy, registeredPolicy, previousRetry, failure: previousRetry % 2 ? failure : { code: QUOTA_CODE, providerRetryAfterMs: 5 * MAX_DELAY_MS } }));
  assert.equal(new Set(plans.map(plan => plan.policyKey)).size, 1);
  assert.deepEqual(plans.map(plan => plan.retry), Array.from({ length: 14 }, (_, i) => i + 1));
  assert.equal(plans[0].delayMs, 5 * MAX_DELAY_MS); assert.equal(plans[12].delayMs, 5 * MAX_DELAY_MS); assert.equal(plans[13].delayMs, MAX_DELAY_MS);
  assert.equal(controller.schedule({ provider: 'google-antigravity', policy, registeredPolicy, failure: { code: QUOTA_CODE, providerRetryAfterMs: MAX_PROVIDER_WAIT_MS + 1 } }).reason, 'provider-wait-over-cap');
  for (const hint of [undefined, null, 0, -1, Infinity, NaN, '1000']) assert.equal(controller.schedule({ provider: 'google-antigravity', policy, registeredPolicy, failure: { code: QUOTA_CODE, providerRetryAfterMs: hint } }).reason, 'quota-reset-without-hint');
  for (const [provider, registered] of [['other', registeredPolicy], ['google-antigravity', undefined]]) assert.equal(controller.plan({ provider, registeredPolicy: registered, failure: { code: QUOTA_CODE, providerRetryAfterMs: 1 } }), undefined);
});

test('opaque recovery is admitted but opt-outs, permanent facts and arbitrary invalid requests cannot be bypassed', () => {
  const controller = createController();
  assert.deepEqual(controller.schedule({ provider: 'x', registeredPolicy: { mode: 'normal', maxRetries: 0 }, failure }), { kind: 'refused', reason: 'route-opt-out' });
  assert.equal(controller.plan({ provider: 'x', failure: { code: 'PI_AI_ERROR', status: 503 } }).retry, 1);
  assert.equal(controller.schedule({ provider: 'x', failure: { code: 'INVALID_REQUEST' } }).reason, 'ineligible-failure');
  assert.equal(controller.plan({ provider: 'x', failure: { code: 'INVALID_REQUEST', diagnosticCategory: 'malformed-tool-call' } }).retry, 1);
  assert.equal(controller.plan({ provider: 'x', failure: { ...failure, status: 401 } }), undefined);
  for (const status of [600, '503', null, NaN, Infinity, 599.5]) assert.equal(controller.plan({ provider: 'x', failure: { ...failure, status } }), undefined);
  assert.equal(controller.plan({ provider: 'x', failure: { ...failure, invalidFailureFacts: true } }), undefined);
  assert.equal(controller.plan({ provider: 'x', registeredPolicy: { mode: 'normal', maxRetries: 0 }, policy: controller.policyFor('x'), failure }), undefined);
  assert.equal(createController({ policy: { maxRetries: 0 } }).schedule({ provider: 'x', failure }).reason, 'retries-disabled');
  const supplied = { ...controller.policyFor('x'), retryableCodes: ['SERVER'] };
  const plan = controller.plan({ provider: 'x', failure, policy: supplied });
  supplied.retryableCodes.push('PI_AI_ERROR'); supplied.maxRetries = Infinity;
  assert.deepEqual(plan.policy.retryableCodes, ['SERVER']); assert.equal(plan.policy.maxRetries, UNBOUNDED_RETRIES);
  assert.equal(controller.schedule({ provider: 'x', failure, policy: supplied }).reason, 'unrepresentable-policy');
  for (const reason of ['route-opt-out', 'provider-wait-over-cap', 'retry-budget-exhausted']) assert(REFUSAL_REASONS.includes(reason));
});

test('captured legacy policies cannot widen current caps or evade a new explicit opt-out', () => {
  const controller = createController({ policy: { maxRetries: 2, maxDelayMs: 30000 } });
  const old = { ...controller.policyFor('x'), maxRetries: 99, initialDelayMs: 5000, maxDelayMs: 86400000 };
  const plan = controller.plan({ provider: 'x', failure, policy: old });
  assert.equal(plan.policy.maxRetries, 2); assert.equal(plan.policy.maxDelayMs, 30000);
  assert.equal(controller.plan({ provider: 'x', failure, policy: old, previousRetry: 2 }), undefined);
  const disabled = createController({ providers: { x: { maxRetries: 0 } } });
  assert.equal(disabled.plan({ provider: 'x', failure, policy: old }), undefined);
  // A pinned old finite chain (cap 10) stays finite under the unbounded default.
  const pinned = createController().plan({ provider: 'x', failure, policy: { ...createController().policyFor('x'), maxRetries: 10 }, previousRetry: 9 });
  assert.equal(pinned.policy.maxRetries, 10);
  assert.equal(createController().plan({ provider: 'x', failure, policy: pinned.policy, previousRetry: 10 }), undefined);
});

test('the deprecated semantic view is the same interval algorithm, not another budget', () => {
  const controller = createController();
  const plans = nominal.map((_, index) => controller.selfHealPlan(index + 1));
  assert.deepEqual(plans.map(plan => plan.delayMs), nominal);
  assert(plans.every(plan => plan.phase === 'self-heal' && Object.isFrozen(plan)));
  assert.deepEqual(controller.selfHealPlan(1), plans[0]);
  assert.equal(controller.selfHealPlan(11).delayMs, MAX_DELAY_MS);
  for (const cycle of [0, -1, 1.2, Infinity]) assert.equal(controller.selfHealPlan(cycle), undefined);
  assert.equal(createController({ policy: { maxRetries: 10 } }).selfHealPlan(11), undefined);
});

test('wait rounds up fractional timer minima, accepts provider waits up to 24h and drains on caller cancellation or disposal', async () => {
  const c = clock(), controller = createController({}, { clock: c });
  const plan = controller.selfHealPlan(1);
  const elapsed = controller.wait(plan);
  assert.equal(c.timers.size, 1); assert.equal([...c.timers.values()][0].delay, 7032);
  c.fire(); assert.equal(await elapsed, true); assert.equal(c.timers.size, 0);
  const long = controller.wait({ delayMs: MAX_PROVIDER_WAIT_MS });
  assert.equal([...c.timers.values()][0].delay, MAX_PROVIDER_WAIT_MS); c.fire(); assert.equal(await long, true);
  assert.equal(await controller.wait({ delayMs: MAX_PROVIDER_WAIT_MS + 1 }), false);
  const aborted = new AbortController(); aborted.abort(); assert.equal(await controller.wait(plan, aborted.signal), false); assert.equal(c.timers.size, 0);
  const caller = new AbortController(); const cancelled = controller.wait(plan, caller.signal); caller.abort(); assert.equal(await cancelled, false); assert.equal(c.timers.size, 0);
  const pending = Array.from({ length: 32 }, () => controller.wait(plan));
  assert.equal(c.timers.size, 32);
  await controller.dispose(); assert.deepEqual(await Promise.all(pending), Array(32).fill(false)); assert.equal(c.timers.size, 0);
  assert.equal(await controller.wait(plan), false); assert.equal(controller.signal.aborted, true);
});

test('a wake ends the local backoff now but never before a provider-declared minimum', async () => {
  const c = clock(), controller = createController({}, { clock: c });
  const local = controller.plan({ provider: 'x', failure, previousRetry: 9 });
  const wake = new AbortController();
  const woken = controller.wait(local, undefined, { wake: wake.signal });
  assert.equal([...c.timers.values()][0].delay, MAX_DELAY_MS);
  wake.abort(); assert.equal(await woken, true); assert.equal(c.timers.size, 0);
  const minimum = controller.plan({ provider: 'x', failure: { ...failure, providerRetryAfterMs: 2 * MAX_DELAY_MS } });
  const second = new AbortController();
  const bounded = controller.wait(minimum, undefined, { wake: second.signal });
  c.advance(1000); second.abort();
  assert.equal(c.timers.size, 1); assert.equal([...c.timers.values()][0].delay, 2 * MAX_DELAY_MS - 1000, 'the remaining provider minimum still holds');
  c.fire(); assert.equal(await bounded, true);
  const early = new AbortController(); early.abort();
  assert.equal(await controller.wait(local, undefined, { wake: early.signal }), true, 'an already-aborted wake skips the local backoff');
  const caller = new AbortController(), third = new AbortController();
  const cancelled = controller.wait(minimum, caller.signal, { wake: third.signal });
  third.abort(); caller.abort(); assert.equal(await cancelled, false); assert.equal(c.timers.size, 0);
  await controller.dispose();
});

test('a wake re-arm can never exceed the original wait, even if the clock steps back', async () => {
  const c = clock(), controller = createController({}, { clock: c });
  const plan = controller.plan({ provider: 'x', failure: { ...failure, providerRetryAfterMs: 600_000 } });
  const wake = new AbortController(); let woken = 0;
  const pending = controller.wait(plan, undefined, { wake: wake.signal, onWoken: () => woken++ });
  c.advance(-3_600_000); wake.abort();
  assert.equal(woken, 1); assert.equal([...c.timers.values()][0].delay, Math.ceil(plan.delayMs), 'clamped to the original delay');
  c.fire(); assert.equal(await pending, true);
  // A wake after the wait settled is not attributed.
  const late = new AbortController(); let lateWoken = 0;
  const done = controller.wait(controller.plan({ provider: 'x', failure }), undefined, { wake: late.signal, onWoken: () => lateWoken++ });
  c.fire(); assert.equal(await done, true); late.abort(); assert.equal(lateWoken, 0);
  await controller.dispose();
});

test('real-timer waits are sliced and finish by wall clock after a system suspend', async () => {
  assert.equal(WALL_CLOCK_SLICE_MS, 60_000);
  const c = clock(), controller = createController({}, { clock: c, wallClockSliceMs: WALL_CLOCK_SLICE_MS });
  // Elapse the pending slice (or, with mono=false, only deliver it) then run it.
  const fire = (mono = true) => { const [[handle, timer]] = [...c.timers]; c.timers.delete(handle); if (mono) c.advance(timer.delay); timer.callback(); };
  const quota = controller.plan({ provider: 'x', failure: { ...failure, code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 5 * MAX_DELAY_MS } });
  const pending = controller.wait(quota);
  assert.equal([...c.timers.values()][0].delay, WALL_CLOCK_SLICE_MS, 'never one 5h monotonic timer');
  // 8h laptop sleep: the monotonic clock is frozen, the wall clock is not.
  c.sleep(8 * MAX_DELAY_MS); fire(false);
  assert.equal(await pending, true); assert.equal(c.timers.size, 0);
  // Awake normal passage re-arms slices until the monotonic deadline.
  const awake = controller.wait(controller.plan({ provider: 'x', failure, previousRetry: 2 }));
  let slices = 0;
  while (c.timers.size) { fire(); slices++; }
  assert.equal(await awake, true); assert.equal(slices, 1, '28.125s fits one slice');
  const hour = controller.wait({ delayMs: MAX_DELAY_MS });
  slices = 0; while (c.timers.size) { fire(); slices++; }
  assert.equal(await hour, true); assert.equal(slices, 60);
  await controller.dispose();
});

test('a partial wall-clock jump shortens only the remaining time; a backward step cannot stretch it', async () => {
  const c = clock(), controller = createController({}, { clock: c, wallClockSliceMs: WALL_CLOCK_SLICE_MS });
  // Elapse the pending slice (or, with mono=false, only deliver it) then run it.
  const fire = (mono = true) => { const [[handle, timer]] = [...c.timers]; c.timers.delete(handle); if (mono) c.advance(timer.delay); timer.callback(); };
  const pending = controller.wait({ delayMs: 5 * MAX_DELAY_MS });
  c.sleep(4 * MAX_DELAY_MS); fire(false);
  assert.equal(c.timers.size, 1, 'one hour still remains'); assert.equal([...c.timers.values()][0].delay, WALL_CLOCK_SLICE_MS);
  c.sleep(MAX_DELAY_MS); fire(false); assert.equal(await pending, true);
  const back = controller.wait({ delayMs: 120_000 });
  c.sleep(-10 * MAX_DELAY_MS); fire(); fire();
  assert.equal(await back, true, 'monotonic time still ends the wait');
  await controller.dispose();
});

test('the caller notBeforeMs is consulted (bounded), and wake/cancel/dispose keep their semantics under slicing', async () => {
  const c = clock(), controller = createController({}, { clock: c, wallClockSliceMs: WALL_CLOCK_SLICE_MS });
  // Elapse the pending slice (or, with mono=false, only deliver it) then run it.
  const fire = (mono = true) => { const [[handle, timer]] = [...c.timers]; c.timers.delete(handle); if (mono) c.advance(timer.delay); timer.callback(); };
  // A durable deadline computed 30s earlier ends the wait 30s earlier in wall time.
  const early = controller.wait({ delayMs: 90_000 }, undefined, { notBeforeMs: c.wallNow() + 60_000 });
  c.sleep(60_000); fire(false); assert.equal(await early, true);
  // A bogus stale deadline is ignored rather than ending the wait at once.
  const stale = controller.wait({ delayMs: 90_000 }, undefined, { notBeforeMs: c.wallNow() - 3_600_000 });
  fire(false); assert.equal(c.timers.size, 1);
  c.advance(90_000); fire(false); assert.equal(await stale, true);
  // Wake during a sliced provider-minimum wait: the minimum holds in wall time.
  const minimum = controller.plan({ provider: 'x', failure: { ...failure, providerRetryAfterMs: 2 * MAX_DELAY_MS } });
  const wake = new AbortController(); let woken = 0;
  const bounded = controller.wait(minimum, undefined, { wake: wake.signal, onWoken: () => woken++ });
  wake.abort(); assert.equal(woken, 1); assert.equal(c.timers.size, 1);
  c.sleep(2 * MAX_DELAY_MS); fire(false); assert.equal(await bounded, true);
  const local = controller.plan({ provider: 'x', failure, previousRetry: 9 });
  const now = new AbortController();
  const quick = controller.wait(local, undefined, { wake: now.signal });
  now.abort(); assert.equal(await quick, true); assert.equal(c.timers.size, 0);
  const caller = new AbortController();
  const cancelled = controller.wait(local, caller.signal);
  fire(); caller.abort(); assert.equal(await cancelled, false); assert.equal(c.timers.size, 0);
  const disposed = controller.wait(local);
  await controller.dispose(); assert.equal(await disposed, false); assert.equal(c.timers.size, 0);
});

test('timer setup failures reject without leaked waits', async () => {
  const controller = createController({}, { setTimeout() { throw new Error('clock failed'); }, clearTimeout() {} });
  await assert.rejects(controller.wait(controller.selfHealPlan(1)), /clock failed/);
  await controller.dispose();
});
