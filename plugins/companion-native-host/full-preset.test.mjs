import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const anchor = '/home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh/package.json', require = createRequire(anchor);
const sdk = name => import(require.resolve(`@deepseek-ai/${name}`));
// Android now contains an owned native-source candidate, not a canonical dependency link.
// The unchanged push dependency still anchors other canonical fixture modules independently of cwd.
const repository = resolve(realpathSync(fileURLToPath(new URL('../companion-push', import.meta.url))), '../..');
const [{ boot }, { LlmAdapter }, { TypertRemoteService }, { livePresetMounts }] = await Promise.all([
  sdk('dsh-app-boot'), sdk('dsh-llm'), sdk('dsh-typert-protocol'), sdk('dsh-agent-preset-registry')]);
const observations = new WeakMap();
const stateFor = root => { if (!observations.has(root)) observations.set(root, { modelCalls: 0, supportCalls: 0 }); return observations.get(root); };
export const name = 'companion-native-host-owned-full-preset-regression';
class Ordinary extends TypertRemoteService {
  static inject = ['typert'];
  constructor(ctx) {
    super(ctx, 'ownFullPresetRpc', { namespace: 'ownFullPreset' });
    ctx.get('typert').register({ package: 'companion-native-host-own-full-preset-test', face: 'host', schemas: [], model: { services: [], events: [], objects: [] }, invocations: [
      { id: 'ownFullPreset/read', service: 'ownFullPresetRpc', namespace: 'ownFullPreset', method: 'read', invocation: { kind: 'direct' }, parameters: [],
        result: { mode: 'strict', typeSymbol: 'OwnFullPresetResult', create: () => ({ parse: value => value }) } }] });
  }
  read() { return { operator: this.ctx.invocation?.peer === this.ctx.get('connection').operator }; }
}
export async function apply(ctx, config) {
  const state = stateFor(ctx.root);
  if (config.role === 'late') {
    // A finite initial dependency, not a runtime poll/retry. Module preloading in
    // the fixture makes this boundary independent of disk import latency.
    await new Promise(resolveTurn => setImmediate(resolveTurn));
    ctx.provide('ownFullPresetInitialDependency', { ready: true });
    const handle = await ctx.get('agents').create({ sessionId: `own-full-early-${randomUUID()}`, meta: { cwd: config.cwd, agentPreset: 'companion' },
      agentOptions: { provider: 'own-full-no-model', model: 'never' } });
    state.agent = handle.agent;
    state.noReceiverBeforeReady = ctx.get('companionNativeGoals') === undefined;
    return;
  }
  const records = new Map(), deny = () => { state.supportCalls++; throw new Error('OWN fixture forbids support capability dispatch'); };
  ctx.provide('credentials', { async modifyRecord(key, modify) { const next = await modify(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key); } });
  // Real preset modules register against explicit DENY-only unused capabilities.
  // They do not replace any native scope, preset lease, Agent, Goal, Peer or codec.
  ctx.provide('sessionQuery', { list: deny, read: deny }); ctx.provide('approval', { request: deny });
  ctx.provide('sandboxPolicy', { resolve: deny }); ctx.provide('sandbox', { confine: deny });
  ctx.provide('shell', { sandboxMode: 'workspace-write', execute: deny }); ctx.provide('shellEnv', { collect: deny });
  ctx.provide('tokenMeter', { measure: deny }); ctx.provide('sessionCreateOwner', { execute: deny });
  ctx.inject(['llm'], ready => {
    class NoModel extends LlmAdapter {
      async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'] }; }
      stream() { state.modelCalls++; throw new Error('OWN fixture forbids model dispatch'); }
    }
    ready.effect(() => ready.get('llm').registerAdapter(['own-full-no-model'], new NoModel()));
  });
  ctx.inject(['typert'], async ready => { await ready.plugin(Ordinary); });
}

