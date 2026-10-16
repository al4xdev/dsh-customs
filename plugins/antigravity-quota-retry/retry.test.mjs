import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHost } from '../common.mjs';
import * as fork from './index.mjs';
const official = await import(resolveHost('@deepseek-ai/dsh-llm-retry'));
const QUOTA = 'ANTIGRAVITY_QUOTA_RESET';
const DAY = 86400000;
const policy = Object.freeze({ mode: 'normal', maxRetries: 9, retryableCodes: Object.freeze(['RATE_LIMIT', 'SERVER', 'TRANSPORT', QUOTA]), initialDelayMs: 5000, maxDelayMs: 1200000, jitterRatio: 0.1 });

// Only the clock and host event/projection boundary are fakes: both actual engines
// execute their own unmodified waits, event commits, recovery and disposal paths.
function clock() {
  const savedSet = globalThis.setTimeout, savedClear = globalThis.clearTimeout;
  const timers = new Map();
  let now = 0, id = 0;
  globalThis.setTimeout = (callback, delay) => { const key = ++id; timers.set(key, { callback, at: now + delay, delay }); return key; };
  globalThis.clearTimeout = key => timers.delete(key);
  return {
    timers,
    advance(ms) {
      const target = now + ms;
      while (true) {
        const first = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        now = first[1].at; timers.delete(first[0]); first[1].callback();
      }
      now = target;
    },
    restore() { globalThis.setTimeout = savedSet; globalThis.clearTimeout = savedClear; },
  };
}
async function microtasks() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function host(engine, config = {}, random = () => 0.5) {
  let projection, listener, cleanup, state;
  const events = [], warnings = [];
  let downstreamCalls = 0;
  const session = { append(type, data) { const event = { type, data }; events.push(event); state = projection.apply(state, event); } };
  const ctx = {
    sessionProjections: {
      register(value) { projection = value; state = value.init(); },
      stateOf(queried, key) { assert.equal(queried, session); assert.equal(key, 'llmRetry'); return state; },
    },
    on(event, fn) { assert.equal(event, 'agent/request-error'); listener = fn; return () => { listener = undefined; }; },
    effect(factory) { cleanup = factory(); },
    logger: { warn(...args) { warnings.push(args); } },
  };
  engine.apply(ctx, config, { random });
  return {
    events, warnings, session,
    get state() { return state; }, get downstreamCalls() { return downstreamCalls; },
    request(failure, options = {}) {
      const signal = options.signal ?? new AbortController().signal;
      return listener({ agent: { session }, turn: 1, step: 1, provider: options.provider ?? 'google-antigravity', failure, retryPolicy: options.policy ?? policy, signal }, async () => { downstreamCalls++; return options.downstream?.(); });
    },
    dispose: () => cleanup(),
  };
}
function sanitized(h) {
  return { events: h.events.map(event => ({ ...event, data: { ...event.data, retryId: '<id>' } })), downstreamCalls: h.downstreamCalls, warnings: h.warnings.map(args => args[0]), state: Object.entries(h.state).map(([key, entry]) => [key, { ...entry, retryId: '<id>' }]) };
}
async function drive(h, c, failure, options) {
  const promise = h.request(failure, options);
  await microtasks();
  const pending = [...c.timers.values()];
  if (pending.length) { assert.equal(pending.length, 1); c.advance(pending[0].delay); }
  return promise;
}

