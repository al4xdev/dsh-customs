import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHost } from '../../common.mjs';
const { createController } = await import(process.env.RESILIENCE_CONTROLLER_MODULE ?? '../../llm-resilience/controller.mjs');
const { createController: legacyV2Controller } = await import('../../llm-resilience/lib/index-v2-unified.mjs');
import { installMainDriver, retryStateKey } from '../../llm-resilience/main-driver.mjs';
import { policyKey, MAX_DELAY_MS, MAX_PROVIDER_WAIT_MS } from '../../llm-resilience/policy.mjs';
const { apply } = await import(process.env.SELF_HEAL_PLUGIN_MODULE ?? '../index.mjs');
import { harnessWarningText, sanitizeFailure } from '../sanitizer.mjs';
const { Context } = await import(resolveHost('@deepseek-ai/cordis'));
const nominal = Array.from({ length: 10 }, (_, i) => 7031.25 * 2 ** i);
const delayOf = cycle => Math.ceil(nominal[Math.min(cycle, 10) - 1]);
async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture({ config = {}, local = {}, appendFailure = false, seed = {}, ledger = {}, accounting, startSeq = 1, controllerFactory = createController, initiator, onAppend, internals = {} } = {}) {
  const ctx = new Context(), events = [], timers = new Map(), states = new Map(), projections = new Map(), logs = [];
  for (const level of ['debug', 'info', 'warn']) ctx.logger[level] = text => logs.push({ level, text });
  let seq = startSeq, id = 0, nextCalls = 0, position = { turn: 1, step: 1 };
  const controller = controllerFactory(config, { random: () => .5, setTimeout(fn, delay) { timers.set(++id, { fn, delay }); return id; }, clearTimeout(id) { timers.delete(id); }, ...internals });
  const signal = new AbortController();
  const session = { id: 'unified-warning', append(type, data, options = {}) {
    if (appendFailure && type === 'user/message') throw new Error('private admission error');
    const event = { seq: ++seq, time: 0, type, data, ...options }; events.push(event);
    onAppend?.(event);
    for (const [key, p] of projections) states.set(key, p.apply(states.get(key), event));
    ctx.emit('session/event', session, event); return event;
  } };
  const agent = { id: session.id, session, options: { provider: 'private-provider', model: 'private-model' } }; let live = agent;
  ctx.provide('agents', { get: key => key === agent.id ? live : undefined, currentInitiator: () => initiator?.() });
  ctx.provide('sessionProjections', { register(p) { projections.set(p.key, p); states.set(p.key, p.init()); return () => projections.delete(p.key); }, stateOf(s, key) { assert.equal(s, session); assert(states.has(key), key); return states.get(key); } });
  installMainDriver(ctx, controller);
  ctx.provide('llmRecoveryUnbounded', controller);
  apply(ctx, local);
  session.append('step/start', { turn: 1, step: 1 });
  for (const [key, row] of Object.entries(ledger)) {
    const [provider, policyKey] = JSON.parse(key);
    session.append('llm/retry', { provider, policyKey, ...row, ...position });
  }
  states.set('agentSelfHeal', { ...states.get('agentSelfHeal'), ...seed });
  states.set('llmRecoveryAccounting', accounting ?? { ...states.get('llmRecoveryAccounting'), witness: states.get('agentSelfHeal') });
  events.length = 0;
  return { ctx, agent, session, controller, events, timers, signal, states, logs, get nextCalls() { return nextCalls; }, detach() { live = undefined; },
    warnings() { return events.filter(e => e.type === 'user/message'); },
    refusals() { return logs.filter(entry => entry.text.startsWith('agent-self-heal: recovery refused')).map(entry => entry.text); },
    start(turn, step = 1) { position = { turn, step }; session.append('step/start', position); },
    tick() { assert.equal(timers.size, 1); const [key, timer] = [...timers][0]; timers.delete(key); timer.fn(); return timer.delay; },
    human(target = 'next-step', source = { kind: 'user', rpcId: 'fixture-human-rpc' }) {
      const message = { id: `human-${seq}`, role: 'user', source, content: [{ type: 'text', text: 'are you there?' }] };
      const splice = session.append('agent/inbox/spliced', { target, start: 0, removedCount: 0, inserted: [message] });
      ctx.emit('agent/inbox/inserted', { agent, message });
      return splice.seq;
    },
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
test('unbounded default: retries continue past ten at the 60-minute cap with ONE warning for a repeated code', async () => {
  const f = fixture();
  try {
    for (let cycle = 1; cycle <= 25; cycle++) {
      const { pending } = await f.request('TRANSPORT'); await microtasks();
      assert.equal(f.events.at(-1).type, 'llm/retry');
      assert.equal(f.tick(), delayOf(cycle)); assert.deepEqual(await pending, { kind: 'retry' });
      assert.equal(f.states.get('agentSelfHeal').chain.cycle, cycle);
    }
    assert.equal(f.nextCalls, 0); assert.equal(f.timers.size, 0);
    assert.equal(f.warnings().length, 1, 'only the first failure of the chain warns');
    const warning = f.warnings()[0];
    assert.match(warning.data.content[0].text, /^harness warning:/); assert(!/retry \d+ of/.test(warning.data.content[0].text));
    assert(!JSON.stringify(warning).includes('private-provider'));
    const mirrors = f.events.filter(e => e.type === 'llm/retry');
    assert.equal(mirrors.length, 25); assert(mirrors.every(e => e.data.mode === 'always' && !('maxRetries' in e.data)));
    assert.deepEqual(mirrors.slice(9).map(e => e.data.delayMs), Array(16).fill(MAX_DELAY_MS));
    const chain = f.states.get('agentSelfHeal').chain;
    assert.equal(chain.warnedCode, 'TRANSPORT'); assert.equal(chain.warnings, 1); assert.equal(chain.messageId, warning.data.id);
    assert.equal(f.states.get('llmRecoveryAccounting').ownership.retry, 25); assert.equal(f.states.get('llmRecoveryAccounting').unsafe, false);
    assert(f.events.filter(e => e.type === 'agent/self-heal').every(e => e.data.version === 2 && e.data.state.policyVersion === 3));
  } finally { await f.close(); }
});
test('a changed error code adds a new warning; the same code again does not', async () => {
  const f = fixture();
  try {
    for (const [index, code] of ['TRANSPORT', 'TRANSPORT', 'SERVER', 'SERVER', 'SERVER', 'TIMEOUT'].entries()) {
      const { pending } = await f.request(code); await microtasks(); f.tick(); assert.deepEqual(await pending, { kind: 'retry' });
      assert.equal(f.states.get('agentSelfHeal').chain.cycle, index + 1);
    }
    assert.deepEqual(f.warnings().map(e => JSON.parse(e.data.content[0].text.split('\n')[1]).code), ['TRANSPORT', 'SERVER', 'TIMEOUT']);
    assert.equal(f.states.get('agentSelfHeal').chain.warnings, 3);
  } finally { await f.close(); }
});
test('explicit finite cap10 is honored: ten reservations, warnings on code change, one visible terminal notice', async () => {
  const f = fixture({ config: { policy: { maxRetries: 10 } } });
  try {
    for (let i = 0; i < 10; i++) {
      const { pending } = await f.request(i < 5 ? 'SERVER' : 'TRANSPORT'); await microtasks();
      assert.equal(f.tick(), Math.ceil(nominal[i])); assert.deepEqual(await pending, { kind: 'retry' });
    }
    const { pending } = await f.request(); assert.equal(await pending, undefined);
    assert.equal(f.nextCalls, 0); assert.equal(f.timers.size, 0);
    const mirrors = f.events.filter(e => e.type === 'llm/retry');
    assert.equal(mirrors.length, 10); assert(mirrors.every(e => e.data.mode === 'normal' && e.data.maxRetries === 10));
    assert.equal(f.warnings().length, 3, 'SERVER, TRANSPORT, then the terminal stop');
    assert.match(f.warnings().at(-1).data.content[0].text, /^harness warning: recovery stopped/);
    assert.equal(f.states.get('agentSelfHeal').chain.cycle, 10); assert.equal(f.states.get('agentSelfHeal').chain.status, 'suspended');
    assert(f.refusals().includes('agent-self-heal: recovery refused (retry-budget-exhausted).'));
    // A later failure of the same suspended chain (e.g. autonomous continuation) stays quiet.
    const again = await f.request(); assert.equal(await again.pending, undefined); assert.equal(f.warnings().length, 3);
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
  ['local12 narrows the unbounded default', { local: { maxCycles: 12 } }, 12, 12, Infinity],
  ['old pinned7 cannot grow to route9', { config: { policy: { maxRetries: 7 }, providers: { 'private-provider': { maxRetries: 9 } } }, seed: { chain: { turn: 1, step: 1, cycle: 2, maxCycles: 7, status: 'retry-requested', attemptSeq: 1 } } }, 5, 7, 9],
  ['old pinned10 v6 chain stays finite under the unbounded default', { seed: { chain: { turn: 1, step: 1, cycle: 4, maxCycles: 10, status: 'retry-requested', attemptSeq: 1 }, policyVersion: 2 } }, 6, 10, Infinity],
]) test(`provider policy/admission regression: ${label}`, async () => {
  const f = fixture(options);
  try {
    const failure = Object.freeze({ code: 'SERVER', message: 'offline' });
    let aux = 0;
    while (aux < 40 && f.controller.plan({ provider: 'private-provider', failure, previousRetry: aux })) aux++;
    assert.equal(aux === 40 ? Infinity : aux, auxCap, 'main and aux inherit the same effective route policy; explicit main admission may only narrow');
    for (let i = 0; i < remaining; i++) { const { pending } = await f.request(); await microtasks(); f.tick(); assert.deepEqual(await pending, { kind: 'retry' }); }
    const terminal = await f.request(); assert.equal(await terminal.pending, undefined); assert.equal(f.nextCalls, 0);
    assert.equal(f.events.filter(e => e.type === 'llm/retry').length, remaining);
    assert.equal(f.events.filter(e => e.type === 'agent/self-heal' && e.data.action === 'reserved').length, remaining);
    assert.equal(f.states.get('agentSelfHeal').chain?.cycle ?? 0, finalCycle);
    assert.equal(f.timers.size, 0);
  } finally { await f.close(); }
});
test('contract-2 controllers cannot start the contract-3 owner (no silent mis-binding)', () => {
  const old = legacyV2Controller({}, {});
  const ctx = new Context();
  ctx.provide('agents', { get() {}, currentInitiator() {} });
  ctx.provide('sessionProjections', { register() { assert.fail('must refuse before registration'); }, stateOf() {} });
  ctx.provide('llmRecoveryUnbounded', old);
  assert.equal(old.recoveryVersion, 2);
  assert.throws(() => apply(ctx, {}), /contract 3 required/);
  return old.dispose();
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
test('failed warning admission consumes reserve but neither timer nor fallback, and is logged', async () => {
  const f = fixture({ appendFailure: true }); try {
    const { pending } = await f.request(); assert.equal(await pending, undefined); assert.equal(f.states.get('agentSelfHeal').chain.cycle, 1); assert.equal(f.timers.size, 0); assert.equal(f.nextCalls, 0);
    assert.deepEqual(f.refusals(), ['agent-self-heal: recovery refused (append-failed).']);
    assert(!JSON.stringify(f.logs).includes('private admission error'));
  } finally { await f.close(); }
});
test('legacy native plus semantic consumption imports ONCE; native mirrors are not credits', async () => {
  const policy = createController({ policy: { maxRetries: 10 } }).policyFor('private-provider');
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
test('provider minimum above 60min waits until the reset, generically, up to the 24h provider-wait cap', async () => {
  const f = fixture();
  try {
    for (const hint of [MAX_DELAY_MS + 1, 5 * MAX_DELAY_MS, MAX_PROVIDER_WAIT_MS]) {
      const { pending } = await f.request('RATE_LIMIT', { status: 429, providerRetryAfterMs: hint }); await microtasks();
      assert.equal(f.tick(), hint); assert.deepEqual(await pending, { kind: 'retry' });
      const reserved = f.events.filter(e => e.type === 'agent/self-heal' && e.data.action === 'reserved').at(-1);
      assert.equal(reserved.data.recoveryWait.delayMs, hint); assert.equal(reserved.data.recoveryWait.providerMinimumMs, hint);
    }
    assert.equal(f.warnings().length, 1);
    const over = await f.request('RATE_LIMIT', { status: 429, providerRetryAfterMs: MAX_PROVIDER_WAIT_MS + 1 });
    assert.equal(await over.pending, undefined); assert.equal(f.timers.size, 0); assert.equal(f.nextCalls, 0);
    assert.equal(f.states.get('agentSelfHeal').chain.status, 'suspended');
    assert.match(f.warnings().at(-1).data.content[0].text, /recovery stopped/);
    assert(f.refusals().includes('agent-self-heal: recovery refused (provider-wait-over-cap).'));
  } finally { await f.close(); }
});
for (const extra of [{ providerRetryAfterMs: -1 }, { providerRetryAfterMs: Infinity }, { providerRetryAfterMs: 0 }]) test(`malformed server minimum ${extra.providerRetryAfterMs} falls back to the local schedule, never terminal`, async () => {
  const f = fixture(); try {
    const { pending } = await f.request('SERVER', extra); await microtasks();
    assert.equal(f.tick(), delayOf(1)); assert.deepEqual(await pending, { kind: 'retry' }); assert.equal(f.nextCalls, 0);
    assert(f.logs.some(entry => entry.text === 'agent-self-heal: malformed provider minimum ignored; the local schedule applies.'));
  } finally { await f.close(); }
});
test('optout prevents both recovery engines, with an explicit terminal warning and a logged reason', async () => {
  const f = fixture(); try {
    const { pending } = await f.request('SERVER', {}, { mode: 'normal', maxRetries: 0 }); assert.equal(await pending, undefined); assert.equal(f.nextCalls, 0); assert.equal(f.timers.size, 0);
    assert.deepEqual(f.refusals(), ['agent-self-heal: recovery refused (route-opt-out).']);
  } finally { await f.close(); }
});
test('refusals are never silent and log only fixed reasons', async () => {
  const f = fixture(); try {
    const auth = await f.request('AUTH', { status: 401 }); assert.deepEqual(await auth.pending, { kind: 'retry' }, 'ineligible failures still delegate to next()');
    const first = await f.request(); await microtasks();
    // A concurrent second callback for the same agent is refused while the first waits.
    const concurrent = f.ctx.waterfall('agent/request-error', { agent: f.agent, turn: 1, step: 1, provider: 'private-provider', signal: f.signal.signal,
      failure: Object.freeze({ code: 'SERVER', message: 'second' }) }, async () => ({ kind: 'retry' }));
    assert.equal(await concurrent, undefined);
    f.tick(); assert.deepEqual(await first.pending, { kind: 'retry' });
    f.detach(); const stale = await f.request(); assert.equal(await stale.pending, undefined);
    assert.deepEqual(f.refusals(), ['agent-self-heal: recovery refused (ineligible-failure).',
      'agent-self-heal: recovery refused (concurrent-recovery).', 'agent-self-heal: recovery refused (stale-agent).']);
    assert(!JSON.stringify(f.logs).includes('mtmd') && !JSON.stringify(f.logs).includes('private-'));
  } finally { await f.close(); }
});
test('unsafe history refusal names its fixed provenance reason', async () => {
  const f = fixture(); try {
    f.session.append('llm/retry', { provider: 'private-provider', policyKey: '["normal",null,[],1,1,0]', retryId: 'bad', retry: 1, turn: 1, step: 1 });
    const { pending } = await f.request(); assert.equal(await pending, undefined); assert.equal(f.timers.size, 0);
    assert.deepEqual(f.refusals(), ['agent-self-heal: recovery refused (unsafe-history:unknown-native-provenance).']);
  } finally { await f.close(); }
});
test('a live human message during a long local wait starts the retry now', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 9; i++) { const { pending } = await f.request(); await microtasks(); f.tick(); await pending; }
    const { pending } = await f.request(); await microtasks();
    assert.equal([...f.timers.values()][0].delay, MAX_DELAY_MS);
    const inboxSeq = f.human('next-step');
    assert.deepEqual(await pending, { kind: 'retry' }); assert.equal(f.timers.size, 0);
    const requested = f.events.filter(e => e.type === 'agent/self-heal' && e.data.action === 'retry-requested').at(-1);
    assert.deepEqual(requested.data.recoveryWake, { version: 1, kind: 'live-human-inbox', inboxSeq });
    assert.equal(f.states.get('agentSelfHeal').chain.cycle, 10);
  } finally { await f.close(); }
});
test('a human wake never skips a provider minimum; model/peer or label-only inserts never wake', async () => {
  let initiator;
  const f = fixture({ initiator: () => initiator }); try {
    const { pending } = await f.request('RATE_LIMIT', { status: 429, providerRetryAfterMs: 2 * MAX_DELAY_MS }); await microtasks();
    f.human('next-turn', { kind: 'user' });
    initiator = { id: 'peer-agent' }; f.human('next-step'); initiator = undefined;
    assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].delay, 2 * MAX_DELAY_MS);
    f.human('next-turn');
    assert.equal(f.timers.size, 1, 'the remaining provider minimum is re-armed, not skipped');
    assert(([...f.timers.values()][0].delay) > 2 * MAX_DELAY_MS - 1000);
    f.tick(); assert.deepEqual(await pending, { kind: 'retry' });
  } finally { await f.close(); }
});
test('a chain resuming after a visible stop re-announces that it retries', async () => {
  const f = fixture(); try {
    const first = await f.request('TRANSPORT'); await microtasks(); f.tick(); await first.pending;
    const stop = await f.request('TRANSPORT', { providerRetryAfterMs: MAX_PROVIDER_WAIT_MS + 1 }); assert.equal(await stop.pending, undefined);
    assert.equal(f.states.get('agentSelfHeal').chain.status, 'suspended');
    assert.equal(f.warnings().length, 2);
    // Same code, but the last notice said "recovery stopped": announce the retry.
    const resumed = await f.request('TRANSPORT'); await microtasks(); f.tick(); assert.deepEqual(await resumed.pending, { kind: 'retry' });
    assert.equal(f.warnings().length, 3); assert.match(f.warnings().at(-1).data.content[0].text, /retries it automatically/);
    const quiet = await f.request('TRANSPORT'); await microtasks(); f.tick(); await quiet.pending;
    assert.equal(f.warnings().length, 3);
  } finally { await f.close(); }
});
test('a terminal notice skipped by cancellation is still announced on the next stop', async () => {
  let abortOnSuspend = true, f;
  f = fixture({ onAppend: event => { if (abortOnSuspend && event.type === 'agent/self-heal' && event.data.action === 'suspended') { abortOnSuspend = false; f.signal.abort(); } } });
  try {
    const first = await f.request('TRANSPORT'); await microtasks(); f.tick(); await first.pending;
    const stop = await f.request('TRANSPORT', { providerRetryAfterMs: MAX_PROVIDER_WAIT_MS + 1 }); assert.equal(await stop.pending, undefined);
    assert.equal(f.warnings().length, 1, 'the cancelled stop appended no notice');
    assert.equal(f.states.get('agentSelfHeal').chain.status, 'aborted');
  } finally { await f.close(); }
  // A fresh fixture shows the follow-up stop (new signal) is announced.
  const g = fixture({ seed: { chain: { turn: 1, step: 1, cycle: 1, maxCycles: 1, status: 'aborted', attemptSeq: 1, warnedCode: 'TRANSPORT', warnings: 1 } }, config: { policy: { maxRetries: 1 } } });
  try { const stop = await g.request('TRANSPORT'); assert.equal(await stop.pending, undefined); assert.equal(g.warnings().length, 1); assert.match(g.warnings()[0].data.content[0].text, /recovery stopped/); }
  finally { await g.close(); }
});
test('a 5h quota-reset wait ends on the next slice after an 8h system suspend (wall-clock notBeforeMs)', async () => {
  let mono = 0, wall = Date.now();
  const f = fixture({ internals: { now: () => mono, wallNow: () => wall, wallClockSliceMs: 60_000 } }); try {
    const { pending } = await f.request('RATE_LIMIT', { status: 429, providerRetryAfterMs: 5 * MAX_DELAY_MS }); await microtasks();
    const reserved = f.events.find(e => e.type === 'agent/self-heal' && e.data.action === 'reserved');
    assert.equal(reserved.data.recoveryWait.delayMs, 5 * MAX_DELAY_MS);
    assert.equal(f.tick(), 60_000);
    assert.equal(f.timers.size, 1, 'awake: still waiting');
    // Suspend: monotonic timers freeze while the wall clock passes the reset.
    wall = reserved.data.recoveryWait.notBeforeMs + 1;
    assert.equal(f.tick(), 60_000); assert.deepEqual(await pending, { kind: 'retry' });
    assert.equal(mono, 0); assert.equal(f.timers.size, 0);
  } finally { await f.close(); }
});
test('the llm/retry mirror never carries a malformed provider minimum', async () => {
  const f = fixture(); try {
    for (const [hint, kept] of [[-1, false], [0, false], ['7000', false], [7000, true]]) {
      const { pending } = await f.request('SERVER', { providerRetryAfterMs: hint }); await microtasks(); f.tick(); await pending;
      const mirror = f.events.filter(e => e.type === 'llm/retry').at(-1).data.failure;
      assert.equal(Object.hasOwn(mirror, 'providerRetryAfterMs'), kept, String(hint));
      assert.equal(mirror.code, 'SERVER');
    }
  } finally { await f.close(); }
});
test('cold owner/controller reload keeps spent floor and pinned schedule despite new config', async () => {
  const first = fixture(); let restored;
  try {
    const { pending } = await first.request(); await microtasks(); first.tick(); await pending;
    const clone = value => JSON.parse(JSON.stringify(value));
    restored = fixture({ startSeq: 100, config: { policy: { initialDelayMs: 14000 } },
      seed: clone(first.states.get('agentSelfHeal')), ledger: clone(first.states.get('llmRetry')), accounting: clone(first.states.get('llmRecoveryAccounting')) });
    const second = await restored.request('SERVER'); await microtasks();
    assert.equal(restored.tick(), Math.ceil(nominal[1])); assert.deepEqual(await second.pending, { kind: 'retry' });
    assert.equal(restored.states.get('agentSelfHeal').chain.cycle, 2);
    assert.equal(restored.states.get('llmRecoveryAccounting').ownership.importedConsumed, 0);
    assert.equal(restored.warnings().length, 0, 'the reloaded chain already warned for this code');
  } finally { await first.close(); await restored?.close(); }
});
test('safe diagnostics/renderer never copy arbitrary errors, suffixes, routes or instructions', () => {
  assert.equal(sanitizeFailure(Object.freeze({ code: 'SERVER', message: 'failed to process mtmd chunk' })).diagnosticCategory, 'image-input-processing');
  const facts = sanitizeFailure(Object.freeze({ code: 'SERVER', message: 'failed to process mtmd chunk CANARY', status: 500 }));
  assert.equal(facts.diagnosticCategory, 'model-request-failure');
  assert(!harnessWarningText({ ...facts, remediation: 'CANARY', message: 'CANARY', token: 'CANARY' }, { retry: 1, maxRetries: 10 }).includes('CANARY'));
  for (const f of [{ code: 'SERVER', message: 'x', status: 401 }, { code: 'SERVER', message: 'x', permanent: true }, { code: 'SERVER', message: 'x', cancelled: true }]) assert.equal(sanitizeFailure(Object.freeze(f)), undefined);
});
