import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHost } from '../common.mjs';
import { createController } from './controller.mjs';
import { installAuxDriver } from './aux-driver.mjs';
const { Context } = await import(resolveHost('@deepseek-ai/cordis'));
const { markAgentLoopRequest, isAgentLoopRequest } = await import(resolveHost('@deepseek-ai/dsh-llm'));

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const text = value => ({ type: 'text-delta', index: 0, text: value });
const finish = (kind = 'stop', extra = {}) => ({ type: 'finish', reason: { kind }, ...extra });
const failed = (code = 'SERVER', facts = {}) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: 'PROVIDER_MESSAGE_CANARY', ...facts } }, replayState: { response: 'FAILED_REPLAY_CANARY' } });
const request = (extra = {}) => Object.freeze({ provider: 'new-native', model: 'fixture', purpose: 'compaction', messages: [{ role: 'user', content: [{ type: 'text', text: 'INTENT_CANARY' }] }], system: 'SYSTEM_CANARY', tools: [{ name: 'spy', description: 'fixture', parameters: {} }], maxTokens: 100, ...extra });
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const from = chunks => (async function* () { yield* chunks; })();
const recoveryDelays = [7031.25, 14062.5, 28125, 56250, 112500, 225000, 450000, 900000, 1800000, 3600000];
// Native timers have millisecond granularity; the policy's nominal values remain exact.
const assertDelays = (actual, expected) => assert.deepEqual(actual.map(Math.ceil), expected.map(Math.ceil));

function fixture(factory, settings = {}) {
  const ctx = new Context(), timers = [], calls = [], visits = [], logs = [], waiting = deferred();
  const pendingTimers = new Map();
  let timerId = 0, policyCalls = 0;
  const controller = createController(settings.config, {
    random: () => .5,
    setTimeout(callback, delay) {
      const id = ++timerId; timers.push(delay); pendingTimers.set(id, callback); waiting.resolve();
      if (!settings.manualClock) queueMicrotask(() => { if (pendingTimers.delete(id)) callback(); });
      return id;
    },
    clearTimeout(id) { pendingTimers.delete(id); },
  });
  const service = {
    providerRetryPolicy(provider) { policyCalls++; return settings.registeredPolicy?.(provider); },
    stream(options) {
      return ctx.waterfall(this, 'llm/stream', options, () => {
        calls.push(options);
        return factory(options, calls.length, { ctx, service, controller });
      });
    },
  };
  ctx.on('llm/stream', function (options, next) { assert.equal(this, service); visits.push(options); return next(); });
  const debug = ctx.logger.debug;
  ctx.logger.debug = value => { logs.push(value); };
  installAuxDriver(ctx, controller);
  return { ctx, service, controller, calls, visits, timers, pendingTimers, waiting: waiting.promise, logs,
    get policyCalls() { return policyCalls; },
    fire() { for (const [id, callback] of [...pendingTimers]) { pendingTimers.delete(id); callback(); } },
    async close() { await controller.dispose(); await ctx.fiber.dispose(); ctx.logger.debug = debug; },
  };
}

test('buffered retry uses next once then full redispatch; only complete winner escapes', async () => {
  const original = request({ temperature: .7, stop: ['END'], sessionId: 'session-x', toolHistory: { tools: [], updates: [] } });
  const before = structuredClone(original);
  const h = fixture((_options, n) => n < 3
    ? from([text(`FAILED_PREFIX_${n}`), { type: 'usage', usage: { inputTokens: 8, outputTokens: 5, totalTokens: 13 } }, failed()])
    : from([text('WINNER'), { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }, finish('stop', { replayState: { response: 'WIN_REPLAY' } })]));
  try {
    const result = await collect(h.service.stream(original));
    assert.deepEqual(result, [text('WINNER'), { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }, finish('stop', { replayState: { response: 'WIN_REPLAY' } })]);
    assertDelays(h.timers, recoveryDelays.slice(0, 2));
    assert.equal(h.policyCalls, 1); assert.equal(h.calls.length, 3); assert.equal(h.visits.length, 3);
    assert.equal(h.calls[0], original);
    for (const [index, attempt] of h.calls.slice(1).entries()) {
      const { signal, messages, ...intent } = attempt;
      const { messages: originalMessages, ...originalIntent } = before;
      assert.deepEqual(intent, originalIntent); assert.notEqual(attempt, original); assert(Object.isFrozen(attempt));
      assert.deepEqual(messages.slice(0, originalMessages.length), originalMessages);
      assert.equal(messages.length, originalMessages.length + index + 1);
      for (const warning of messages.slice(originalMessages.length)) {
        assert.equal(warning.role, 'user'); assert.match(warning.content[0].text, /^harness warning:/);
        assert(!warning.content[0].text.includes('CANARY'));
      }
      assert(Object.isFrozen(attempt.messages)); assert(Object.isFrozen(attempt.messages[0].content));
      assert.notEqual(attempt.messages, original.messages); assert(signal instanceof AbortSignal);
      assert(!isAgentLoopRequest(attempt));
    }
    assert.notEqual(h.calls[1], h.calls[2]); assert.deepEqual(original, before);
    assert(!JSON.stringify(h.logs).includes('CANARY')); assert(!JSON.stringify(result).includes('FAILED'));
  } finally { await h.close(); }
});

