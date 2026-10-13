import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { longCodexNominalDelays } from './long-retry-policy.mjs';

function runtime(settings) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../plugins/codex-transient-close/runtime-fixture.mjs', import.meta.url), {
      workerData: { longPolicy: true, message: 'WebSocket error', complete: true, ...settings },
    });
    let result;
    // A broken long-wait cancellation test must not leave a 20-minute Worker.
    const deadline = setTimeout(() => { worker.terminate(); reject(new Error('Long retry fixture exceeded 10-second deadline')); }, 10_000);
    worker.on('message', message => {
      if (message.error) reject(Object.assign(new Error(message.error.message), { stack: message.error.stack }));
      else result = message.result;
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      clearTimeout(deadline);
      if (code) reject(new Error(`Long retry fixture exited ${code}`));
      else resolve(result);
    });
  });
}
const eventsOf = (result, type, index = 0) => result.sessions[index].events.filter(event => event.type === type);

test('official engine retains real 5s→20min delays and exhausts nine retries with no failed tools', async () => {
  const result = await runtime({ exhaust: true });
  assert.equal(result.policy.mode, 'normal');
  assert.equal(result.policy.maxRetries, 9);
  assert.equal(result.calls.length, 10);
  assert.equal(result.dispatches.length, 0);
  assert.equal(eventsOf(result, 'assistant/attempt').length, 10);
  assert.equal(eventsOf(result, 'llm/retry-started').length, 9);
  const retries = eventsOf(result, 'llm/retry');
  assert.deepEqual(retries.map(event => event.data.delayMs), longCodexNominalDelays);
  assert.deepEqual(result.timers.map(timer => timer.delayMs), longCodexNominalDelays);
  assert.ok(retries.every(event => event.data.mode === 'normal' && event.data.maxRetries === 9));
  assert.equal(retries.reduce((total, event) => total + event.data.delayMs, 0), 2_475_000);
});

for (const [random, factor] of [[0, 0.9], [1, 1.1]]) test(`official jitter/cap uses ${factor} multiplier without exceeding 20min`, async () => {
  const result = await runtime({ exhaust: true, random });
  assert.deepEqual(eventsOf(result, 'llm/retry').map(event => event.data.delayMs), longCodexNominalDelays.map(delay => Math.min(delay * factor, 1_200_000)));
});

for (const action of ['cancelAt', 'disposeAt']) test(`${action} interrupts a real pending 20-minute official wait`, async () => {
  const result = await runtime({ exhaust: true, [action]: 9 });
  assert.equal(result.calls.length, 9);
  assert.equal(result.dispatches.length, 0);
  assert.equal(eventsOf(result, 'llm/retry').length, 9);
  assert.equal(eventsOf(result, 'llm/retry-started').length, 8);
  assert.equal(result.timers.length, 9);
  assert.deepEqual(result.timers.at(-1), { delayMs: 1_200_000, cancelled: true, held: true });
});

test('provider Retry-After up to cap overrides local exponential delay', async () => {
  const result = await runtime({ failureExtra: { providerRetryAfterMs: 1_200_000 } });
  assert.equal(result.calls.length, 3);
  assert.equal(result.dispatches.length, 1);
  assert.equal(result.atFailure[0].dispatchCount, 0);
  assert.equal(result.atBackoff[0].dispatchCount, 0);
  assert.deepEqual(eventsOf(result, 'llm/retry').map(event => event.data.delayMs), [1_200_000]);
  assert.deepEqual(result.calls[1].messages, result.calls[0].messages);
});

test('provider Retry-After above cap stays fail-fast in normal mode', async () => {
  const result = await runtime({ failureExtra: { providerRetryAfterMs: 1_200_001 } });
  assert.equal(result.calls.length, 1);
  assert.equal(result.dispatches.length, 0);
  assert.equal(eventsOf(result, 'llm/retry').length, 0);
  assert.equal(result.timers.length, 0);
});

for (const [message, code] of [['WebSocket error', 'AUTH'], ['WebSocket error', 'QUOTA_EXCEEDED'], ['WebSocket closed 1012 policy violation', 'PI_AI_ERROR'], ['exceeded request buffer limit while retrying upstream', 'PI_AI_ERROR']]) test(`long policy still fails fast for ${code}: ${message}`, async () => {
  const result = await runtime({ message, code });
  assert.equal(result.calls.length, 1);
  assert.equal(result.dispatches.length, 0);
  assert.equal(eventsOf(result, 'llm/retry').length, 0);
});

test('concurrent agents retain independent nine-retry budgets after wrapper reload', async () => {
  const result = await runtime({ exhaust: true, concurrent: true, reload: true });
  assert.equal(result.calls.length, 20);
  assert.equal(result.dispatches.length, 0);
  for (let index = 0; index < 2; index++) {
    assert.equal(eventsOf(result, 'assistant/attempt', index).length, 10);
    assert.deepEqual(eventsOf(result, 'llm/retry', index).map(event => event.data.delayMs), longCodexNominalDelays);
  }
});
