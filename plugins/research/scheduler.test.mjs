import test from 'node:test';
import assert from 'node:assert/strict';
import sharedScheduler, { createScheduler, SchedulerError } from './scheduler.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

for (const workers of [1, 2]) {
  test(`FIFO across callers, peak ${workers}, no slot leak`, async () => {
    const scheduler = createScheduler({ workers });
    const starts = [];
    let active = 0, peak = 0;
    const gates = Array.from({ length: 12 }, deferred);
    const call = i => scheduler.run('backend', async () => {
      starts.push(i);
      peak = Math.max(peak, ++active);
      await gates[i].promise;
      active--;
      return i;
    });
    const promises = gates.map((_, i) => call(i));
    assert.equal(scheduler.stats('backend').active, workers);
    assert.equal(scheduler.stats('backend').queued, 12 - workers);
    for (let i = 0; i < gates.length; i++) {
      gates[i].resolve();
      await tick();
    }
    assert.deepEqual(await Promise.all(promises), gates.map((_, i) => i));
    assert.deepEqual(starts, gates.map((_, i) => i));
    assert.equal(peak, workers);
    assert.deepEqual(scheduler.stats('backend'), { active: 0, queued: 0, limit: workers, cooldownMs: 0 });
  });
}

test('independent keys and factory instances do not block each other', async () => {
  const scheduler = createScheduler({ workers: 1 });
  const gate = deferred();
  const first = scheduler.run('a', () => gate.promise);
  assert.equal(await scheduler.run('b', () => 42), 42);
  assert.equal(await createScheduler({ workers: 1 }).run('a', () => 43), 43);
  gate.resolve();
  await first;
});

test('limit override only narrows, persists idle and drains existing active work first', async () => {
  const scheduler = createScheduler();
  const a = deferred(), b = deferred();
  const first = scheduler.run('a', () => a.promise);
  const second = scheduler.run('a', () => b.promise);
  let started = false;
  const third = scheduler.run('a', () => { started = true; }, { limit: 1 });
  assert.deepEqual(scheduler.stats('a'), { active: 2, queued: 1, limit: 1, cooldownMs: 0 });
  a.resolve();
  await first;
  assert.equal(started, false);
  b.resolve();
  await Promise.all([second, third]);
  await scheduler.run('a', () => 1, { limit: 2 });
  assert.equal(scheduler.stats('a').limit, 1);
  const one = createScheduler({ workers: 1 });
  await one.run('a', () => 1, { limit: 2 });
  assert.equal(one.stats('a').limit, 1);
});

test('pre-aborted signal never starts or enqueues a task', async () => {
  const scheduler = createScheduler();
  const controller = new AbortController();
  const reason = new Error('deadline');
  controller.abort(reason);
  await assert.rejects(scheduler.run('a', () => assert.fail('started'), { signal: controller.signal }), error => error === reason);
  assert.deepEqual(scheduler.stats('a'), { active: 0, queued: 0, limit: 2, cooldownMs: 0 });
});

test('queued abort removes waiter, frees queue capacity, preserves FIFO', async () => {
  const scheduler = createScheduler({ workers: 1, maxQueue: 1 });
  const gate = deferred();
  const first = scheduler.run('a', () => gate.promise);
  const controller = new AbortController();
  const waiting = scheduler.run('a', () => assert.fail('aborted task started'), { signal: controller.signal });
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(scheduler.stats('a').queued, 0);
  const replacement = scheduler.run('a', () => 'replacement');
  gate.resolve();
  await first;
  assert.equal(await replacement, 'replacement');
});

for (const lateReject of [false, true]) {
  test(`running abort retains slot through late ${lateReject ? 'rejection' : 'resolution'}`, async () => {
    const scheduler = createScheduler({ workers: 1 });
    const gate = deferred();
    const controller = new AbortController();
    const first = scheduler.run('a', signal => {
      assert.equal(signal, controller.signal);
      return gate.promise;
    }, { signal: controller.signal });
    let started = false;
    const second = scheduler.run('a', () => { started = true; return 2; });
    const rejection = assert.rejects(first, { name: 'AbortError' });
    controller.abort();
    await rejection;
    await tick();
    assert.equal(started, false);
    assert.equal(scheduler.stats('a').active, 1);
    if (lateReject) gate.reject(new Error('late failure must be observed'));
    else gate.resolve();
    assert.equal(await second, 2);
    await tick();
    assert.equal(scheduler.stats('a').active, 0);
  });
}