test('main brand bypasses before snapshot, even with auxiliary purpose', async () => {
  let touched = 0;
  const options = Object.freeze(markAgentLoopRequest({ ...request(), get uncloneable() { touched++; throw new Error('must not clone main'); } }));
  const h = fixture(() => from([failed()]));
  try {
    assert.equal((await collect(h.service.stream(options)))[0].reason.failure.code, 'SERVER');
    assert.equal(h.calls[0], options); assert.equal(h.calls.length, 1); assert.equal(h.policyCalls, 0);
    assert.equal(touched, 0); assert.deepEqual(h.timers, []);
  } finally { await h.close(); }
});

test('unmarked unknown-purpose call retries only before ANY output exposure', async () => {
  for (const purpose of [undefined, 'foreign-purpose']) {
    const h = fixture((_options, n) => from(n === 1 ? [failed()] : [text('ok'), finish()]));
    try { assert.deepEqual(await collect(h.service.stream(request({ purpose }))), [text('ok'), finish()]); assert.equal(h.calls.length, 2); }
    finally { await h.close(); }
    for (const prefix of [text('visible'), { type: 'usage', usage: { totalTokens: 1 } }, { type: 'block-start', index: 0, blockType: 'tool-call' }]) {
      const h = fixture(() => from([prefix, failed()]));
      try {
        const result = await collect(h.service.stream(request({ purpose })));
        assert.deepEqual(result[0], prefix); assert.equal(result.at(-1).reason.kind, 'error');
        assert(!('replayState' in result.at(-1))); assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, []);
      } finally { await h.close(); }
    }
  }
});

test('buffered permanent, unsupported, aborted and max-tokens never retry or publish partials/failed usage', async () => {
  const terminals = [failed('AUTH'), failed('NOT_SUPPORTED'), failed('SERVER', { status: 401 }), failed('SERVER', { permanent: true }), finish('aborted', { reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } }), finish('max-tokens')];
  for (const terminal of terminals) {
    const h = fixture(() => from([text('bad-prefix'), { type: 'usage', usage: { totalTokens: 100 } }, terminal]));
    try {
      const result = await collect(h.service.stream(request()));
      assert.equal(result.length, 1); assert.equal(result[0].reason.kind, terminal.reason.kind);
      if (terminal.reason.failure) {
        const { message: _message, ...routing } = result[0].reason.failure;
        const { message: _originalMessage, ...originalRouting } = terminal.reason.failure;
        assert.deepEqual(routing, originalRouting);
      }
      assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, []);
    } finally { await h.close(); }
  }
});

test('one ten-retry budget applies to any provider; exhaustion remains an explicit safe error', async () => {
  const h = fixture(() => from([text('discard'), failed('TIMEOUT')]));
  try {
    const result = await collect(h.service.stream(request({ provider: 'previously-unknown-adapter' })));
    assert.equal(h.calls.length, 11); assert.equal(result.length, 1); assert.equal(result[0].reason.failure.code, 'TIMEOUT');
    assert.match(result[0].reason.failure.message, /^harness warning:/);
    assert(!result[0].reason.failure.message.includes('CANARY'));
    assertDelays(h.timers, recoveryDelays);
    assert.equal(h.timers[8], 1800000); assert.equal(h.timers[9], 3600000);
    assert.deepEqual(h.calls.map(call => call.messages.length), Array.from({ length: 11 }, (_, index) => index + 1));
  } finally { await h.close(); }
});

