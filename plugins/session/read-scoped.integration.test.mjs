import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { YAML } from '../../tools/session-companion/profile.mjs';
import { compositionProposal } from '../session-create/composition-proposal.mjs';
import { createReadSide } from './read-side.mjs';
import { parseReadRequest } from './read-contracts.mjs';
import { DSH_CLI_ANCHOR } from './host-paths.mjs';

const anchor = DSH_CLI_ANCHOR;
const require = createRequire(anchor);
const load = name => import(require.resolve(`@deepseek-ai/${name}`));
const local = path => resolve('plugins', path);
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function hashes(root) {
  const out = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out[path] = sha256(await readFile(path));
    }
  }
  await walk(root); return out;
}

// Authored composition, not a production profile clone or template replacement.
// Preserve CURRENT aliases and controller while isolating home/storage/transports.
function fixtureComposition(home, root) {
  const proposal = compositionProposal(process.cwd());
  const children = [
    { id: 'companion-session', name: local('session/index.mjs'), config: { profile: 'companion', root: join(home, 'bridges'), ledgerPath: join(home, 'absent-mount-ledger') } },
    { id: 'companion-workspace', name: local('companion-workspace/index.mjs'), config: { profile: 'companion' } },
    { id: 'companion-files', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'companion-list', name: local('list/index.mjs') },
    { id: 'companion-bash', name: '@deepseek-ai/dsh-tool-bash', config: { enableRunInBackground: false, promoteOnTimeout: false } },
    { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }] },
    structuredClone(proposal.presetChildEntry),
  ];
  return [
    ...['standard', 'minimal', 'ptc', 'cordis'].map(id => ({ id: `preset-${id}`, disabled: true })),
    { id: 'agent-preset-registry', config: { default: 'companion' } },
    { id: 'agent-default-model', config: { provider: 'openai-codex', model: 'gpt-6-sol', reasoningEffort: 'low' } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'zstd' } },
    { id: 'approval', config: { policy: 'ask' } },
    { id: 'permission', config: { presets: { 'read-only': { sandbox: 'read-only', approval: 'ask' }, 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } }, defaultPreset: 'workspace-write' } },
    { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: root } },
    { id: 'session-controller', disabled: true },
    ...['tool-fs', 'tool-bash', 'session-title-llm', 'hmr', 'plugin-manager', 'config-editor', 'settings', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics', 'credentials', 'authorization', 'deepseek-account', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'agent-instructions', 'skill-filesystem', 'client-hmr', 'open-in-app', 'webserver', 'connection', 'file-uploads', 'account-controller'].map(id => ({ id, disabled: true })),
    { id: 'credentials', disabled: false, config: { path: join(home, 'authored-empty-credentials.yaml'), dshHome: home, watch: false } },
    { id: 'storage-json', config: { root: join(home, 'storage') } },
    { id: 'spill-local', config: { root: join(home, 'spill') } },
    { id: 'attachment-local', config: { root: join(home, 'attachments') } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] } },
    { insert: [
      { id: 'companion-session-controller', name: local('companion-workspace/session-controller.mjs') },
      { id: 'preset-companion', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'companion', name: 'Authored Companion wiring', plugins: children } },
    ] },
    { insert: [{ ...proposal.rootEntry, config: { workspaceRoot: root, ledgerRoot: join(home, 'private-ledger'), bridgeRoot: join(home, 'absent-profile-bridges') } }] },
  ];
}

