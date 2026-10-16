import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHost } from '../../common.mjs';
const { createController } = await import(process.env.RESILIENCE_CONTROLLER_MODULE ?? '../../llm-resilience/controller.mjs');
const { createController: legacyV2Controller } = await import('../../llm-resilience/lib/index-v2-unified.mjs');
import { installMainDriver, retryStateKey } from '../../llm-resilience/main-driver.mjs';
import { policyKey } from '../../llm-resilience/policy.mjs';
const { apply } = await import(process.env.SELF_HEAL_PLUGIN_MODULE ?? '../index.mjs');
import { harnessWarningText, sanitizeFailure } from '../sanitizer.mjs';
import { stateSchema as legacyStateSchema } from '../lib/index-v3-resilience.mjs';
const { Context } = await import(resolveHost('@deepseek-ai/cordis'));
const nominal = Array.from({ length: 10 }, (_, i) => 7031.25 * 2 ** i);
async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture({ config = {}, local = {}, appendFailure = false, seed = {}, ledger = {}, accounting, startSeq = 1, controllerFactory = createController } = {}) {
  const ctx = new Context(), events = [], timers = new Map(), states = new Map(), projections = new Map();
  let seq = startSeq, id = 0, nextCalls = 0, position = { turn: 1, step: 1 };
  const controller = controllerFactory(config, { random: () => .5, setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); } });
  const signal = new AbortController();
  const session = { id: 'unified-warning', append(type, data, options = {}) {
    if (appendFailure && type === 'user/message') throw new Error('private admission error');
    const event = { seq: ++seq, time: 0, type, data, ...options }; events.push(event);
    for (const [key, p] of projections) states.set(key, p.apply(states.get(key), event));
    ctx.emit('session/event', session, event); return event;
  } };
  const agent = { id: session.id, session, options: { provider: 'private-provider', model: 'private-model' } }; let live = agent;
  ctx.provide('agents', { get: key => key === agent.id ? live : undefined, currentInitiator: () => undefined });
  ctx.provide('sessionProjections', { register(p) { projections.set(p.key, p); states.set(p.key, p.init()); return () => projections.delete(p.key); }, stateOf(s, key) { assert.equal(s, session); assert(states.has(key), key); return states.get(key); } });
  installMainDriver(ctx, controller); ctx.provide('llmResilience', controller); ctx.provide('llmRecovery', controller);
  // Legacy-policy compatibility is tested only behind a NEW history2 service
  // facade; the actual old module never provides the readiness alias.
  ctx.provide('llmRecoveryHistory', controller.recoveryHistoryVersion === 2 ? controller : Object.freeze({ ...controller, recoveryHistoryVersion: 2 }));
  apply(ctx, local);
  session.append('step/start', { turn: 1, step: 1 });
  for (const [key, row] of Object.entries(ledger)) {
    const [provider, policyKey] = JSON.parse(key);
    session.append('llm/retry', { provider, policyKey, ...row, ...position });
  }
  states.set('agentSelfHeal', { ...states.get('agentSelfHeal'), ...seed });
  states.set('llmRecoveryAccounting', accounting ?? { ...states.get('llmRecoveryAccounting'), witness: states.get('agentSelfHeal') });
  events.length = 0;
  return { ctx, agent, controller, events, timers, signal, states, get nextCalls() { return nextCalls; }, detach() { live = undefined; },
    start(turn, step = 1) { position = { turn, step }; session.append('step/start', position); },
    tick() { assert.equal(timers.size, 1); const [key, timer] = [...timers][0]; timers.delete(key); timer.fn(); return timer.delay; },
    async request(code = 'SERVER', extra = {}, retryPolicy) {
      const attemptId = `a-${seq}`;
      await ctx.parallel('agent/assistant-stream', { agent, frame: { type: 'start', attemptId, ...position } });
      const e = session.append('assistant/attempt', position);
      await ctx.parallel('agent/assistant-stream', { agent, frame: { type: 'end', attemptId, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: e.seq } } });
      return { pending: ctx.waterfall('agent/request-error', { agent, ...position, provider: 'private-provider', retryPolicy, signal: signal.signal,
        failure: Object.freeze({ code, message: 'failed to process mtmd chunk', ...extra }) }, async () => { nextCalls++; return { kind: 'retry' }; }) };
    },
    async close() { await ctx.fiber.dispose(); await controller.dispose(); assert.equal(timers.size, 0); },
  };
}
test('SERVER warning precedes retry; exactly ten shared reservations and a visible terminal notice', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10; i++) {
      const { pending } = await f.request(i % 2 ? 'TRANSPORT' : 'SERVER'); await microtasks();
      const warning = f.events.filter(e => e.type === 'user/message').at(-1);
      assert.match(warning.data.content[0].text, /^harness warning:/);
      assert(!JSON.stringify(warning).includes('private-provider'));
      assert.equal(f.events.at(-1).type, 'llm/retry');
      assert.equal(f.tick(), Math.ceil(nominal[i])); assert.deepEqual(await pending, { kind: 'retry' });
      const state = f.states.get('agentSelfHeal'); assert.equal(state.chain.cycle, i + 1);
      assert.doesNotThrow(() => legacyStateSchema.parse(state));
    }
    const { pending } = await f.request(); assert.equal(await pending, undefined);
    assert.equal(f.nextCalls, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.events.filter(e => e.type === 'llm/retry').length, 10);
    assert.equal(f.events.filter(e => e.type === 'user/message').length, 11);
    assert.match(f.events.at(-1).data.content[0].text, /Recovery stopped/);
    assert.equal(f.states.get('agentSelfHeal').chain.cycle, 10);
  } finally { await f.close(); }
});
for (const [label, options, remaining, finalCycle, auxCap] of [
  ['base7/route9', { config: { policy: { maxRetries: 7 }, providers: { 'private-provider': { maxRetries: 9 } } } }, 9, 9, 9],
  ['base0/route2 captures failed attempts', { config: { policy: { maxRetries: 0 }, providers: { 'private-provider': { maxRetries: 2 } } } }, 2, 2, 2],
  ['base7/route3', { config: { policy: { maxRetries: 7 }, providers: { 'private-provider': { maxRetries: 3 } } } }, 3, 3, 3],
  ['unknown route uses base7', { config: { policy: { maxRetries: 7 }, providers: { other: { maxRetries: 9 } } } }, 7, 7, 7],
  ['explicit route0', { config: { policy: { maxRetries: 7 }, providers: { 'private-provider': { maxRetries: 0 } } } }, 0, 0, 0],
  ['legacy selfHeal4 narrows route9', { config: { policy: { maxRetries: 7 }, providers: { 'private-provider': { maxRetries: 9 } }, selfHeal: { maxCycles: 4 } } }, 4, 4, 9],
  ['local2 and legacy3 narrow route9', { local: { maxCycles: 2 }, config: { policy: { maxRetries: 7 }, providers: { 'private-provider': { maxRetries: 9 } }, selfHeal: { maxCycles: 3 } } }, 2, 2, 9],
  ['old pinned7 cannot grow to route9', { config: { policy: { maxRetries: 7 }, providers: { 'private-provider': { maxRetries: 9 } } }, seed: { chain: { turn: 1, step: 1, cycle: 2, maxCycles: 7, status: 'retry-requested', attemptSeq: 1 } } }, 5, 7, 9],
]) test(`provider policy/admission regression: ${label}`, async () => {
  const f = fixture(options);
  try {
    const failure = Object.freeze({ code: 'SERVER', message: 'offline' });
    let aux = 0;
    while (f.controller.plan({ provider: 'private-provider', failure, previousRetry: aux })) { assert(aux++ < 10); }
    assert.equal(aux, auxCap, 'main and aux inherit the same effective route policy; explicit main admission may only narrow');
    for (let i = 0; i < remaining; i++) { const { pending } = await f.request(); await microtasks(); f.tick(); assert.deepEqual(await pending, { kind: 'retry' }); }
    const terminal = await f.request(); assert.equal(await terminal.pending, undefined); assert.equal(f.nextCalls, 0);
    assert.equal(f.events.filter(e => e.type === 'llm/retry').length, remaining);
    assert.equal(f.events.filter(e => e.type === 'agent/self-heal' && e.data.action === 'reserved').length, remaining);
    assert.equal(f.states.get('agentSelfHeal').chain?.cycle ?? 0, finalCycle);
    assert.equal(f.timers.size, 0);
  } finally { await f.close(); }
});
test('old controller2 warm compatibility remains conservative and pins its admitted cap after replacement', async () => {
  const config = { policy: { maxRetries: 7 }, providers: { 'private-provider': { maxRetries: 9 } } };
  const old = fixture({ config, controllerFactory: legacyV2Controller }); let current;
  try {
    assert.equal(old.controller.config.selfHeal.maxCycles, 7);
    const first = await old.request(); await microtasks(); old.tick(); await first.pending;
    assert.equal(old.states.get('agentSelfHeal').chain.maxCycles, 7);
    const clone = v => JSON.parse(JSON.stringify(v));
    current = fixture({ config, startSeq: 100, seed: clone(old.states.get('agentSelfHeal')), ledger: clone(old.states.get('llmRetry')), accounting: clone(old.states.get('llmRecoveryAccounting')) });
    const second = await current.request(); await microtasks(); current.tick(); assert.deepEqual(await second.pending, { kind: 'retry' });
    assert.equal(current.states.get('agentSelfHeal').chain.maxCycles, 7); assert.equal(current.states.get('agentSelfHeal').chain.cycle, 2);
  } finally { await old.close(); await current?.close(); }
});
test('FIRST empty answer is contextual recovery, not a prerequisite blind retry', async () => {
  const f = fixture(); try { const { pending } = await f.request('EMPTY_RESPONSE'); await microtasks(); f.tick(); assert.deepEqual(await pending, { kind: 'retry' }); assert.equal(f.nextCalls, 0); } finally { await f.close(); }
});
for (const stop of ['caller', 'controller', 'dispose', 'detached']) test(`cancel/dispose/detach never refunds ${stop}`, async () => {
  const f = fixture(); try {
    const { pending } = await f.request(); await microtasks();
    if (stop === 'caller') f.signal.abort(); else if (stop === 'controller') await f.controller.dispose(); else if (stop === 'dispose') await f.ctx.fiber.dispose(); else { f.detach(); f.tick(); }
    assert.equal(await pending, undefined); assert.equal(f.states.get('agentSelfHeal').chain.cycle, 1); assert.equal(f.nextCalls, 0);
    assert.equal(f.events.some(e => e.type === 'llm/retry-started'), false);
  } finally { await f.close(); }
});
test('failed warning admission consumes reserve but neither timer nor fallback', async () => {
  const f = fixture({ appendFailure: true }); try { const { pending } = await f.request(); assert.equal(await pending, undefined); assert.equal(f.states.get('agentSelfHeal').chain.cycle, 1); assert.equal(f.timers.size, 0); assert.equal(f.nextCalls, 0); } finally { await f.close(); }
});
test('legacy native plus semantic consumption imports ONCE; native mirrors are not credits', async () => {
  const policy = createController().policyFor('private-provider');
  const f = fixture({ seed: { chain: { turn: 1, step: 1, cycle: 1, maxCycles: 3, status: 'retry-requested', attemptSeq: 1 } },
    ledger: { [retryStateKey('other-provider', policyKey(policy))]: { retry: 1, retryId: 'legacy' } } });
  try {
    const { pending } = await f.request(); await microtasks(); f.tick(); assert.deepEqual(await pending, { kind: 'retry' });
    assert.equal(f.states.get('agentSelfHeal').chain.cycle, 3);
    const owner = f.states.get('llmRecoveryAccounting').ownership;
    assert.equal(owner.importedConsumed, 2); assert.equal(owner.legacyNativeConsumed, 1);
    const next = await f.request('TIMEOUT'); assert.equal(await next.pending, undefined);
    assert.equal(f.events.filter(e => e.type === 'llm/retry').length, 1);
  } finally { await f.close(); }
});
for (const extra of [{ providerRetryAfterMs: 3600001 }, { providerRetryAfterMs: -1 }, { providerRetryAfterMs: Infinity }]) test('bad server minimum produces terminal warning, never fallback', async () => {
  const f = fixture(); try { const { pending } = await f.request('SERVER', extra); assert.equal(await pending, undefined); assert.equal(f.nextCalls, 0); assert.equal(f.timers.size, 0); assert.match(f.events.at(-1).data.content[0].text, /Recovery stopped/); } finally { await f.close(); }
});
test('optout prevents both recovery engines, with an explicit terminal warning', async () => {
  const f = fixture(); try { const { pending } = await f.request('SERVER', {}, { mode: 'normal', maxRetries: 0 }); assert.equal(await pending, undefined); assert.equal(f.nextCalls, 0); assert.equal(f.timers.size, 0); } finally { await f.close(); }
});
test('cold owner/controller reload keeps spent floor and pinned schedule despite new config', async () => {
  const first = fixture(); let restored;
  try {
    const { pending } = await first.request(); await microtasks(); first.tick(); await pending;
    const clone = value => JSON.parse(JSON.stringify(value));
    restored = fixture({ startSeq: 100, config: { policy: { initialDelayMs: 14000 } },
      seed: clone(first.states.get('agentSelfHeal')), ledger: clone(first.states.get('llmRetry')), accounting: clone(first.states.get('llmRecoveryAccounting')) });
    const second = await restored.request('TRANSPORT'); await microtasks();
    assert.equal(restored.tick(), Math.ceil(nominal[1])); assert.deepEqual(await second.pending, { kind: 'retry' });
    assert.equal(restored.states.get('agentSelfHeal').chain.cycle, 2);
    assert.equal(restored.states.get('llmRecoveryAccounting').ownership.importedConsumed, 0);
  } finally { await first.close(); await restored?.close(); }
});
test('safe diagnostics/renderer never copy arbitrary errors, suffixes, routes or instructions', () => {
  assert.equal(sanitizeFailure(Object.freeze({ code: 'SERVER', message: 'failed to process mtmd chunk' })).diagnosticCategory, 'image-input-processing');
  const facts = sanitizeFailure(Object.freeze({ code: 'SERVER', message: 'failed to process mtmd chunk CANARY', status: 500 }));
  assert.equal(facts.diagnosticCategory, 'model-request-failure');
  assert(!harnessWarningText({ ...facts, remediation: 'CANARY', message: 'CANARY', token: 'CANARY' }, { retry: 1, maxRetries: 10 }).includes('CANARY'));
  for (const f of [{ code: 'SERVER', message: 'x', status: 401 }, { code: 'SERVER', message: 'x', permanent: true }, { code: 'SERVER', message: 'x', cancelled: true }]) assert.equal(sanitizeFailure(Object.freeze(f)), undefined);
});