async function fixture(withReady, signal) {
  await mkdir(resolve(repository, '.dumps/tasks'), { recursive: true });
  const directory = await mkdtemp(resolve(repository, '.dumps/tasks/task122-full-preset-sdk-')), profile = join(directory, 'profile'), cwd = join(directory, 'workspace'), home = join(directory, 'empty-home');
  await Promise.all([mkdir(profile), mkdir(cwd), mkdir(home)]);
  const file = join(directory, 'cordis.yml'); await writeFile(file, '[]\n');
  const module = fileURLToPath(import.meta.url), hostModule = fileURLToPath(new URL('./index.mjs', import.meta.url));
  const row = (id, moduleName, config) => ({ id, name: moduleName.startsWith('dsh-') ? require.resolve(`@deepseek-ai/${moduleName}`) : resolve(repository, moduleName), ...(config ? { config } : {}) });
  const plugins = [row('companion-session', 'plugins/session/index.mjs', { profile: 'companion', root: join(directory, 'own-sessions'), ledgerPath: join(directory, 'own-ledger.json') }),
    row('companion-workspace', 'plugins/companion-workspace/index.mjs', { profile: 'companion' }), row('companion-files', 'dsh-tool-fs'), row('companion-list', 'plugins/list/index.mjs'),
    row('companion-bash', 'dsh-tool-bash', { enableRunInBackground: false, promoteOnTimeout: false }),
    { id: 'compaction', name: require.resolve('@deepseek-ai/cordis-plugin-group'), group: true, isolate: { compaction: true }, config: [row('compaction-basic', 'dsh-compaction-basic')] },
    row('companion-session-create', 'plugins/session-create/index.mjs', { profile: 'companion' }), row('agent-instructions', 'dsh-agent-instructions', { maxBytes: 65536, dshHome: home }),
    row('command-goal', 'dsh-command-goal'), row('tool-goal', 'dsh-tool-goal', { blockedAfterConsecutiveRounds: 3 }),
    row('companion-notifications', 'plugins/companion-notifications/index.mjs', { profile: 'companion' }),
    { ...row('tool-todo', 'dsh-tool-todo', { allowParallelInProgress: true }), inject: ['ownFullPresetInitialDependency'] }];
  const rows = [row('own-full-support', module, { role: 'support' }), ...[
    ['typert', 'dsh-typert-registry'], ['connection', 'dsh-client-connection'], ['gateway', 'dsh-api-gateway'], ['llm', 'dsh-llm'], ['session', 'dsh-session'],
    ['persistence', 'dsh-session-persistence-jsonl', { root: join(directory, 'own-sessions') }], ['projection', 'dsh-session-projection'], ['agent', 'dsh-agent'], ['system-prompt', 'dsh-system-prompt'],
    ['tools', 'dsh-tools', { mode: 'native' }], ['agent-loop', 'dsh-agent-loop', { agents: [], maxParallelToolCalls: 2 }], ['presets', 'dsh-agent-preset-registry', { default: 'companion' }],
    ['goal', 'dsh-goal'], ['commands', 'dsh-commands'], ['fs', 'dsh-fs-local', { cwd }]].map(args => row(...args)),
    row('preset-companion', 'dsh-agent-preset', { id: 'companion', name: 'Companion', order: 0, plugins }), row('companion-native-host', hostModule, { enabled: true }),
    row('own-full-late', module, { role: 'late', cwd })];
  await Promise.all([...rows, ...plugins.flatMap(entry => entry.group ? entry.config : [entry])].map(entry => import(pathToFileURL(entry.name).href)));
  await sdk('dsh-scope');
  const callbacks = new Set(); let committed = false;
  const appReady = { onReady(callback) { if (committed) callback(); else callbacks.add(callback); return () => callbacks.delete(callback); } };
  const app = await boot('companion-native-host-own-full-preset', file, [{ insert: rows }], ctx => {
    ctx.provide('profileContext', { name: 'companion', dir: profile }); if (withReady) ctx.provide('appReady', appReady);
    // A regressed startup can own an unpublished session lease. Test cancellation
    // must dispose this authored root even when fixture() has not returned yet.
    const cancel = () => { void ctx.root.fiber.dispose(); };
    signal.addEventListener('abort', cancel, { once: true });
    ctx.effect(() => () => signal.removeEventListener('abort', cancel));
  }, pathToFileURL(anchor).href);
  const state = stateFor(app.root);
  if (withReady) {
    assert.equal(state.noReceiverBeforeReady, true);
    assert.equal(app.get('companionNativeGoals'), undefined);
    committed = true; const tasks = [...callbacks].map(callback => callback()); callbacks.clear(); await Promise.all(tasks);
  } else {
    // Test-only finite barrier: after the owned startup continuation runs, a real
    // public agent/created lifecycle awaits the same in-flight native start task.
    await new Promise(resolveTurn => setImmediate(resolveTurn));
    const barrier = await app.get('agents').create({ sessionId: `own-full-barrier-${randomUUID()}`, meta: { cwd }, agentOptions: { provider: 'own-full-no-model', model: 'never' } });
    await barrier.dispose();
  }
  const connection = app.get('connection'), carrier = connection.createSharedFetchHandler('/api'), host = '127.0.0.1:49944', origin = `http://${host}`;
  const launch = new URL(connection.authenticatedUrl(`${origin}/`)); let cookie;
  connection.authorizeIndex({ method: 'GET', url: `${launch.pathname}${launch.search}`, headers: { host } }, { writeHead(code, headers) { assert.equal(code, 303); cookie = headers['set-cookie'].split(';')[0]; }, end() {} });
  const rpc = async (method, request) => {
    const rpcId = randomUUID(), incoming = new Request(`${origin}/api/${method}`, { method: 'POST', headers: { host, origin, cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: method === 'ownFullPreset/read' ? {} : { request } } }) });
    assert.equal(connection.admit(incoming).peer, connection.operator); const response = await carrier.fetch(incoming); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.rpcId, rpcId); assert.equal(result.result.ok, true, JSON.stringify(result)); return result.result.value;
  };
  return { app, state, rpc, close: () => app.fiber.dispose() };
}

