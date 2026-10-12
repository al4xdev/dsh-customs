import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { resolveHost } from '../common.mjs';
import * as plugin from './index.mjs';

const { Context } = await import(resolveHost('@deepseek-ai/cordis'));
const { markAgentLoopRequest, resolveRetryPolicy } = await import(resolveHost('@deepseek-ai/dsh-llm'));
const finish = (message = 'WebSocket closed 1012 service restart', code = 'PI_AI_ERROR', extra = {}) => ({
  type: 'finish', reason: { kind: 'error', failure: { code, message, ...extra } },
});
const options = (extra = {}, marked = true) => {
  const value = { provider: 'openai-codex', model: 'fixture', messages: [], ...extra };
  return Object.freeze(marked ? markAgentLoopRequest(value) : value);
};
async function wrap(request, chunks, enabled = true) {
  const ctx = new Context();
  let count = 0;
  try {
    // Unit hook contract needs no provider service or model call.
    plugin.apply(ctx);
    if (!enabled) throw new Error('invalid fixture');
    const stream = ctx.waterfall('llm/stream', request, () => {
      count++;
      return (async function* () { yield* chunks; })();
    });
    const result = [];
    for await (const chunk of stream) result.push(chunk);
    assert.equal(count, 1, 'next called exactly once, never retries locally');
    return result;
  } finally { await ctx.fiber.dispose(); }
}
function runtime(settings) {
  return new Promise((resolve, reject) => {
    // A fresh process-local module graph for each real-loop integration proof.
    const worker = new Worker(new URL('./runtime-fixture.mjs', import.meta.url), { workerData: settings });
    let result;
    worker.on('message', message => {
      if (message.error) reject(Object.assign(new Error(message.error.message), { stack: message.error.stack }));
      else result = message.result;
    });
    worker.on('error', reject);
    worker.on('exit', code => code ? reject(new Error(`Offline fixture exited ${code}`)) : resolve(result));
  });
}
const eventsOf = (result, type, index = 0) => result.sessions[index].events.filter(event => event.type === type);

test('official normal defaults remain bounded and unchanged', () => {
  const policy = resolveRetryPolicy(undefined, 'fixture');
  assert.equal(policy.mode, 'normal');
  assert.equal(policy.maxRetries, 5);
  assert.equal(policy.initialDelayMs, 500);
  assert.equal(policy.maxDelayMs, 10000);
  assert.equal(policy.jitterRatio, 0.1);
  assert.ok(policy.retryableCodes.includes('TRANSPORT'));
  assert.ok(!policy.retryableCodes.includes('PI_AI_ERROR'));
});

test('only native close1000/1012 finishes are copied; all other facts/chunks preserved', async () => {
  for (const message of ['WebSocket closed 1000', 'WebSocket closed 1012 service restart']) {
    const before = Object.freeze({ type: 'text-delta', index: 0, text: 'partial' });
    const original = finish(message, 'PI_AI_ERROR', { requestId: 'fixture-request', providerRetryAfterMs: 7, status: 503 });
    original.replayState = { response: { fixture: true }, blocks: [] };
    Object.freeze(original.reason.failure); Object.freeze(original.reason); Object.freeze(original);
    const [same, changed] = await wrap(options(), [before, original]);
    assert.equal(same, before);
    assert.notEqual(changed, original);
    assert.notEqual(changed.reason.failure, original.reason.failure);
    assert.deepEqual(changed, { ...original, reason: { ...original.reason, failure: { ...original.reason.failure, code: 'TRANSPORT' } } });
    assert.equal(original.reason.failure.code, 'PI_AI_ERROR');
    assert.equal(changed.replayState, original.replayState);
  }
});

