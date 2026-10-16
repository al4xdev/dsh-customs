import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHost } from '../common.mjs';
import { createController } from './controller.mjs';
import { installAuxDriver } from './aux-driver.mjs';
const load = name => import(resolveHost(`@deepseek-ai/${name}`));
const [{ Context }, llm] = await Promise.all([load('cordis'), load('dsh-llm')]);

// These fixtures instantiate the installed native service, never a live provider.
// A stray transport request is a test failure, not an inference workload.
globalThis.fetch = () => { throw new Error('Network forbidden in auxiliary fixture'); };
globalThis.WebSocket = class { constructor() { throw new Error('Network forbidden in auxiliary fixture'); } };
const from = chunks => (async function* () { yield* chunks; })();
const text = value => ({ type: 'text-delta', index: 0, text: value });
const finish = (kind = 'stop', extra = {}) => ({ type: 'finish', reason: { kind }, ...extra });
const failed = (code = 'SERVER', facts = {}) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: 'fixture provider failure', ...facts } }, replayState: { response: 'FAILED_REPLAY_CANARY' } });
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const options = (extra = {}) => Object.freeze({ provider: 'native-fixture', model: 'model', messages: [{ role: 'user', content: [{ type: 'text', text: 'native input' }] }], purpose: 'compaction', ...extra });
function assertWarningPreparations(calls) {
  const original = calls[0];
  for (const [index, request] of calls.entries()) {
    assert.equal(request.system, original.system);
    assert.equal(request.messages.length, original.messages.length + index);
    assert.deepEqual(request.messages.slice(0, original.messages.length), original.messages);
    for (const warning of request.messages.slice(original.messages.length)) {
      assert.equal(warning.role, 'user'); assert.match(warning.content[0].text, /^harness warning:/);
      assert(!warning.content[0].text.includes('CANARY'));
    }
  }
}