test('registered explicit opt-out is respected and effective policy is captured once', async () => {
  let registered = { mode: 'normal', maxRetries: 0 };
  const h = fixture(() => from([failed()]), { registeredPolicy: () => registered });
  try { await collect(h.service.stream(request())); assert.equal(h.calls.length, 1); assert.equal(h.policyCalls, 1); }
  finally { await h.close(); }
  registered = { mode: 'normal', maxRetries: 5 };
  const k = fixture((_options, n) => { registered = { mode: 'normal', maxRetries: 0 }; return from(n === 1 ? [failed()] : [text('ok'), finish()]); }, { registeredPolicy: () => registered });
  try { await collect(k.service.stream(request())); assert.equal(k.calls.length, 2); assert.equal(k.policyCalls, 1); }
  finally { await k.close(); }
});

test('Retry-After cannot shorten the nominal delay and hints above60min do not start another timer', async () => {
  const h = fixture((_options, n) => from(n === 1 ? [failed('RATE_LIMIT', { providerRetryAfterMs: 6000, status: 429 })] : [finish()]));
  try { await collect(h.service.stream(request())); assertDelays(h.timers, recoveryDelays.slice(0, 1)); }
  finally { await h.close(); }
  const k = fixture(() => from([failed('SERVER', { providerRetryAfterMs: 3600001 })]));
  try { await collect(k.service.stream(request())); assert.equal(k.calls.length, 1); assert.deepEqual(k.timers, []); }
  finally { await k.close(); }
});

test('chunk and byte limits fail closed before any output with an owned nonretryable error', async () => {
  for (const auxiliary of [{ maxChunks: 1 }, { maxBufferBytes: 50 }]) {
    const h = fixture(() => from([text('BUFFER_CANARY'.repeat(8)), finish()]), { config: { auxiliary } });
    let escaped = 0;
    try {
      await assert.rejects((async () => { for await (const _chunk of h.service.stream(request())) escaped++; })(), error => error.code === 'AUXILIARY_BUFFER_LIMIT' && !error.message.includes('CANARY'));
      assert.equal(escaped, 0); assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, []);
    } finally { await h.close(); }
  }
});

test('missing, multiple or trailing terminal chunks fail closed without retrying protocol errors', async () => {
  for (const chunks of [[text('no-finish')], [finish(), text('late')], [finish(), finish()], [{ type: 'finish', reason: { kind: 'foreign' } }]]) {
    const h = fixture(() => from(chunks)); let escaped = 0;
    try {
      await assert.rejects((async () => { for await (const _chunk of h.service.stream(request())) escaped++; })(), { code: 'AUXILIARY_PROTOCOL_INVALID' });
      assert.equal(escaped, 0); assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, []);
    } finally { await h.close(); }
  }
});

test('arbitrary middleware, iterator and cleanup throws are never reclassified or retried', async () => {
  const error = new Error('MIDDLEWARE_CANARY');
  for (const make of [() => { throw error; }, () => ({ [Symbol.asyncIterator]() { throw error; } }), () => ({ [Symbol.asyncIterator]() { return { next: () => Promise.reject(error), return: () => Promise.reject(new Error('CLEANUP_CANARY')) }; } }), () => ({ [Symbol.asyncIterator]() { return { next: () => Promise.reject(error), get return() { throw new Error('CLEANUP_GETTER_CANARY'); } }; } }), () => (async function* () { try { yield failed(); } finally { throw error; } })()]) {
    const h = fixture(make);
    try { await assert.rejects(collect(h.service.stream(request())), value => value === error); assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, []); }
    finally { await h.close(); }
  }
});

test('registration and loader updates fail closed before a retry; initial successful call is still valid', async () => {
  for (const event of ['llm/adapters-updated', 'loader/config-update', 'loader/volatile-update', 'loader/partial-dispose', 'loader/entry-init']) {
    const h = fixture((_options, _n, { ctx }) => (async function* () { ctx.emit(event); yield failed(); })());
    try { await assert.rejects(collect(h.service.stream(request())), { code: 'AUXILIARY_RETRY_UNSAFE' }); assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, []); }
    finally { await h.close(); }
  }
  const h = fixture((_options, _n, { ctx }) => (async function* () { ctx.emit('llm/adapters-updated'); yield text('ok'); yield finish(); })());
  try { assert.deepEqual(await collect(h.service.stream(request())), [text('ok'), finish()]); }
  finally { await h.close(); }
});