test('negative matrix passes the exact original chunk unchanged', async () => {
  const aborted = new AbortController(); aborted.abort(new Error('fixture abort'));
  const cases = [
    [options({}, false), finish()],
    [options({ provider: 'other' }), finish()],
    [options({ purpose: 'compaction' }), finish()],
    [options({ purpose: 'session-title' }), finish()],
    [options({ signal: aborted.signal }), finish()],
    [options(), { type: 'finish', reason: { kind: 'aborted', failure: { code: 'PI_AI_ERROR', message: 'WebSocket closed 1012' } } }],
    ...['AUTH', 'QUOTA_EXCEEDED', 'INVALID_CREDENTIAL', 'TRANSPORT', 'SERVER', 'INVALID_REQUEST'].map(code => [options(), finish(undefined, code)]),
    ...['WebSocketclosed1012', 'WebSocket closed 1001', 'WebSocket closed 1006', 'WebSocket closed 1008', 'WebSocket closed 1009', 'WebSocket closed 1011', 'WebSocket closed 1013', 'WebSocket closed 10120', 'prefix WebSocket closed 1012', 'WebSocket closed 1012\ninjected', 'other pi-ai error', 'WebSocket closed 1000 auth expired', 'WebSocket closed 1012 quota exceeded', 'WebSocket closed 1000 billing', 'WebSocket closed 1012 policy violation', 'WebSocket closed 1012 payload too large'].map(message => [options(), finish(message)]),
    ...['1000', '1012'].flatMap(code => ['\n', '\r', '\r\n'].map(ending => [options(), finish(`WebSocket closed ${code}${ending}`)])),
    ...[400, 401, 403, 404, 413, 429].map(status => [options(), finish(undefined, undefined, { status })]),
  ];
  for (const [request, chunk] of cases) assert.equal((await wrap(request, [chunk]))[0], chunk, JSON.stringify(chunk));
});

test('middleware failures remain thrown and listener disposal restores original stream', async () => {
  const ctx = new Context();
  try {
    const fiber = await ctx.plugin({ name: 'fixture-wrapper', apply: plugin.apply });
    const reason = new Error('observer failed');
    const stream = ctx.waterfall('llm/stream', options(), () => (async function* () { throw reason; })());
    await assert.rejects(async () => { for await (const _chunk of stream) {} }, error => error === reason);
    await fiber.dispose();
    const chunk = finish();
    const result = [];
    for await (const entry of ctx.waterfall('llm/stream', options(), () => (async function* () { yield chunk; })())) result.push(entry);
    assert.equal(result[0], chunk);
  } finally { await ctx.fiber.dispose(); }
});

test('without plugin the actual official loop does not retry Codex PI_AI_ERROR or execute failed tools', async () => {
  const result = await runtime({ enabled: false, complete: true });
  assert.equal(result.calls.length, 1);
  assert.equal(result.dispatches.length, 0);
  assert.equal(eventsOf(result, 'assistant/attempt').length, 1);
  assert.equal(eventsOf(result, 'llm/retry').length, 0);
  assert.equal(eventsOf(result, 'tool/call').length, 0);
  assert.equal(result.atFailure[0].code, 'PI_AI_ERROR');
});

for (const complete of [false, true]) test(`official retry after ${complete ? 'complete' : 'incomplete'} failed tool chunk executes only successful tool once`, async () => {
  const result = await runtime({ complete, message: complete ? 'WebSocket closed 1000' : 'WebSocket closed 1012 service restart' });
  assert.equal(result.calls.length, 3, 'failed tool attempt, successful tool attempt, final stop');
  assert.equal(result.dispatches.length, 1);
  assert.equal(result.atFailure[0].dispatchCount, 0);
  assert.equal(result.atBackoff[0].dispatchCount, 0);
  assert.equal(result.atFailure[0].code, 'TRANSPORT');
  assert.ok(result.atFailure[0].events.includes('assistant/attempt'));
  assert.ok(!result.atFailure[0].events.includes('assistant/message'));
  assert.ok(!result.atFailure[0].events.includes('tool/call'));
  assert.equal(eventsOf(result, 'tool/call').length, 1);
  assert.equal(eventsOf(result, 'tool/result').length, 1);
  assert.equal(eventsOf(result, 'assistant/attempt').length, 1);
  assert.equal(eventsOf(result, 'llm/retry').length, 1);
  assert.equal(eventsOf(result, 'llm/retry-started').length, 1);
  assert.deepEqual(result.calls[1].messages, result.calls[0].messages, 'failed partial stream never enters retry request history');
  assert.notEqual(result.starts[0].attemptId, result.starts[1].attemptId);
  assert.equal(result.starts[0].turn, result.starts[1].turn);
  assert.equal(result.starts[0].step, result.starts[1].step);
  assert.equal(eventsOf(result, 'turn/start').length, 1);
  assert.equal(eventsOf(result, 'step/start').length, 2, 'same-step retry does not create an extra step');
});