for (const withReady of [true, false]) test(`full actual Companion preset ${withReady ? 'AppReady' : 'Loader-audit fallback'} never awaits its own initial pending-row diagnostic`, { timeout: 20000 }, async t => {
  const previousFetch = globalThis.fetch; let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('OWN full-preset regression forbids external fetch'); };
  let f;
  try {
    f = await fixture(withReady, t.signal);
    const mount = livePresetMounts(f.app.fiber).find(record => record.presetId === 'companion'); assert.ok(mount); await mount.tree.await();
    const entries = [...mount.tree.entries()].filter(entry => !entry.disabled);
    assert.equal(entries.filter(entry => !entry.options.group).length, 12); assert.ok(entries.every(entry => entry.fiber?.state === 2));
    const host = [...f.app.get('loader').entries()].find(entry => entry.options.id === 'companion-native-host'); assert.equal(host.fiber.state, 2);
    assert.equal((await f.rpc('ownFullPreset/read')).operator, true); assert.ok(await f.rpc('nativeGoals/catalog', { sessionIds: [] }));
    const agent = f.state.agent; await f.app.get('agentPresets').mount(agent.ctx, 'companion');
    f.app.get('goals').create(agent, { objective: 'OWN full-preset HUMAN control proof', maxGoalRounds: 4 });
    const observation = await f.rpc('nativeGoals/read', { sessionId: agent.id, generation: 1 });
    await f.rpc('nativeGoals/control', { sessionId: agent.id, goalId: observation.projections.goal.goal.id, revision: observation.projections.goal.goal.revision,
      sourceId: observation.sourceId, incarnation: observation.incarnation, generation: observation.generation, permit: observation.permit, action: 'pause' });
    assert.equal(f.app.get('goals').get(agent).phase, 'paused'); assert.equal(f.app.get('goals').get(agent).roundsStarted, 0);
    assert.equal(f.state.modelCalls, 0); assert.equal(f.state.supportCalls, 0); assert.equal(fetchCalls, 0);
    await f.close(); assert.equal(livePresetMounts(f.app.fiber).length, 0); f = undefined;
  } finally { if (f) await f.close(); globalThis.fetch = previousFetch; }
});