test('configuration changed during backoff cannot switch registrations on replay', async () => {
  const h = fixture(() => from([failed()]), { manualClock: true });
  try {
    const result = collect(h.service.stream(request()));
    await h.waiting; h.ctx.emit('loader/volatile-update'); h.fire();
    await assert.rejects(result, { code: 'AUXILIARY_RETRY_UNSAFE' }); assert.equal(h.calls.length, 1);
  } finally { await h.close(); }
});

test('concurrent and nested auxiliary operations keep independent counters, buffers and owned identities', async () => {
  const attempts = new Map();
  const h = fixture((options, _n, { service }) => (async function* () {
    const key = options.sessionId; const n = (attempts.get(key) ?? 0) + 1; attempts.set(key, n);
    if (key === 'outer' && n === 1) assert.deepEqual(await collect(service.stream(request({ sessionId: 'nested' }))), [text('nested'), finish()]);
    if (n <= (key === 'A' ? 2 : key === 'B' ? 1 : 0)) { yield text(`${key}-discard`); yield failed(); }
    else { yield text(key); yield finish(); }
  })());
  try {
    const result = await Promise.all(['A', 'B', 'outer'].map(sessionId => collect(h.service.stream(request({ sessionId })))));
    assert.deepEqual(result.map(chunks => chunks[0].text), ['A', 'B', 'outer']);
    assert.deepEqual([...attempts.entries()].sort(), [['A', 3], ['B', 2], ['nested', 1], ['outer', 1]]);
    assertDelays([...h.timers].sort((a, b) => a - b), [recoveryDelays[0], recoveryDelays[0], recoveryDelays[1]]); assert.equal(h.policyCalls, 4);
  } finally { await h.close(); }
});

test('pre-aborted caller and a stream constructed after dispose cannot dispatch', async () => {
  const h = fixture(() => from([finish()])); const abort = new AbortController(); abort.abort();
  try {
    await assert.rejects(collect(h.service.stream(request({ signal: abort.signal }))), { code: 'ABORTED' }); assert.equal(h.calls.length, 0);
    const held = h.service.stream(request()); await h.controller.dispose();
    await assert.rejects(collect(held), { code: 'ABORTED' }); assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('caller abort and iterator.return/throw interrupt a stalled read even if upstream ignores signal', { timeout: 3000 }, async () => {
  for (const mode of ['abort', 'return', 'throw', 'dispose']) {
    const started = deferred(), pendingRead = deferred(), pendingClose = deferred(); let closes = 0;
    const h = fixture(() => ({ [Symbol.asyncIterator]() { return { next() { started.resolve(); return pendingRead.promise; }, return() { closes++; return pendingClose.promise; } }; } }));
    const abort = new AbortController(); const iterator = h.service.stream(request({ signal: abort.signal }));
    const pending = iterator.next();
    try {
      await started.promise;
      if (mode === 'abort') abort.abort();
      if (mode === 'return') assert.deepEqual(await iterator.return('closed'), { done: true, value: 'closed' });
      if (mode === 'throw') { const error = new Error('consumer-throw'); await assert.rejects(iterator.throw(error), value => value === error); }
      if (mode === 'dispose') await h.ctx.fiber.dispose();
      await assert.rejects(pending, { code: 'ABORTED' });
      assert.equal(h.calls.length, 1); assert.equal(closes, 1); assert.deepEqual(h.timers, []);
    } finally { pendingRead.resolve({ done: true }); pendingClose.reject(new Error('late detached cleanup')); await h.close(); }
  }
});

test('caller abort, early return and disposal cancel an owned pending backoff', { timeout: 3000 }, async () => {
  for (const mode of ['abort', 'return', 'dispose']) {
    const h = fixture(() => from([failed()]), { manualClock: true }); const abort = new AbortController();
    const iterator = h.service.stream(request({ signal: abort.signal })); const pending = iterator.next();
    try {
      await h.waiting;
      if (mode === 'abort') abort.abort();
      if (mode === 'return') await iterator.return();
      if (mode === 'dispose') await h.ctx.fiber.dispose();
      await assert.rejects(pending, { code: 'ABORTED' }); assert.equal(h.pendingTimers.size, 0); assert.equal(h.calls.length, 1);
    } finally { await h.close(); }
  }
});

test('early consumer close after streamed output never retries or drains more output', async () => {
  let closes = 0, reads = 0;
  const h = fixture(() => (async function* () { try { reads++; yield text('first'); reads++; yield failed(); } finally { closes++; } })());
  try {
    const iterator = h.service.stream(request({ purpose: undefined })); assert.equal((await iterator.next()).value.text, 'first');
    await iterator.return(); await Promise.resolve(); await Promise.resolve();
    assert.equal(reads, 1); assert.equal(closes, 1); assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, []);
  } finally { await h.close(); }
});

test('UTF-8 byte budget matches lossless JSON including escaping and lone surrogates', async () => {
  const chunks = [text('quoted " slash \\ control \u0000 emoji 😀 lone \ud800'), finish('stop', { replayState: { response: { list: [1, true, false, null, undefined, ['nested']], omitted: undefined } } })];
  const exact = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(JSON.stringify(chunk), 'utf8'), 0);
  for (const maxBufferBytes of [exact, exact - 1]) {
    const h = fixture(() => from(chunks), { config: { auxiliary: { maxBufferBytes } } });
    try {
      if (maxBufferBytes === exact) assert.deepEqual(await collect(h.service.stream(request())), chunks);
      else await assert.rejects(collect(h.service.stream(request())), { code: 'AUXILIARY_BUFFER_LIMIT' });
      assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, []);
    } finally { await h.close(); }
  }
});