test('official default five-retry budget exhausts after six attempts with durable audit and zero tools', async () => {
  const result = await runtime({ exhaust: true, complete: true });
  assert.equal(result.calls.length, 6);
  assert.equal(result.dispatches.length, 0);
  assert.equal(eventsOf(result, 'assistant/attempt').length, 6);
  assert.equal(eventsOf(result, 'llm/retry').length, 5);
  assert.equal(eventsOf(result, 'llm/retry-started').length, 5);
  assert.equal(eventsOf(result, 'tool/call').length, 0);
  assert.deepEqual(eventsOf(result, 'llm/retry').map(event => event.data.retry), [1, 2, 3, 4, 5]);
  assert.ok(eventsOf(result, 'llm/retry').every(event => event.data.maxRetries === 5 && event.data.failure.code === 'TRANSPORT'));
  assert.equal(eventsOf(result, 'turn/end').length, 1);
});

test('cancel during durable backoff prevents new request and retry-started', async () => {
  const result = await runtime({ cancel: true, exhaust: true });
  assert.equal(result.calls.length, 1);
  assert.equal(result.dispatches.length, 0);
  assert.equal(eventsOf(result, 'llm/retry').length, 1);
  assert.equal(eventsOf(result, 'llm/retry-started').length, 0);
});

test('official retry disposal drains its wait and prevents any retry-started or new request', async () => {
  const result = await runtime({ disposeRetry: true, exhaust: true });
  assert.equal(result.calls.length, 1);
  assert.equal(result.dispatches.length, 0);
  assert.equal(eventsOf(result, 'llm/retry').length, 1);
  assert.equal(eventsOf(result, 'llm/retry-started').length, 0);
});

test('official retry budget resets at the next turn instead of disabling later recovery', async () => {
  const result = await runtime({ repeat: true, exhaust: true, complete: true });
  assert.equal(result.calls.length, 12);
  assert.equal(result.dispatches.length, 0);
  assert.equal(eventsOf(result, 'turn/start').length, 2);
  assert.equal(eventsOf(result, 'turn/end').length, 2);
  assert.deepEqual(eventsOf(result, 'llm/retry').map(event => event.data.retry), [1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
});

test('concurrent agents have independent official budgets; reload leaves one effective wrapper', async () => {
  const result = await runtime({ concurrent: true, reload: true, exhaust: true });
  assert.equal(result.calls.length, 12);
  assert.equal(result.dispatches.length, 0);
  for (let i = 0; i < 2; i++) {
    assert.equal(eventsOf(result, 'assistant/attempt', i).length, 6);
    assert.equal(eventsOf(result, 'llm/retry', i).length, 5);
  }
});

for (const [message, code] of [['WebSocket closed 1012 quota exceeded', 'PI_AI_ERROR'], ['WebSocket closed 1012', 'AUTH'], ['other pi-ai error', 'PI_AI_ERROR']]) {
  test(`official loop fails fast for ${code}: ${message}`, async () => {
    const result = await runtime({ message, code, complete: true });
    assert.equal(result.calls.length, 1);
    assert.equal(result.dispatches.length, 0);
    assert.equal(eventsOf(result, 'llm/retry').length, 0);
  });
}
