import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config, root, sdk } from './test-fixture.mjs';
import { createGoalPush } from './source.mjs';
import { hash, publicConfig } from './contracts.mjs';
import { DSH_CLI_ANCHOR } from '../session/host-paths.mjs';

const anchor = DSH_CLI_ANCHOR;
const require = createRequire(anchor);
const ref = goal => ({ id: goal.id, revision: goal.revision });

test('PUBLIC actual GoalService committed event + strictfold + native root scope drive durable sender; zero models/network', { timeout: 20000 }, async () => {
  const directory = root(), profileDir = join(directory, 'profile'), cwd = join(directory, 'workspace'); mkdirSync(profileDir); mkdirSync(cwd);
  const file = join(directory, 'cordis.yml'); writeFileSync(file, '[]\n');
  const rows = [['llm', 'dsh-llm'], ['session', 'dsh-session'], ['projection', 'dsh-session-projection'], ['agent', 'dsh-agent'],
    ['system-prompt', 'dsh-system-prompt'], ['tools', 'dsh-tools', { mode: 'native' }],
    ['agent-loop', 'dsh-agent-loop', { agents: [], maxParallelToolCalls: 2 }], ['preset-registry', 'dsh-agent-preset-registry', { default: 'companion' }],
    ['goal', 'dsh-goal']].map(([id, name, config]) => ({ id, name: require.resolve(`@deepseek-ai/${name}`), ...(config ? { config } : {}) }));
  for (const id of ['companion', 'foreign']) rows.push({ id: `preset-${id}`, name: require.resolve('@deepseek-ai/dsh-agent-preset'), config: {
    id, name: id, description: 'OWN isolated push fixture', order: 0, plugins: [] } });
  const { boot } = await sdk('dsh-app-boot');
  const app = await boot('task101-push-own-isolated', file, [{ insert: rows }], ctx => { ctx.provide('profileContext', { name: 'companion', dir: profileDir }); }, pathToFileURL(anchor).href);
  let source, modelCalls = 0;
  try {
    const [{ createScope, scopeOf, scopeChainOf }, { OperatorPeer }, { foldGoal }, { symbols }, { LlmAdapter }] = await Promise.all([
      sdk('dsh-scope'), sdk('dsh-client-connection'), sdk('dsh-goal'), sdk('cordis'), sdk('dsh-llm')]);
    let ctx = app;
    const operator = new OperatorPeer(app);
    app.provide('connection', { operator });
    class NoModel extends LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'] }; }
      stream() { modelCalls++; throw new Error('OWN fixture forbids model dispatch'); }
    }
    await app.plugin({ name: 'task101-push-no-model', inject: ['llm'], apply(ctx) { ctx.effect(() => ctx.llm.registerAdapter(['task101-push-no-model'], new NoModel())); } });
    const create = async preset => (await ctx.get('agents').create({ sessionId: `own-push-${randomUUID()}`, meta: { cwd, agentPreset: preset },
      agentOptions: { provider: 'task101-push-no-model', model: 'never' }, setup: async ctx => { await ctx.get('agentPresets').mount(ctx, preset); } })).agent;
    const agent = await create('companion'); ctx = agent.ctx; const sends = [];
    const ownsSession = id => {
      const a = ctx.get('agents').get(id);
      return !!a && ctx.get('agents').roots().includes(a) && a.session.header.agentPreset === 'companion' && scopeChainOf(scopeOf(a.ctx)).includes(scopeOf(ctx));
    };
    assert.equal(ownsSession(agent.id), true);
    source = createGoalPush(ctx, { scopeOf, scopeChainOf, foldGoal, ownsSession, identityOf: s => s?.identity ?? s?.[symbols.original] ?? s,
      sender: { ready: () => true, send: async work => { sends.push(work); return { ok: true }; }, close() {} } }, config);
    assert.equal(source.status().registrationReady, true);
    const token = 'authored-native-fixture-token-only';
    const registered = await source.dispatch('goalPush/register', { args: { request: { version: 1, deviceId: randomUUID(), token, tokenDigest: hash(token),
      configDigest: publicConfig(config).configDigest, authGeneration: 1, sessionIds: [agent.id] } } }, undefined, operator);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    let last;
    ctx.on('goal/changed', event => { last = event; source.onGoalChanged(event); });
    let goal = ctx.get('goals').create(agent, { objective: 'OWN PRIVATE NATIVE OBJECTIVE MUST NEVER ENTER FCM', maxGoalRounds: 3 });
    goal = ctx.get('goals').pause(agent, ref(goal)); goal = ctx.get('goals').resume(agent, ref(goal));
    goal = ctx.get('goals').complete(agent, ref(goal)); assert.equal(goal.phase, 'complete');
    assert.equal(await source.flush(), 1); assert.equal(sends.length, 1);
    assert.equal(sends[0].data.goalId, goal.id); assert.equal(sends[0].data.revision, String(goal.revision));
    assert.equal(source.onGoalChanged(last), false); assert.equal(await source.flush(), 0);
    const foreign = await create('foreign'), foreignGoal = ctx.get('goals').create(foreign, { objective: 'OWN foreign' });
    ctx.get('goals').complete(foreign, ref(foreignGoal)); assert.equal(await source.flush(), 0);
    const ledger = join(profileDir, 'companion-push/state-v1.json');
    assert.equal(readFileSync(ledger, 'utf8').includes('PRIVATE'), false);
    // A sender exception is injected only into the OWN fixture; the public native goal stays committed.
    source.close(); source = createGoalPush(ctx, { scopeOf, scopeChainOf, foldGoal, ownsSession, identityOf: s => s?.identity ?? s?.[symbols.original] ?? s,
      sender: { ready: () => true, send: async () => { throw new Error('MUST NOT THROW THROUGH NATIVE'); }, close() {} } }, config);
    let next = ctx.get('goals').create(agent, { objective: 'OWN next' }); next = ctx.get('goals').complete(agent, ref(next));
    assert.equal(next.phase, 'complete'); await source.flush(); assert.equal(ctx.get('goals').get(agent).phase, 'complete'); assert.equal(modelCalls, 0);
  } finally { source?.close(); await app.fiber.dispose(); }
});