test('buffer snapshots cannot be mutated by a producer after yielding a chunk', async () => {
  const h = fixture(() => (async function* () { const value = text('correct'); yield value; value.text = 'LATE_MUTATION_CANARY'; yield finish(); })());
  try { assert.deepEqual(await collect(h.service.stream(request())), [text('correct'), finish()]); }
  finally { await h.close(); }
});

test('retry intent stays pinned even if caller-owned mutable nested input later changes', async () => {
  const original = request(); const intended = structuredClone(original.messages);
  const h = fixture((_options, n) => {
    if (n === 1) { original.messages[0].content[0].text = 'later caller mutation'; return from([failed()]); }
    return from([finish()]);
  });
  try {
    await collect(h.service.stream(original));
    assert.deepEqual(h.calls[1].messages.slice(0, intended.length), intended);
    assert.equal(h.calls[1].messages.length, intended.length + 1);
    assert.match(h.calls[1].messages.at(-1).content[0].text, /^harness warning:/);
    assert(Object.isFrozen(h.calls[1].messages[0]));
  }
  finally { await h.close(); }
});

test('session-title buffers by default while explicit replay-safe purpose changes are honored', async () => {
  for (const enabled of [true, false]) {
    const h = fixture((_options, n) => from(n === 1 ? [text('failed title'), failed()] : [text('winning title'), finish()]), { config: { auxiliary: { replaySafePurposes: enabled ? ['compaction', 'session-title'] : ['compaction'] } } });
    try {
      const result = await collect(h.service.stream(request({ purpose: 'session-title' })));
      assert.equal(h.calls.length, enabled ? 2 : 1); assert.equal(result[0].text, enabled ? 'winning title' : 'failed title');
    } finally { await h.close(); }
  }
});

test('failed buffered tool declarations never reach a side-effecting consumer', async () => {
  const tool = { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'side_effect', arguments: '{}' } };
  const h = fixture((_options, n) => from(n === 1 ? [tool, failed()] : [text('safe summary'), finish()])); let sideEffects = 0;
  try {
    for await (const chunk of h.service.stream(request())) if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') sideEffects++;
    assert.equal(sideEffects, 0); assert.equal(h.calls.length, 2);
  } finally { await h.close(); }
});

test('malformed non-JSON chunks are rejected without invoking getters or exposing a prefix', async () => {
  let reads = 0; const cyclic = text('cycle'); cyclic.cycle = cyclic;
  const accessor = { type: 'text-delta', index: 0, get text() { reads++; throw new Error('ACCESSOR_CANARY'); } };
  for (const chunk of [cyclic, accessor, { ...text('invalid'), value: BigInt(3) }, { ...text('invalid'), value: Infinity }]) {
    const h = fixture(() => from([chunk, finish()]));
    try { await assert.rejects(collect(h.service.stream(request())), { code: 'AUXILIARY_PROTOCOL_INVALID' }); assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, []); }
    finally { await h.close(); }
  }
  assert.equal(reads, 0);
});