async function runtime(factory, settings = {}) {
  const ctx = new Context(), calls = [], preparations = [], visits = [], timers = [], events = [], plans = [];
  await ctx.plugin(llm.default);
  const controller = createController(settings.config, { random: () => .5,
    setTimeout(callback, delay) { const timer = { delay, cancelled: false }; timers.push(timer); queueMicrotask(() => { if (!timer.cancelled) callback(); }); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
  });
  const scheduler = { ...controller, plan(input) { plans.push(input); return controller.plan(input); } };
  const adapter = new class extends llm.LlmAdapter {
    providerRetryPolicy() { return settings.registeredPolicy && llm.resolveRetryPolicy(settings.registeredPolicy, 'aux fixture'); }
    async resolveModel(provider, model) { return { provider, id: model, name: model, contextWindow: 100000, maxTokens: 1000, inputModalities: ['text'] }; }
    async prepareCall(...args) {
      const call = await super.prepareCall(...args); let dispatched = false;
      preparations.push(call);
      return { ...call, stream: request => { assert.equal(dispatched, false, 'adapter prepared handles are one-shot'); dispatched = true; return call.stream(request); } };
    }
    stream(request) { calls.push(request); return factory(request, calls.length, { ctx, controller, registration }); }
  }();
  const registration = ctx.llm.registerAdapter(['native-fixture', 'alternate-summary'], adapter);
  ctx.on('session/event', (_session, event) => events.push(event));
  ctx.on('llm/stream', (request, next) => { visits.push(request); return next(); });
  let observer;
  if (settings.bridgeOrder) {
    const { applyWithObserver } = await import('../codex-transient-close/index.mjs');
    const listeners = new Set();
    observer = { PROVIDER_FAILURE_OBSERVER_VERSION: 1, PROVIDER_FAILURE_APIS: Object.freeze(['openai-completions']), subscribeProviderFailures(callback) { listeners.add(callback); return () => listeners.delete(callback); }, emit(dto) { for (const callback of listeners) callback(Object.freeze(dto)); } };
    ctx.on('aux/fixture-report', () => observer.emit({ provider: 'native-fixture', api: 'openai-completions', code: 'SERVER', message: 'safe observer DTO', status: 503 }));
    if (settings.bridgeOrder === 'before') applyWithObserver(ctx, observer);
    installAuxDriver(ctx, scheduler);
    if (settings.bridgeOrder === 'after') applyWithObserver(ctx, observer);
  } else installAuxDriver(ctx, scheduler);
  return { ctx, controller, calls, preparations, visits, timers, events, plans, registration, observer,
    async close() { await controller.dispose(); await ctx.fiber.dispose(); },
  };
}

test('native prepared call is retained initially and recreated per retry without bypassing middlewares', async () => {
  const h = await runtime((_request, n) => from(n === 1 ? [text('discard'), failed()] : [text('native winner'), finish('stop', { replayState: { response: 'winning-id' } })]));
  try {
    const prepared = await h.ctx.llm.prepareCall({ provider: 'native-fixture', model: 'model' });
    const request = Object.freeze({ ...options(), ...prepared.config });
    const output = await collect(prepared.stream(request));
    assert.deepEqual(output, [text('native winner'), finish('stop', { replayState: { response: 'winning-id' } })]);
    assert.equal(h.preparations.length, 2); assert.equal(new Set(h.preparations).size, 2);
    assert.equal(h.calls.length, 2); assert.equal(h.visits.length, 2); assert.equal(h.visits[0], request);
    assert(Object.isFrozen(h.visits[1])); assert(Object.isFrozen(h.visits[1].messages));
    assert.deepEqual(h.timers.map(timer => timer.delay), [7032]);
    assertWarningPreparations(h.calls);
    assert.throws(() => prepared.stream(request), { code: 'INVALID_PREPARED_CALL' });
    assert.equal(h.events.filter(event => event.type.startsWith('llm/retry')).length, 0);
  } finally { await h.close(); }
});

test('native adapter throw is normalized by the native boundary before auxiliary retry', async () => {
  const h = await runtime((_request, n) => (async function* () {
    if (n === 1) { yield text('failed native partial'); throw new llm.LlmError('native 503', 'SERVER', { status: 503 }); }
    yield text('native recovered'); yield finish();
  })());
  try { assert.deepEqual(await collect(h.ctx.llm.stream(options())), [text('native recovered'), finish()]); assert.equal(h.calls.length, 2); }
  finally { await h.close(); }
});

test('native malformed status and hint facts stop before the shared planner with a visible warning', async () => {
  for (const facts of [{ status: 600 }, { status: '503' }, { status: 599.5 }, { status: null },
    { providerRetryAfterMs: -1 }, { providerRetryAfterMs: '7000' }]) {
    const h = await runtime(() => from([text('MALFORMED_PREFIX_CANARY'), failed('SERVER', { ...facts, message: 'UNTRUSTED_ERROR_CANARY' })]));
    try {
      const result = await collect(h.ctx.llm.stream(options()));
      assert.equal(result.length, 1); assert.equal(result[0].reason.kind, 'error');
      assert.equal(result[0].reason.failure.code, 'SERVER');
      assert.match(result[0].reason.failure.message, /^harness warning:/);
      assert(!JSON.stringify(result).includes('CANARY'));
      assert.equal(h.calls.length, 1); assert.equal(h.preparations.length, 1);
      assert.deepEqual(h.timers, []); assert.deepEqual(h.plans, [], 'AUX admission must reject invalid facts even before controller validation');
      assert.equal(h.events.filter(event => event.type.startsWith('llm/retry')).length, 0);
    } finally { await h.close(); }
  }
});

test('native nonfinite failure facts remain visible protocol errors without a timer or another preparation', async () => {
  // Non-JSON numbers are rejected earlier than classification. Do not weaken
  // the winner/chunk protocol to stringify them as seemingly valid facts.
  for (const status of [NaN, Infinity, -Infinity]) {
    const h = await runtime(() => from([failed('SERVER', { status })]));
    try {
      await assert.rejects(collect(h.ctx.llm.stream(options())), { code: 'AUXILIARY_PROTOCOL_INVALID' });
      assert.equal(h.calls.length, 1); assert.equal(h.preparations.length, 1);
      assert.deepEqual(h.timers, []); assert.deepEqual(h.plans, []);
    } finally { await h.close(); }
  }
});

test('main brand remains native-owned and is never retried by the auxiliary driver', async () => {
  const h = await runtime(() => from([failed()]));
  try {
    const request = Object.freeze(llm.markAgentLoopRequest({ ...options() }));
    assert.equal((await collect(h.ctx.llm.stream(request)))[0].reason.failure.code, 'SERVER');
    assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, []); assert(llm.isAgentLoopRequest(h.visits[0]));
  } finally { await h.close(); }
});

test('native service middleware throws are not adapter failures and cannot create retries', async () => {
  const error = new Error('middleware failure');
  const h = await runtime(() => from([finish()]));
  h.ctx.on('llm/stream', () => { throw error; });
  try { await assert.rejects(collect(h.ctx.llm.stream(options())), value => value === error); assert.equal(h.calls.length, 0); assert.deepEqual(h.timers, []); }
  finally { await h.close(); }
});

test('actual typed-failure bridge classifies every attempt in either installation order', async () => {
  for (const bridgeOrder of ['before', 'after']) {
    const h = await runtime((_request, n, { ctx }) => (async function* () {
      if (n < 3) { ctx.emit('aux/fixture-report'); yield failed('PI_AI_ERROR'); }
      else { yield text('classified winner'); yield finish(); }
    })(), { bridgeOrder });
    try {
      assert.deepEqual(await collect(h.ctx.llm.stream(options())), [text('classified winner'), finish()]);
      assert.equal(h.calls.length, 3); assert.equal(h.visits.length, 3); assert.deepEqual(h.timers.map(timer => timer.delay), [7032, 14063]);
      assertWarningPreparations(h.calls);
    } finally { await h.close(); }
  }
});

