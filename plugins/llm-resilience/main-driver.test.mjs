import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { mkdtemp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const controllerModule = await import(process.env.RESILIENCE_CONTROLLER_MODULE ?? './controller.mjs');
const { createController } = controllerModule;
const fullController = Boolean(process.env.RESILIENCE_CONTROLLER_MODULE && controllerModule.apply);
import { installMainDriver, llmRetryProjection, retryStateKey } from './main-driver.mjs';
const { apply: selfHealApply } = await import(process.env.SELF_HEAL_PLUGIN_MODULE ?? '../agent-self-heal/index.mjs');
import { resolveHost } from '../common.mjs';
const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function coldLegacy(ctx, host, agent, compression) {
  const { default: Jsonl } = await host('dsh-session-persistence-jsonl');
  const scratch = fileURLToPath(new URL('../../.dumps/unified-recovery-112/', import.meta.url));
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'native-legacy-history-'));
  const backend = new Jsonl(ctx, { root, compression });
  const writer = await backend.create(agent.session.header);
  // Test export only: include native initialization events that precede the
  // observer attachment; the production recovery path never scans a Session.
  await writer.append(agent.session.snapshotEvents()); await writer.flush(); await writer.close();
  const directory = dirname(backend.locate(agent.session.header).path);
  const fingerprint = async () => Object.fromEntries(await Promise.all((await readdir(directory)).sort().map(async name => {
    const path = join(directory, name), info = await stat(path);
    assert(info.isFile()); return [name, { bytes: info.size, mtimeMs: info.mtimeMs, sha256: hash(await readFile(path)) }];
  })));
  const before = await fingerprint();
  const reader = fileURLToPath(new URL('../agent-self-heal/tests/persistence.test.mjs', import.meta.url));
  const { stdout, stderr } = await exec(process.execPath, [reader, '--self-heal-read', JSON.stringify({ root, compression, id: agent.session.id, provider: 'new-route' })], { timeout: 120000 });
  assert.equal(stderr, ''); const restored = JSON.parse(stdout), after = await fingerprint(); assert.deepEqual(after, before);
  return { root, compression, before, after, restored };
}
const nominal = Array.from({ length: 10 }, (_, i) => 7031.25 * 2 ** i);
async function runtime(settings) {
  globalThis.fetch = () => { throw new Error('Network forbidden'); };
  globalThis.WebSocket = class { constructor() { throw new Error('Network forbidden'); } };
  const host = id => import(resolveHost(`@deepseek-ai/${id}`));
  const [{ Context }, llm, { default: Sessions }, { default: Projections }, { default: Agents }, { default: SystemPrompt }, { default: Tools, defineTool }, { default: Loop }] = await Promise.all(['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop'].map(host));
  const ctx = new Context(), calls = [], dispatches = [], preparations = [], timers = [], logs = new Map();
  const clock = { random: () => .5, setTimeout(callback, delay) {
    const timer = { delay, cancelled: false }; timers.push(timer);
    if (settings.cancelAt === timers.length) setImmediate(() => { for (const a of ctx.agents.roots()) a.cancel('user'); });
    else queueMicrotask(() => { if (!timer.cancelled) callback(); }); return timer;
  }, clearTimeout(timer) { if (timer) timer.cancelled = true; } };
  let controller = fullController ? undefined : createController(settings.config ?? {}, clock);
  try {
    for (const p of [llm.default, Sessions, Projections, Agents, SystemPrompt, Tools]) await ctx.plugin(p);
    await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 });
    ctx.llm.registerAdapter(['new-route'], new class extends llm.LlmAdapter {
      providerRetryPolicy() { return settings.optout ? llm.resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'fixture') : undefined; }
      listModels() { return [{ id: 'fixture', name: 'Offline', contextWindow: 10000, maxTokens: 1000, input: ['text'], output: ['text'] }]; }
      async prepareCall(...args) { const call = await super.prepareCall(...args); preparations.push(call); return call; }
      async *stream(options) {
        assert(llm.isAgentLoopRequest(options));
        const ordinal = calls.filter(c => c.sessionId === options.sessionId).length;
        calls.push({ sessionId: options.sessionId, messages: options.messages });
        if (settings.exhaust && !(settings.legacyHealthy && ordinal >= 10) || ordinal === 0) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: 'failed', name: 'fixture_spy', argumentsDelta: '{}' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'failed', name: 'fixture_spy', arguments: '{}' } };
          const code = settings.auth ? 'AUTH' : settings.opaque ? 'PI_AI_ERROR' : ordinal % 2 ? 'TRANSPORT' : 'SERVER';
          yield { type: 'finish', reason: { kind: 'error', failure: { code, message: 'Backend private CANARY', ...(settings.auth ? { status: 401 } : {}) } } };
        } else if (settings.legacyHealthy) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: 'verified nonempty healthy progress' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'verified nonempty healthy progress' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        } else if (ordinal === 1) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: 'success', name: 'fixture_spy', argumentsDelta: '{}' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'success', name: 'fixture_spy', arguments: '{}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }());
    ctx.tools.register(defineTool({ name: 'fixture_spy', description: 'Offline counter', parameters: {}, output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] }, execute() { dispatches.push('tool'); return 'offline'; } }));
    ctx.on('session/event', (session, event) => { if (!logs.has(session.id)) logs.set(session.id, []); logs.get(session.id).push(event); });
    const ownerDefinition = { name: 'unified-fixture-owner', inject: ['agents', 'sessionProjections', 'llmRecoveryHistory'], apply(c) { ownerActivations++; selfHealApply(c); } };
    let ownerActivations = 0, waitingOwner, migration;
    const agents = [];
    const newAgent = async () => (await ctx.agents.create({ sessionId: `unified-${agents.length}`, agentOptions: { provider: 'new-route', model: 'fixture' }, meta: { cwd: process.cwd() } })).agent;
    if (settings.warm || settings.legacyRun) {
      const oldModule = await import(settings.warm === 'v3' ? './lib/index-v3-unified.mjs' : './lib/index-v1-resilience.mjs');
      const oldFiber = ctx.plugin({ name: 'old-native-fixture', inject: oldModule.inject, apply(c) {
        oldModule.apply(c, { policy: { maxRetries: 9, initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, clock);
      } });
      await oldFiber;
      const oldController = ctx.get('llmResilience');
      assert(oldController); assert.equal(ctx.get('llmRecoveryHistory'), undefined);
      waitingOwner = ctx.plugin(ownerDefinition); // Existing v1 service must not admit the new owner.
      assert.equal(ownerActivations, 0);
      if (settings.warm === 'v3') assert.equal(ctx.get('llmRecovery'), oldController);
      else assert.equal(ctx.get('llmRecovery'), undefined);
      if (settings.legacyRun) {
        agents.push(await newAgent());
        agents[0].followup(llm.createUserMessage({ content: [{ type: 'text', text: 'offline old native task' }], source: { kind: 'user', rpcId: 'fixture-initial-rpc' } }));
        await agents[0].whenIdle();
        const legacyEvents = logs.get(agents[0].id);
        migration = { legacy: { calls: calls.length, retries: legacyEvents.filter(e => e.type === 'llm/retry').length,
          end: legacyEvents.findLast(e => e.type === 'turn/end').data.reason.kind,
          nativeLedger: ctx.sessionProjections.stateOf(agents[0].session, 'llmRetry'), ownerActivations } };
        if (settings.compression) migration.cold = await coldLegacy(ctx, host, agents[0], settings.compression);
      }
      await oldFiber.dispose(); assert.equal(oldController.signal.aborted, true);
    }
    await ctx.plugin({ name: 'unified-fixture-ledgers', inject: fullController ? controllerModule.inject : ['agents', 'sessionProjections'], apply(c) {
      if (fullController) {
        controllerModule.apply(c, settings.config ?? {}, clock);
        controller = c.get('llmRecoveryHistory');
        assert.equal(c.get('llmResilience'), controller, 'aliases must identify one controller');
        assert.equal(c.get('llmRecovery'), controller);
      } else {
        installMainDriver(c, controller); c.provide('llmResilience', controller); c.provide('llmRecovery', controller); c.provide('llmRecoveryHistory', controller);
      }
    } });
    await (waitingOwner ?? ctx.plugin(ownerDefinition));
    assert.equal(ownerActivations, 1);
    if (settings.legacyRun) {
      const agent = agents[0];
      migration.upgraded = structuredClone(ctx.sessionProjections.stateOf(agent.session, 'llmRecoveryAccounting'));
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'automatic continuation, not a human admission' }], source: { kind: 'self-heal-observation', form: 'notice', label: 'Harness warning', summary: 'continue existing task' } }));
      await agent.whenIdle();
      migration.autonomous = { calls: calls.length, timers: timers.length,
        history: structuredClone(ctx.sessionProjections.stateOf(agent.session, 'llmRecoveryAccounting')),
        nativeLedger: ctx.sessionProjections.stateOf(agent.session, 'llmRetry'),
        ownerState: ctx.sessionProjections.stateOf(agent.session, 'agentSelfHeal'),
        reserved: logs.get(agent.id).filter(e => e.type === 'agent/self-heal' && e.data.action === 'reserved').length };
      if (settings.legacyHealthy) {
        migration.healthy = { receipts: logs.get(agent.id).filter(e => e.type === 'agent/self-heal' && e.data.action === 'recovered').length,
          end: logs.get(agent.id).findLast(e => e.type === 'turn/end').data.reason.kind };
        return { calls, dispatches, prepareCount: preparations.length, timers, logs: [...logs.values()], migration };
      }
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'untrusted durable user label alone' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      migration.labels = { calls: calls.length, timers: timers.length,
        history: structuredClone(ctx.sessionProjections.stateOf(agent.session, 'llmRecoveryAccounting')),
        receipts: logs.get(agent.id).filter(e => e.type === 'agent/self-heal' && e.data.action === 'manual-resumed').length };
      // This is the actual public root inbox path, not a fabricated durable
      // source label: followup -> live insertion -> claim -> new step -> request.
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'new human authorization to resume' }], source: { kind: 'user', rpcId: 'fixture-authorized-resume' } }));
      await agent.whenIdle();
      migration.human = { calls: calls.length, history: ctx.sessionProjections.stateOf(agent.session, 'llmRecoveryAccounting'),
        receipts: logs.get(agent.id).filter(e => e.type === 'agent/self-heal' && e.data.action === 'manual-resumed').map(e => e.data.progress) };
      return { calls, dispatches, prepareCount: preparations.length, timers, logs: [...logs.values()], migration };
    }
    for (let i = 0; i < (settings.concurrent ? 2 : 1); i++) agents.push(await newAgent());
    for (const a of agents) a.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'offline task' }], source: { kind: 'user' } }));
    await Promise.all(agents.map(a => a.whenIdle()));
    return { calls, dispatches, prepareCount: preparations.length, timers, logs: [...logs.values()] };
  } finally { await controller?.dispose(); await ctx.fiber.dispose(); }
}
if (!isMainThread) {
  try { parentPort.postMessage({ result: await runtime(workerData) }); } catch (e) { parentPort.postMessage({ error: { message: e.message, stack: e.stack } }); }
} else {
  const fixture = settings => new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: settings }); let result;
    const deadline = setTimeout(() => { void worker.terminate(); reject(new Error('Native fixture timeout')); }, 15000);
    worker.on('message', m => { if (m.error) reject(Object.assign(new Error(m.error.message), { stack: m.error.stack })); else result = m.result; }); worker.on('error', reject);
    worker.on('exit', code => { clearTimeout(deadline); if (code) reject(new Error(`Worker exited ${code}`)); else resolve(result); });
  });
  test('main driver registers native ledger/accounting, NEVER an error retry listener', () => {
    const registered = [], disposed = []; let effect;
    const cleanup = installMainDriver({ sessionProjections: { register(p) { registered.push(p.key); return () => disposed.push(p.key); } }, on() { assert.fail('No technical owner permitted'); }, effect(fn) { effect = fn; } });
    assert.deepEqual(registered, ['llmRetry', 'llmRecoveryAccounting']); cleanup(); effect()(); assert.equal(disposed.length, 2);
    const state = llmRetryProjection.apply({}, { type: 'llm/retry', data: { provider: 'p', policyKey: 'k', retry: 2, retryId: 'r' } });
    assert.deepEqual(state, { [retryStateKey('p', 'k')]: { retry: 2, retryId: 'r' } }); assert.deepEqual(llmRetryProjection.apply(state, { type: 'step/start' }), {});
  });
  test('real native loop: ten contextual retries, fresh preparations, final failure is not swallowed', async () => {
    const r = await fixture({ exhaust: true });
    assert.equal(r.calls.length, 11); assert.equal(r.prepareCount, 11); assert.equal(r.dispatches.length, 0);
    assert.deepEqual(r.timers.map(t => t.delay), nominal.map(Math.ceil));
    const events = r.logs[0]; assert.equal(events.filter(e => e.type === 'assistant/attempt').length, 11);
    assert.equal(events.filter(e => e.type === 'llm/retry').length, 10);
    assert.equal(events.filter(e => e.type === 'llm/retry-started').length, 10);
    assert.equal(events.filter(e => e.type === 'user/message' && e.data.source?.kind === 'self-heal-observation').length, 11);
    for (let i = 1; i < r.calls.length; i++) { const text = JSON.stringify(r.calls[i].messages); assert(text.includes('harness warning:')); assert(!text.includes('CANARY')); }
    const end = events.findLast(e => e.type === 'turn/end'); assert(end); assert.notEqual(end.data.reason.kind, 'completed');
  });
  test('real native loop: SERVER warning changes request; failed tool discarded, successful tool exactly once', async () => {
    const r = await fixture({}); assert.equal(r.calls.length, 3); assert.equal(r.prepareCount, 3); assert.equal(r.dispatches.length, 1);
    assert.notDeepEqual(r.calls[0].messages, r.calls[1].messages); assert(JSON.stringify(r.calls[1].messages).includes('harness warning:'));
  });
  for (const [base, override] of [[7, 9], [0, 2]]) test(`real native loop honors base${base}/provider${override} rather than a second global cap`, async () => {
    const r = await fixture({ exhaust: true, config: { policy: { maxRetries: base }, providers: { 'new-route': { maxRetries: override } } } });
    assert.equal(r.calls.length, override + 1); assert.equal(r.prepareCount, override + 1); assert.equal(r.timers.length, override);
    assert.equal(r.dispatches.length, 0);
    assert.equal(r.logs[0].filter(e => e.type === 'llm/retry').length, override);
    assert.equal(r.logs[0].filter(e => e.type === 'user/message' && e.data.source?.kind === 'self-heal-observation').length, override + 1);
  });
  test('warm actual v1 controller cannot prematurely start contextual recovery; queued owner waits for the ready alias', async () => {
    const r = await fixture({ warm: true, exhaust: true });
    assert.equal(r.calls.length, 11); assert.deepEqual(r.timers.map(t => t.delay), nominal.map(Math.ceil));
    assert.equal(r.logs[0].filter(e => e.type === 'user/message' && e.data.source?.kind === 'self-heal-observation').length, 11);
    assert.equal(r.logs[0].filter(e => e.type === 'llm/retry').length, 10);
  });
  test('warm actual controller3/accounting1 cannot admit owner6 through its old llmRecovery alias', async () => {
    const r = await fixture({ warm: 'v3', exhaust: true });
    assert.equal(r.calls.length, 11); assert.equal(r.timers.length, 10);
  });
  for (const compression of ['none', 'zstd']) test(`actual native legacy9 error turn/end -> ${compression} cold replay -> autonomous hold -> live human fresh10`, async () => {
    const r = await fixture({ exhaust: true, legacyRun: true, compression }), m = r.migration;
    assert.equal(m.legacy.calls, 10); assert.equal(m.legacy.retries, 9); assert.equal(m.legacy.end, 'error');
    assert.equal(m.legacy.ownerActivations, 0); assert.deepEqual(m.legacy.nativeLedger, {});
    assert.equal(m.cold.restored.budget.consumed, 9); assert.equal(m.cold.restored.budget.cap, 9);
    assert.equal(m.cold.restored.unifiedCanRetry, false); assert.equal(m.cold.restored.auditCount, 0);
    assert.equal(m.cold.restored.access, 'read'); assert.deepEqual(m.cold.after, m.cold.before);
    assert.equal(m.upgraded.legacyConsumed, 9); assert.equal(m.upgraded.legacyCap, 9);
    assert.equal(m.autonomous.calls, 11); assert.equal(m.autonomous.timers, 9); assert.equal(m.autonomous.reserved, 0);
    assert.equal(m.autonomous.history.legacyConsumed, 9); assert.equal(m.autonomous.ownerState.chain, undefined);
    assert.deepEqual(m.autonomous.nativeLedger, {});
    assert.equal(m.labels.calls, 12); assert.equal(m.labels.timers, 9); assert.equal(m.labels.history.legacyConsumed, 9); assert.equal(m.labels.receipts, 0);
    assert.equal(m.human.calls, 23); assert.equal(m.human.history.legacyConsumed, 0);
    assert.equal(m.human.receipts.length, 1); assert.equal(m.human.receipts[0].authority, 'live-root-inbox');
    assert.equal(r.timers.length, 19); assert.equal(r.prepareCount, 23); assert.equal(r.dispatches.length, 0);
    assert.equal(r.logs[0].filter(e => e.type === 'agent/self-heal' && e.data.action === 'reserved').length, 10);
  });
  test('actual live healthy acknowledgement clears legacy-only floor even with no semantic chain', async () => {
    const r = await fixture({ exhaust: true, legacyRun: true, legacyHealthy: true }), m = r.migration;
    assert.equal(m.legacy.retries, 9); assert.equal(m.upgraded.legacyConsumed, 9);
    assert.equal(m.autonomous.calls, 11); assert.equal(m.autonomous.history.legacyConsumed, 0);
    assert.equal(m.autonomous.reserved, 0); assert.equal(m.autonomous.ownerState.chain, undefined);
    assert.equal(m.healthy.receipts, 1); assert.equal(m.healthy.end, 'completed');
    assert.equal(r.timers.length, 9); assert.equal(r.dispatches.length, 0);
  });
  test('opaque pi-ai errors share the SAME ten-retry algorithm', async () => { const r = await fixture({ exhaust: true, opaque: true }); assert.equal(r.calls.length, 11); assert.equal(r.timers.length, 10); });
  test('native concurrent agents have independent finite budgets', async () => { const r = await fixture({ exhaust: true, concurrent: true }); assert.equal(r.calls.length, 22); assert.equal(r.dispatches.length, 0); });
  for (const settings of [{ auth: true }, { optout: true }]) test('native permanent/explicit optout has no replay', async () => { const r = await fixture(settings); assert.equal(r.calls.length, 1); assert.equal(r.timers.length, 0); });
  test('native caller cancellation interrupts the last hour wait without dispatch', async () => { const r = await fixture({ exhaust: true, cancelAt: 10 }); assert.equal(r.calls.length, 10); assert.equal(r.dispatches.length, 0); assert.equal(r.logs[0].filter(e => e.type === 'llm/retry-started').length, 9); });
}