test('sync throws and async task rejections release slots', async () => {
  const scheduler = createScheduler({ workers: 1 });
  await assert.rejects(scheduler.run('a', () => { throw new Error('sync'); }), /sync/);
  const failure = scheduler.run('a', async () => { throw new Error('async'); });
  const following = scheduler.run('a', () => 'ok');
  await assert.rejects(failure, /async/);
  assert.equal(await following, 'ok');
  assert.equal(scheduler.stats('a').active, 0);
});

test('cooldown fails fast, rejects existing queue, preserves running, expires without timers', async () => {
  let clock = 1000;
  const scheduler = createScheduler({ workers: 1, now: () => clock });
  const gate = deferred();
  const running = scheduler.run('a', () => gate.promise);
  const controller = new AbortController();
  const queued = scheduler.run('a', () => assert.fail('cooldown waiter started'), { signal: controller.signal });
  const rejected = assert.rejects(queued, error => error instanceof SchedulerError && error.code === 'RATE_LIMIT' && error.retryAfterMs === 2000);
  scheduler.cooldown('a', 2000);
  await rejected;
  controller.abort();
  assert.deepEqual(scheduler.stats('a'), { active: 1, queued: 0, limit: 1, cooldownMs: 2000 });
  await assert.rejects(scheduler.run('a', () => assert.fail('cooldown admission')), { code: 'RATE_LIMIT', retryAfterMs: 2000 });
  scheduler.cooldown('a', 1);
  assert.equal(scheduler.stats('a').cooldownMs, 2000);
  gate.resolve('running survived');
  assert.equal(await running, 'running survived');
  clock += 2000;
  assert.equal(await scheduler.run('a', () => 'resumed'), 'resumed');
  scheduler.cooldown('a', 1e12);
  assert.equal(scheduler.stats('a').cooldownMs, 3600000);
});

test('maxQueue rejects excess and zero still permits immediate admission', async () => {
  for (const maxQueue of [0, 2]) {
    const scheduler = createScheduler({ workers: 1, maxQueue });
    const gate = deferred();
    const first = scheduler.run('a', () => gate.promise);
    const queued = Array.from({ length: maxQueue }, () => scheduler.run('a', () => 1));
    await assert.rejects(scheduler.run('a', () => assert.fail('overflow started')), { code: 'QUEUE_FULL' });
    gate.resolve();
    await Promise.all([first, ...queued]);
    assert.equal(scheduler.stats('a').active, 0);
  }
});

test('validates options, keys and bounds registry without forgetting reduced limits', async () => {
  for (const workers of [0, 3, '1', null]) assert.throws(() => createScheduler({ workers }), { code: 'INVALID_ARGUMENT' });
  for (const maxQueue of [-1, 1.5, Infinity]) assert.throws(() => createScheduler({ maxQueue }), { code: 'INVALID_ARGUMENT' });
  const scheduler = createScheduler();
  for (const key of ['', 'a'.repeat(257), null]) await assert.rejects(scheduler.run(key, () => 1), { code: 'INVALID_ARGUMENT' });
  for (const limit of [0, 3, null]) await assert.rejects(scheduler.run('a', () => 1, { limit }), { code: 'INVALID_ARGUMENT' });
  for (const ms of [-1, NaN, Infinity, '100']) assert.throws(() => scheduler.cooldown('a', ms), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(scheduler.run('a', null), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(scheduler.run('a', () => 1, { signal: {} }), { code: 'INVALID_ARGUMENT' });
  await scheduler.run('a'.repeat(256), () => 1, { limit: 1 });
  for (let i = 1; i < 512; i++) await scheduler.run(`key-${i}`, () => 1);
  // Read-only stats must not allocate a registry entry.
  for (let i = 0; i < 600; i++) scheduler.stats(`unknown-${i}`);
  await assert.rejects(scheduler.run('overflow', () => 1), { code: 'KEY_CAPACITY' });
  await scheduler.run('a'.repeat(256), () => 1, { limit: 2 });
  assert.equal(scheduler.stats('a'.repeat(256)).limit, 1);
});

test('singleton and active capacity survive cache-busted ESM reload', async () => {
  const reloaded = await import('./scheduler.mjs?singleton-reload-test');
  assert.equal(reloaded.sharedScheduler, sharedScheduler);
  assert.equal(reloaded.default, sharedScheduler);
  const key = 'scheduler-singleton-test';
  const gate = deferred();
  const first = sharedScheduler.run(key, () => gate.promise, { limit: 1 });
  let started = false;
  const second = reloaded.sharedScheduler.run(key, () => { started = true; });
  assert.equal(started, false);
  assert.equal(reloaded.sharedScheduler.stats(key).queued, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(started, true);
});