test('native adapter registration replacement cannot silently change a retry generation', async () => {
  const h = await runtime((_request, _n, { registration }) => (async function* () { registration.replace(['native-fixture', 'alternate-summary']); yield failed(); })());
  try { await assert.rejects(collect(h.ctx.llm.stream(options())), { code: 'AUXILIARY_RETRY_UNSAFE' }); assert.equal(h.calls.length, 1); assert.deepEqual(h.timers, []); }
  finally { await h.close(); }
});

test('native manual compaction retries alternate-provider inference but commits its transaction exactly once', async () => {
  const h = await runtime((request, n) => {
    assert.equal(request.provider, 'alternate-summary'); assert.equal(request.purpose, 'compaction');
    assert(!llm.isAgentLoopRequest(request));
    return from(n < 3 ? [text('FAILED_SUMMARY_CANARY'), { type: 'usage', usage: { inputTokens: 500, outputTokens: 10, totalTokens: 510 } }, failed()]
      : [text('Useful checkpoint.'), { type: 'usage', usage: { inputTokens: 100, outputTokens: 3, totalTokens: 103 } }, finish()]);
  });
  try {
    for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-token-meter']) await h.ctx.plugin((await load(name)).default);
    await h.ctx.plugin((await load('dsh-agent-loop')).default, { agents: [], maxParallelToolCalls: 1 });
    await h.ctx.plugin((await load('dsh-compaction-basic')).default, { auto: false, summarizationProvider: 'alternate-summary', summarizationModel: 'model', maxTokens: 128 });
    const { agent } = await h.ctx.agents.create({ sessionId: 'aux-native-manual-compaction', agentOptions: { provider: 'native-fixture', model: 'model' }, meta: { cwd: process.cwd() } });
    agent.session.append('request/header', { reason: 'fixture', header: { config: { provider: 'native-fixture', model: 'model' } } });
    for (const value of ['long earlier input '.repeat(1000), 'long next input '.repeat(1000), 'keep latest input']) agent.session.append('user/message', llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: value }] }), { surfaceOp: 'append' });
    const result = await h.ctx.compaction.compactNow(agent, new AbortController().signal);
    assert(result); assert.equal(h.calls.length, 3); assert.equal(h.preparations.length, 3);
    const kinds = h.events.map(event => event.type);
    assert.equal(kinds.filter(kind => kind === 'compaction/start').length, 1);
    assert.equal(kinds.filter(kind => kind === 'compaction/summary').length, 1);
    assert.equal(kinds.filter(kind => kind === 'compaction/end').length, 1);
    assert.equal(h.events.filter(event => event.type === 'user/message' && event.surfaceOp?.op === 'replace').length, 1);
    assert.equal(kinds.filter(kind => kind.startsWith('llm/retry')).length, 0);
    assert.equal(kinds.filter(kind => kind === 'tool/call').length, 0);
    const summary = h.events.find(event => event.type === 'compaction/summary');
    assert.equal(summary.data.provider, 'alternate-summary');
    assert.deepEqual(summary.data.usage, { inputTokens: 100, outputTokens: 3, totalTokens: 103 });
    assert(!JSON.stringify(summary).includes('FAILED_'));
    assert.deepEqual(h.timers.map(timer => timer.delay), [7032, 14063]);
    assertWarningPreparations(h.calls);
    assert.equal(h.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'self-heal-observation').length, 0);
  } finally { await h.close(); }
});

test('native stalled initial/retry reads close promptly without claiming forced initial transport abort', { timeout: 3000 }, async () => {
  for (const stallAt of [1, 2]) {
    let release, started, sourceOptions;
    const pendingSource = new Promise(resolve => { release = resolve; });
    const sourceStarted = new Promise(resolve => { started = resolve; });
    const h = await runtime((request, n) => n < stallAt ? from([failed()]) : (async function* () { sourceOptions = request; started(); await pendingSource; yield finish(); })());
    const caller = new AbortController();
    const iterator = h.ctx.llm.stream(options({ signal: caller.signal }));
    const pending = iterator.next();
    try {
      await sourceStarted;
      assert.equal(sourceOptions.signal === caller.signal, stallAt === 1);
      await iterator.return();
      await assert.rejects(pending, { code: 'ABORTED' });
      assert.equal(caller.signal.aborted, false);
      assert.equal(sourceOptions.signal.aborted, stallAt !== 1);
      await h.ctx.fiber.dispose();
      assert.equal(h.calls.length, stallAt);
    } finally { release(); await h.close(); }
  }
});
