import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createCompanionNativeHost, inject as hostInject } from './index.mjs';
import { DSH_CLI_ANCHOR } from '../session/host-paths.mjs';

const anchor = DSH_CLI_ANCHOR;
const require = createRequire(anchor);
export const sdk = name => import(require.resolve(`@deepseek-ai/${name}`));
const [{ TypertRemoteService }, { LlmAdapter }, { boot, readProfilePatches, reconcileProfilePatches }] = await Promise.all([sdk('dsh-typert-protocol'), sdk('dsh-llm'), sdk('dsh-app-boot')]);
export const name = 'task101-host-own-memory-fixture';
class OrdinaryRpc extends TypertRemoteService {
  static inject = ['typert'];
  constructor(ctx) {
    super(ctx, 'ownOrdinaryRpc', { namespace: 'ownOrdinary' });
    ctx.typert.register({ package: 'task101-host-ordinary-fixture', face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
      invocations: [{ id: 'ownOrdinary/read', service: 'ownOrdinaryRpc', namespace: 'ownOrdinary', method: 'read', invocation: { kind: 'direct' }, parameters: [],
        result: { mode: 'strict', typeSymbol: 'OwnOrdinaryResult', create: () => ({ parse: value => value }) } }] });
  }
  read() { return { version: 1, operator: this.ctx.invocation?.peer === this.ctx.get('connection')?.operator }; }
}
const assemblies = new WeakMap();
export async function apply(ctx, config = {}) {
  if (config.fixtureModel === true) return;
  if (config.fixtureHost === true) {
    const assembly = await createCompanionNativeHost(ctx, config);
    assemblies.set(ctx.root, assembly);
    ctx.effect(() => () => assembly.close(), 'own fixture host disposal');
    return;
  }
  const records = new Map();
  ctx.provide('credentials', { async modifyRecord(key, modify) { const result = await modify(records.get(key)); if (result !== undefined) records.set(key, result); return records.get(key); } });
  ctx.inject(['typert'], async ready => { await ready.plugin(OrdinaryRpc); });
}
export async function fixture({ presetInitially = true, todos = true, autoReady = true, withDefaultModelEditor = false, hostInProfile = false } = {}) {
  // hostInProfile = the deployed layout: the host row lives in the profile's own patch
  // layer (inside the root Include), so every profile live reload reaches its own entry.
  const editor = withDefaultModelEditor || hostInProfile;
  mkdirSync('.dumps/tasks', { recursive: true });
  const directory = mkdtempSync(resolve('.dumps/tasks/task101-composition-host-'));
  const profile = join(directory, 'profile'), cwd = join(directory, 'workspace'), file = join(directory, 'cordis.yml');
  mkdirSync(profile); mkdirSync(cwd); writeFileSync(file, '[]\n');
  const presetPlugins = todos ? [{ id: 'todos', name: require.resolve('@deepseek-ai/dsh-tool-todo'), config: { allowParallelInProgress: true } }] : [];
  const definition = { id: 'companion', name: 'Companion', description: 'OWN retained native scope fixture', order: 0, plugins: presetPlugins };
  const rows = [{ id: 'own-memory-provider', name: fileURLToPath(import.meta.url) },
    ...[['typert', 'dsh-typert-registry'], ['connection', 'dsh-client-connection'], ['gateway', 'dsh-api-gateway'], ['llm', 'dsh-llm'],
      ['session', 'dsh-session'], ['projection', 'dsh-session-projection'], ['agent', 'dsh-agent'], ['system-prompt', 'dsh-system-prompt'],
      ['tools', 'dsh-tools', { mode: 'native' }], ['agent-loop', 'dsh-agent-loop', { agents: [], maxParallelToolCalls: 2 }],
      ['presets', 'dsh-agent-preset-registry', { default: 'companion' }], ['goal', 'dsh-goal']]
      .map(([id, name, config]) => ({ id, name: require.resolve(`@deepseek-ai/${name}`), ...(config ? { config } : {}) })),
    ...(presetInitially ? [{ id: 'preset-companion', name: require.resolve('@deepseek-ai/dsh-agent-preset'), config: definition }] : []),
    { id: 'preset-foreign', name: require.resolve('@deepseek-ai/dsh-agent-preset'), config: { id: 'foreign', name: 'Foreign', order: 1, plugins: [] } },
    ...(editor ? [
      { id: 'config-editor', name: require.resolve('@deepseek-ai/dsh-config-editor') },
      { id: 'agent-default-model', name: require.resolve('@deepseek-ai/dsh-agent-default-model'), config: { provider: 'own-never-provider', model: 'own-first', reasoningEffort: 'low' } }
    ] : []),
    ...(hostInProfile ? [{ id: 'companion-native-host', name: fileURLToPath(import.meta.url), inject: hostInject, config: { enabled: true, fixtureHost: true } }] : [])];
  const profileContext = { name: 'companion', dir: profile };
  let patches = [{ insert: rows }];
  if (editor) {
    const home = join(directory, 'empty-home'); mkdirSync(home);
    Object.assign(profileContext, { home, installAnchor: anchor, patchPath: join(profile, 'cordis.patch.yml'), overlays: [], telemetryDisabledEnv: '' });
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'own-task122-never-live-profile', private: true, dsh: { profile: { bundles: [] } } }));
    if (hostInProfile) {
      // Authored like tools/session-companion/profile.mjs: raw absolute plugin paths and a
      // separate id-only model override. Boot reads it through the SDK's own profile
      // reader, which anchors those paths to file URLs exactly as `dsh` does.
      const model = rows.find(row => row.id === 'agent-default-model'), { config: selection } = model; delete model.config;
      writeFileSync(profileContext.patchPath, JSON.stringify([{ insert: rows }, { id: 'agent-default-model', config: selection }]));
      patches = readProfilePatches('dsh', profileContext);
    } else {
      // Profile patch loading canonicalizes absolute module paths to file URLs.
      // Boot and the persisted authored layer must use the same public spelling;
      // otherwise ConfigEditor correctly treats them as different module owners.
      for (const row of rows) if (row.name.startsWith('/')) row.name = pathToFileURL(row.name).href;
      writeFileSync(profileContext.patchPath, JSON.stringify([{ insert: rows }]));
    }
  }
  const readyCallbacks = new Set(), readyTasks = new Set(); let startupCommitted = false;
  // The initializer must not await first-lease work. This test owner separately
  // observes the real callback task after that initializer has returned.
  const appReady = { onReady(callback) { if (startupCommitted) readyTasks.add(callback()); else readyCallbacks.add(callback); return () => readyCallbacks.delete(callback); } };
  const commitReady = async () => { startupCommitted = true; const tasks = [...readyCallbacks].map(callback => callback()); readyCallbacks.clear(); await Promise.all(tasks); };
  const app = await boot('task101-host-isolated', file, patches, ctx => {
    ctx.provide('profileContext', profileContext); ctx.provide('appReady', appReady);
  }, pathToFileURL(anchor).href);
  if (autoReady) await commitReady();
  let modelCalls = 0, assembly;
  class NoModel extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'] }; }
    stream() { modelCalls++; throw new Error('OWN fixture forbids provider/model calls'); }
  }
  await app.plugin({ name: 'task101-host-no-model', inject: ['llm'], apply(ctx) { ctx.effect(() => ctx.llm.registerAdapter(['task101-host-no-model'], new NoModel())); } });
  const create = async (preset = 'companion') => (await app.agents.create({ sessionId: `own-host-${randomUUID()}`, meta: { cwd, agentPreset: preset },
    agentOptions: { provider: 'task101-host-no-model', model: 'never' }, setup: async ctx => { await ctx.get('agentPresets').mount(ctx, preset); } })).agent;
  async function mount(config = { enabled: true }) {
    const id = `own-host-assembly-${randomUUID()}`;
    await app.loader.create({ id, name: fileURLToPath(import.meta.url), inject: hostInject, config: { ...config, fixtureHost: true } });
    await app.loader.await(); await Promise.all(readyTasks);
    assembly = assemblies.get(app.root);
    return assembly;
  }
  const connection = app.get('connection'), carrier = connection.createSharedFetchHandler('/api'), host = '127.0.0.1:49882', origin = `http://${host}`;
  const launch = new URL(connection.authenticatedUrl(`${origin}/`)); let cookie;
  connection.authorizeIndex({ method: 'GET', url: `${launch.pathname}${launch.search}`, headers: { host } }, {
    writeHead(code, headers) { if (code !== 303) throw new Error('own fixture authentication failed'); cookie = headers['set-cookie'].split(';')[0]; }, end() {} });
  async function rpc(method, request, { authenticated = true, args } = {}) {
    const rpcId = randomUUID(), incoming = new Request(`${origin}/api/${method}`, { method: 'POST', headers: { host, origin, 'Content-Type': 'application/json', ...(authenticated ? { cookie } : {}) },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: args ?? (method === 'ownOrdinary/read' ? {} : { request }) } }) });
    const admission = connection.admit(incoming); if ('rejection' in admission) return { status: admission.rejection };
    const response = await carrier.fetch(incoming);
    if (response.status !== 200) return { status: response.status };
    const body = await response.json(); if (body.rpcId !== rpcId) throw new Error('own fixture correlation mismatch');
    return { status: response.status, ...body.result };
  }
  // The public live-reload path HMR and ConfigEditor use, over the current profile files,
  // with optionally respelled rows (edit receives a copy of every inserted row).
  async function reload(edit = row => row) {
    const next = readProfilePatches('dsh', profileContext).map(patch => patch.insert ? { ...patch, insert: patch.insert.map(row => edit({ ...row })) } : patch);
    await reconcileProfilePatches(app, next, 'dsh');
  }
  return { app, directory, profile, definition, mount, create, rpc, commitReady, reload, hosted: () => assemblies.get(app.root), get modelCalls() { return modelCalls; },
    pushStoreExists: () => existsSync(join(profile, 'companion-push')), close: () => app.fiber.dispose() };
}
export const value = response => { if (response.status !== 200 || response.ok !== true) throw new Error(`Own fixture operation failed: ${JSON.stringify(response)}`); return response.value; };
export const control = (observation, action) => ({ sessionId: observation.sessionId, goalId: observation.projections.goal.goal.id, revision: observation.projections.goal.goal.revision,
  sourceId: observation.sourceId, incarnation: observation.incarnation, generation: observation.generation, permit: observation.permit, action });