test('installed SDK scoped reader + native owner: public tool routing, real root depth default, lifetime and disabled index', { timeout: 30000 }, async () => {
  await mkdir('.dumps/tasks', { recursive: true });
  const home = await mkdtemp(resolve('.dumps/tasks/task91-native-'));
  const root = join(home, 'workspace'); await mkdir(root);
  const dir = join(home, 'profiles/companion'); await mkdir(dir, { recursive: true });
  const oldHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const evidence = { ok: false, productionActivation: false, syntheticHome: home, modelCalls: 0, checks: [], fixtureDifferences: ['authored storage/home/ledger/root', 'no HTTP/Connection/OAuth/provider/telemetry', 'fixture-only forbidden model adapter', 'core-authored reader root; public create fails without destination host'] };
  let app; let caller; let turn; let mainWriter;
  try {
    await writeFile(join(home, 'authored-empty-credentials.yaml'), '{}\n', { mode: 0o600 });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'task91-authored-fixture', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } } }));
    await writeFile(join(dir, 'cordis.yml'), '[]\n');
    await writeFile(join(dir, 'cordis.patch.yml'), YAML.stringify(fixtureComposition(home, root)));
    const boot = await load('dsh-app-boot');
    const profile = boot.loadProfileDirectory('task91-isolated', dir, anchor);
    const origin = { name: 'companion', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home, startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], overlays: [] };
    const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile, home });
    app = await boot.boot('task91-isolated', join(dir, 'cordis.yml'), boot.readProfilePatches('task91-isolated', origin, profile), async ctx => {
      ctx.provide('profileContext', origin);
      // Public transport seam only; SDK Agent/workspace/persistence/approvals remain real.
      ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, resolve: () => { throw new Error('No fixture uploads'); }, bindPrompt: () => { throw new Error('No fixture submissions'); }, retirePrompt: () => {} });
      const { provideCmdline } = await load('dsh-cmdline'); provideCmdline(ctx, { args: ['--no-open', '--port', '0'], exit: () => {} });
      await ctx.plugin(boot.PluginPackages, { resolution });
    });
    assert.equal(app.get('webserver'), undefined); assert.equal(app.get('connection'), undefined);
    const { LlmAdapter, ToolCallId } = await load('dsh-llm');
    class ForbiddenModel extends LlmAdapter {
      resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] }); }
      stream() { evidence.modelCalls++; throw new Error('TASK91 FORBIDS MODEL DISPATCH'); }
    }
    await app.plugin({ name: 'task91-forbidden-model', inject: ['llm'], apply: ctx => { ctx.effect(() => ctx.llm.registerAdapter(['openai-codex'], new ForbiddenModel())); } });
    const { default: SpecializedController } = await import(local('companion-workspace/session-controller.mjs'));
    const { symbols } = await load('cordis');
    assert.ok(app.sessionController[symbols.original] instanceof SpecializedController);
    const { inject } = await import('./index.mjs'); assert.ok(inject.includes('sessions'));
    assert.ok(app.sessions, 'Root Context can resolve public store without plugin dependency injection');
    await app.plugin({ name: 'task91-missing-inject-negative', inject: inject.filter(key => key !== 'sessions'), apply(ctx) {
      assert.throws(() => ctx.sessions, /cannot get property "sessions" without inject/);
    } });
    caller = await app.agents.create({ sessionId: 'task91-authored-origin', meta: { cwd: root, agentPreset: 'companion' }, agentOptions: { provider: 'openai-codex', model: 'gpt-6-sol', reasoningEffort: 'low' }, setup: async ctx => { await app.agentPresets.mount(ctx, 'companion'); } });
    const names = app.tools.schemas(caller.agent).map(row => row.name);
    assert.equal(names.filter(name => name === 'session').length, 1); assert.equal(names.filter(name => name === 'session_create').length, 1);
    assert.equal(app.sessionCreateAuthority.capabilities().ready, true);
    assert.equal(app.sessionCreateOwner.capabilities().new_project, false, 'cross-profile registry creation has no exclusive ownership proof');
    assert.equal(app.sessionCreateOwner.capabilities().destination_profile, 'dsh-tui');
    let seq = 0;
    const invoke = (name, args, agent = caller.agent) => app.tools.execute({ name, callId: ToolCallId(`task91-${++seq}`), arguments: args, agent, signal: new AbortController().signal });
    const value = result => { assert.equal(result.isError, false, JSON.stringify(result)); return typeof result.value === 'string' ? JSON.parse(result.value) : result.value; };
    const open = agent => { agent.session.append('turn/start', { turn: 1 }); turn = agent.session; };
    const close = () => { turn.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); turn = undefined; };
    open(caller.agent);
    const source = value(await invoke('session', { operation: 'sources' })).sources[0];
    assert.equal(source.index.reason, 'search_disabled');
    for (let i = 0; i < 4; i++) assert.equal(value(await invoke('session', { operation: 'sources' })).sources[0].sourceId, source.sourceId);
    const before = app.agentDefaultModel.currentSelection();
    // The public tool now targets dsh-tui. Missing hosts must not manufacture a
    // local Companion, request approval, or create a project as a fallback.
    const rootsBefore = app.agents.roots().map(agent => agent.id);
    const noApproval = app.on('approval/request', () => { assert.fail('No host must fail before approval'); }, { prepend: true });
    let unavailable;
    try { unavailable = value(await invoke('session_create', { operation: 'create', request: { version: 1, owner_intent: 'Authored missing destination test', target: { kind: 'current' } } })); }
    finally { noApproval(); }
    assert.equal(unavailable.code, 'destination_host_unavailable', JSON.stringify(unavailable));
    assert.deepEqual(app.agents.roots().map(agent => agent.id), rootsBefore);
    assert.deepEqual(await readdir(root), []);
    // Reader lifecycle uses an authored native root, not public creation. Legacy
    // project proof/write fences remain exercised by native-runtime.test.mjs.
    const childHandle = await app.agents.create({ sessionId: 'task91-authored-reader-root', meta: { cwd: root, agentPreset: 'companion' }, agentOptions: { provider: 'openai-codex', model: 'gpt-6-sol', reasoningEffort: 'low' }, setup: async ctx => { await app.agentPresets.mount(ctx, 'companion'); } });
    app.effect(() => () => childHandle.dispose());
    const child = childHandle.agent; assert.ok(app.agents.roots().includes(child));
    const childNames = app.tools.schemas(child).map(row => row.name);
    assert.ok(childNames.includes('session')); assert.ok(childNames.includes('session_create'));
    close(); await caller.dispose(); caller = undefined;
    assert.equal(app.agents.get(child.id), child);
    assert.equal(app.sessionCreateAuthority.allows({ agent: child }, app.sandboxPolicy.resolve({ session: child.session })), false, 'authored root must not forge a legacy project proof');
    evidence.checks.push('root Context differs from missing-inject plugin Context', 'CURRENT exact aliases register both tools once', 'specialized controller preserved', 'optional authority joins owner after preset', 'fresh Cordis proxies keep sourceId', 'authored root mounts exact combined preset', 'caller disposal preserves root but never invents a proof', 'public create without host rejects before approval and creates no Companion or project');
    child.session.append('user/message', { id: 'authored-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'task91 authored combined needle' }] }, { surfaceOp: 'append' });
    assert.equal(await app.sessions.flush(child.session), true);
    const stored = await app.sessionPersistence.stat(child.id);
    assert.equal(child.session.header.delegationDepth, undefined); assert.equal(stored.header.delegationDepth, 0);
    assert.equal(child.session.header.id, stored.header.id); assert.equal(child.session.header.cwd, stored.header.cwd);
    assert.equal(child.session.header.createdAt, stored.header.createdAt); assert.equal(child.session.header.isSeeded, stored.header.isSeeded);
    evidence.realNativeRootDepth = { liveAbsent: child.session.header.delegationDepth === undefined, persisted: stored.header.delegationDepth, headerRewrite: false };
    // The executor remains the actual Companion owner. Its own conversation is
    // not a readable target: author a distinct principal through public storage.
    const mainId = 'task91-authored-main';
    mainWriter = await app.sessionPersistence.create({ id: mainId, version: stored.header.version, createdAt: 100, cwd: root, isSeeded: false, agentPreset: 'standard', delegationDepth: 0 });
    await mainWriter.append([{ seq: 0, time: 101, type: 'user/message', surfaceOp: 'append', data: { id: 'main-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'task91 authored combined needle' }] } }]);
    await mainWriter.flush();
    open(child);
    // The authored turn marker is a deliberate write, so drain it before read-only hashes.
    assert.equal(await app.sessions.flush(child.session), true);
    const canonicalBefore = await hashes(join(home, 'sessions'));
    const sourceId = value(await invoke('session', { operation: 'sources' }, child)).sources[0].sourceId;
    const describe = value(await invoke('session', { operation: 'describe', targetOperation: 'context' }, child));
    assert.equal(describe.operation, 'describe'); assert.equal(describe.backend, 'recent-files');
    assert.equal(describe.parameters.pathRef, undefined);
    for (const targetOperation of ['find','inspect']) {
      const contract=value(await invoke('session',{operation:'describe',targetOperation},child));
      assert.equal(contract.targetOperation,targetOperation);assert.equal(contract.backend,'recent-files');
    }
    const paths = value(await invoke('session', { operation: 'paths', sourceId, sessionId: mainId }, child));
    assert.equal(paths.paths.length, 1); assert.equal(paths.paths[0].readable, true);
    const listed = value(await invoke('session', { operation: 'list', sourceId }, child));
    assert.equal(listed.backend, 'recent-files');
    assert.ok(listed.sessions.some(row => row.header.id === mainId), JSON.stringify(listed));
    assert.ok(listed.sessions.every(row => row.header.id !== child.id && row.header.agentPreset !== 'companion'), JSON.stringify(listed));
    const excluded = value(await invoke('session', { operation: 'read', sourceId, sessionId: child.id }, child));
    assert.equal(excluded.code, 'session_excluded'); assert.equal(excluded.events, undefined);
    const ownerPaths = value(await invoke('session', { operation: 'paths', sourceId, sessionId: child.id }, child));
    const rejectedPath = await invoke('session', { operation: 'read', sourceId, pathRef: ownerPaths.paths[0].pathRef }, child);
    if (!rejectedPath.isError) {
      const rejected = value(rejectedPath);
      assert.ok(['invalid_argument', 'session_excluded'].includes(rejected.code), 'metadata pathRef must not bypass Companion exclusion');
      assert.equal(rejected.events, undefined);
    }
    const context = value(await invoke('session', { operation: 'context', sourceId, sessionId: mainId }, child));
    assert.ok(context.events.some(row => row.text === 'task91 authored combined needle'), JSON.stringify(context));
    const read = value(await invoke('session', { operation: 'read', sourceId, sessionId: mainId }, child));
    assert.equal(read.nextCursor, null); assert.ok(read.revision); assert.equal(read.backend, 'recent-files');
    const search = value(await invoke('session', { operation: 'find', sourceId, sessionId: mainId, query: 'combined needle' }, child));
    assert.equal(search.hits.length, 1, JSON.stringify(search)); assert.equal(search.engine, 'literal-recent-files'); assert.equal(search.selectedFiles, 1);
    const unchanged = value(await invoke('session', { operation: 'read', sourceId, sessionId: mainId, revision: read.revision }, child));
    assert.equal(unchanged.unchanged, true);
    assert.deepEqual(await hashes(join(home, 'sessions')), canonicalBefore);
    await mainWriter.append([{ seq: 1, time: 102, type: 'user/message', surfaceOp: 'append', data: { id: 'authored-append', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'task91 authored appended text' }] } }]);
    await mainWriter.flush();
    const poll = value(await invoke('session', { operation: 'read', sourceId, sessionId: mainId, revision: read.revision }, child));
    assert.ok(poll.events.some(row => row.text === 'task91 authored appended text'), JSON.stringify(poll));
    assert.notEqual(poll.revision, read.revision);
    await mainWriter.close(); mainWriter = undefined;
    assert.equal(app.sessionQuery.config.openAt, 'never'); assert.equal(app.sessionQuery.config.path, ':memory:');
    assert.deepEqual(app.agentDefaultModel.currentSelection(), before); assert.equal(evidence.modelCalls, 0);
    evidence.checks.push('native live absent depth and durable zero accepted without rewriting headers', 'Companion owner executes scoped tool but remains excluded by id and metadata pathRef', 'sources/describe/paths/list/context/read/find use real public scoped tool routing against separate standard target', 'canonical byte hashes unchanged by reads/find', 'native flushed append refreshes file revision polling', 'memory index stays openAt never', 'literal recent-file scope is explicit', 'saved selection unchanged');
    close();
    const authority = app.sessionCreateAuthority; const epoch = authority.capabilities().epoch;
    await app.fiber.dispose(); app = undefined;
    assert.equal(authority.capabilities().ready, false); assert.ok(authority.capabilities().epoch > epoch);
    assert.equal(authority.allows({ agent: child }, { mode: 'workspace-write', workspaceRoot: child.session.header.cwd }), false);
    evidence.checks.push('owner teardown revokes epoch/proofs', 'zero model dispatch and no HTTP/Connection');
    evidence.ok = true;
  } finally {
    if (turn) { turn.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); turn = undefined; }
    await mainWriter?.close(); await caller?.dispose(); await app?.fiber.dispose();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    await writeFile(join(home, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(`task91 isolated evidence: ${join(home, 'evidence.json')}`);
  }
});

function pureFixture(depth = undefined, storedDepth = 0) {
  const id = 'task91-pure';
  const base = { id, version: 4, createdAt: 100, cwd: '/authored', isSeeded: false };
  const live = { header: { ...base, ...(depth === undefined ? {} : { delegationDepth: depth }) }, seq: 2 };
  const events = [0, 1].map(seq => ({ seq, time: seq + 1, type: 'user/message', data: { id: `message-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `authored ${seq}` }] } }));
  const persistence = { name: 'authored-public', identity: {}, config: { root: '/authored-store' }, async stat() { return { header: { ...base, delegationDepth: storedDepth }, revision: 'authored-revision', eventCount: 2 }; } };
  const ctx = { sessionPersistence: persistence, sessions: { get: () => live }, sessionQuery: { async observeSession() { return { source: 'live', header: live.header, events, [Symbol.dispose]() {} }; } } };
  const reader = createReadSide(ctx);
  return { id, base, live, ctx, events, reader };
}

test('lifecycle default only accepts undefined/zero, never malformed depth or genuine nonzero/header drift', async () => {
  for (const depth of [undefined, 0]) {
    const f = pureFixture(depth);
    assert.equal((await f.reader.execute({ operation: 'context', sessionId: f.id })).events.length > 0, true);
    f.reader.clear();
  }
  const nonzero = pureFixture(1, 1);
  assert.ok((await nonzero.reader.execute({ operation: 'context', sessionId: nonzero.id })).events.length);
  nonzero.reader.clear();
  for (const depth of [undefined, 0]) {
    const f = pureFixture(depth, 1);
    await assert.rejects(f.reader.execute({ operation: 'context', sessionId: f.id }), { code: 'source_conflict' });
    f.reader.clear();
  }
  for (const depth of [1, null, NaN, '0', false]) {
    const f = pureFixture(depth);
    await assert.rejects(f.reader.execute({ operation: 'context', sessionId: f.id }), { code: 'source_conflict' });
    f.reader.clear();
  }
  for (const [key, value] of [['id', 'other'], ['cwd', '/other'], ['createdAt', 101], ['parentSession', 'parent'], ['isSeeded', true], ['incarnation', 'other']]) {
    const f = pureFixture(); f.live.header = { ...f.live.header, [key]: value };
    await assert.rejects(f.reader.execute({ operation: 'context', sessionId: f.id }), { code: 'source_conflict' });
    f.reader.clear();
  }
});

test('defaulted root depth does not weaken frozen cursor, polling incarnation or source identity fences', async () => {
  for (const [key, value] of [['delegationDepth', 1], ['incarnation', 'new-incarnation']]) {
    const f = pureFixture();
    const read = await f.reader.execute({ operation: 'read', sessionId: f.id, limit: 1 });
    assert.ok(read.nextCursor); assert.ok(read.pollingCursor);
    f.live.header = { ...f.live.header, [key]: value };
    await assert.rejects(f.reader.execute({ operation: 'read', sessionId: f.id, cursor: read.nextCursor, limit: 1 }), { code: 'cursor_stale' });
    await assert.rejects(f.reader.execute({ operation: 'read', sessionId: f.id, pollingCursor: read.pollingCursor }), { code: 'source_conflict' });
    f.reader.clear();
  }
  const f = pureFixture();
  const sourceId = f.reader.locator.source().sourceId;
  f.ctx.sessionPersistence.config.root = '/other-authored-store';
  await assert.rejects(f.reader.execute({ operation: 'context', sessionId: f.id, sourceId }), { code: 'source_changed' });
  f.reader.clear();
});