// Serial subtests isolate the global fake clock without a test-only engine API.
test('offline official-engine differential and quota extension', async t => {
  await t.test('unchanged public API and projection schema', () => {
    assert.deepEqual(Object.keys(fork).sort(), Object.keys(official).sort());
    assert.equal(fork.name, official.name); assert.deepEqual(fork.inject, official.inject);
    assert.equal(fork.RetryId('opaque'), official.RetryId('opaque'));
  });
  const cases = [
    { name: 'nine normal local backoffs + exhausted budget', sequence: Array.from({ length: 10 }, () => ({ code: 'SERVER', message: 'safe' })) },
    { name: 'normal valid, over-cap, invalid and missing hints', sequence: [1, 1200000, 1200001, 0, -1, NaN, Infinity, undefined].map(providerRetryAfterMs => ({ code: 'RATE_LIMIT', message: 'safe', providerRetryAfterMs })) },
    { name: 'nonretryable remains terminal', sequence: [{ code: 'AUTH', message: 'safe' }] },
    { name: 'other provider quota code unchanged including missing hint', options: { provider: 'other' }, sequence: [{ code: QUOTA, message: 'safe' }, { code: QUOTA, message: 'safe', providerRetryAfterMs: DAY }] },
    { name: 'always preserves local fallback and unknown codes', options: { policy: { mode: 'always', initialDelayMs: 5000, maxDelayMs: 1200000, jitterRatio: 0.1 } }, sequence: [{ code: QUOTA, message: 'safe', providerRetryAfterMs: DAY }, { code: 'AUTH', message: 'safe' }] },
    { name: 'always respects downstream recovery', options: { policy: { mode: 'always', initialDelayMs: 5000, maxDelayMs: 1200000, jitterRatio: 0.1 }, downstream: () => ({ kind: 'retry' }) }, sequence: [{ code: 'AUTH', message: 'safe' }] },
    { name: 'always warns and recovers from downstream exception', options: { policy: { mode: 'always', initialDelayMs: 5000, maxDelayMs: 1200000, jitterRatio: 0.1 }, downstream: () => { throw new Error('safe'); } }, sequence: [{ code: 'AUTH', message: 'safe' }] },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const results = [];
    for (const engine of [official, fork]) {
      const c = clock(); const h = host(engine, {}, () => 1);
      try {
        const actions = [];
        for (const failure of item.sequence) actions.push(await drive(h, c, failure, item.options));
        results.push({ actions, ...sanitized(h) });
        await h.dispose(); assert.equal(c.timers.size, 0);
      } finally { c.restore(); }
    }
    assert.deepEqual(results[1], results[0]);
    if (item.name.startsWith('nine')) assert.equal(results[1].events.filter(e => e.type === 'llm/retry').at(-1).data.delayMs, 1200000);
  });
  await t.test('quota waits exactly to hint and shares nine retries with transient errors', async () => {
    const c = clock(); const h = host(fork);
    try {
      const pending = h.request({ code: QUOTA, message: 'reset reported', providerRetryAfterMs: DAY });
      await microtasks();
      assert.equal(h.events.length, 1); assert.equal(h.events[0].type, 'llm/retry');
      assert.equal(h.events[0].data.delayMs, DAY);
      c.advance(DAY - 1); await microtasks(); assert.equal(h.events.length, 1);
      c.advance(1); assert.deepEqual(await pending, { kind: 'retry' });
      for (let i = 1; i < 9; i++) assert.deepEqual(await drive(h, c, { code: i % 2 ? 'SERVER' : QUOTA, message: 'safe', ...(i % 2 ? {} : { providerRetryAfterMs: 7200000 }) }), { kind: 'retry' });
      const retries = h.events.filter(e => e.type === 'llm/retry');
      assert.deepEqual(retries.map(e => e.data.retry), [1,2,3,4,5,6,7,8,9]);
      assert.equal(new Set(retries.map(e => e.data.policyKey)).size, 1);
      assert.equal(new Set(retries.map(e => e.data.retryId)).size, 1);
      assert.equal(Object.keys(h.state).length, 1);
      assert.equal(retries.at(-2).data.delayMs, 640000);
      assert.equal(await drive(h, c, { code: QUOTA, message: 'safe', providerRetryAfterMs: DAY }), undefined);
      assert.equal(c.timers.size, 0); assert.equal(h.events.filter(e => e.type === 'llm/retry').length, 9);
      h.session.append('step/start', {}); assert.deepEqual(h.state, {});
      assert.deepEqual(await drive(h, c, { code: QUOTA, message: 'safe', providerRetryAfterMs: 7200000 }), { kind: 'retry' });
      h.session.append('turn/end', {}); assert.deepEqual(h.state, {});
      await h.dispose();
    } finally { c.restore(); }
  });
  await t.test('invalid gate hints never fall back to generic timers or downstream', async () => {
    const c = clock(); const h = host(fork);
    try {
      for (const hint of [undefined, 0, -1, NaN, Infinity, DAY + 1, '1000', null]) {
        assert.equal(await h.request({ code: QUOTA, message: 'safe', providerRetryAfterMs: hint }), undefined);
        assert.equal(c.timers.size, 0); assert.equal(h.events.length, 0);
      }
      assert.equal(h.downstreamCalls, 0); await h.dispose();
    } finally { c.restore(); }
  });
  await t.test('stable policy opt-in and configured smaller quota limit', async () => {
    const c = clock(); const h = host(fork, { maxQuotaWaitMs: 7200000 });
    try {
      assert.equal(await h.request({ code: QUOTA, message: 'safe', providerRetryAfterMs: 7200001 }), undefined);
      assert.deepEqual(await drive(h, c, { code: QUOTA, message: 'safe', providerRetryAfterMs: 7200000 }), { kind: 'retry' });
      const noOptIn = { ...policy, retryableCodes: ['RATE_LIMIT'] };
      assert.equal(await h.request({ code: QUOTA, message: 'safe', providerRetryAfterMs: DAY }, { policy: noOptIn }), undefined);
      assert.equal(h.events.length, 2); await h.dispose();
    } finally { c.restore(); }
  });
  for (const mode of ['cancel', 'dispose', 'preabort']) await t.test(`${mode}: official differential and quota cleanup`, async () => {
    const results = [];
    for (const engine of [official, fork]) {
      const c = clock(); const h = host(engine);
      try {
        const controller = new AbortController(); if (mode === 'preabort') controller.abort();
        const pending = h.request({ code: 'SERVER', message: 'safe' }, { signal: controller.signal });
        await microtasks();
        if (mode === 'cancel') controller.abort();
        await h.dispose(); assert.equal(await pending, undefined); assert.equal(c.timers.size, 0);
        results.push(sanitized(h));
      } finally { c.restore(); }
    }
    assert.deepEqual(results[1], results[0]);
    const c = clock(); const h = host(fork);
    try {
      const controller = new AbortController(); if (mode === 'preabort') controller.abort();
      const pending = h.request({ code: QUOTA, message: 'safe', providerRetryAfterMs: DAY }, { signal: controller.signal });
      await microtasks(); if (mode === 'cancel') controller.abort();
      await h.dispose(); assert.equal(await pending, undefined); assert.equal(c.timers.size, 0);
      assert.equal(h.events.some(e => e.type === 'llm/retry-started'), false);
      assert.equal(h.events.length, mode === 'preabort' ? 0 : 1);
    } finally { c.restore(); }
  });
  await t.test('executor config rejects nonfinite/out-of-range and unknown fields', () => {
    for (const value of [0, -1, DAY + 1, Infinity, NaN, '24h', null]) assert.throws(() => host(fork, { maxQuotaWaitMs: value }), /maxQuotaWaitMs/);
    assert.throws(() => host(fork, { retryPolicy: {} }), /belongs under each provider/);
    assert.throws(() => host(fork, { enabled: true }), /unknown key/);
    assert.equal(fork.Config({}).maxQuotaWaitMs, DAY);
  });
});
