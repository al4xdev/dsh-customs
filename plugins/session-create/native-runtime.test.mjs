import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, access, readFile, symlink, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { profileFiles, YAML } from '../../tools/session-companion/profile.mjs';
import { AuthorityRegistry } from './authority.mjs';
import { OperationStore } from './operation-store.mjs';
import { createController } from './controller.mjs';
import { parameters, outputSchema, parseArgs } from './contracts.mjs';

// Explicit internal regression fixture, never the production session_create binding.
const legacyTool = { name: 'fixture-legacy-create', inject: ['tools', 'sessionCreateOwner'], apply(ctx) {
  ctx.tools.guard(exec => exec.name === 'legacy_session_create' && exec.agent?.session.header.agentPreset !== 'companion' ? 'session-create-scope-denied' : undefined);
  ctx.tools.register({ name: 'legacy_session_create', description: 'Fixture-only legacy provisioning', parameters,
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: (args, exec) => { parseArgs(args); return ctx.sessionCreateOwner.execute(args, exec); } });
} };

const anchor = '/home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh/package.json';
const require = createRequire(anchor);
const load = name => import(require.resolve(`@deepseek-ai/${name}`));

test('legacy INTERNAL provisioning: SDK authority/lifetime/approval, not public profile creation', { timeout: 30000 }, async () => {
  await mkdir('.dumps/tasks', { recursive: true });
  const home = await mkdtemp(resolve('.dumps/tasks/task83-native-'));
  const root = join(home, 'workspace'); await mkdir(root);
  const dir = join(home, 'profiles', 'companion'); await mkdir(dir, { recursive: true });
  const previousHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const files = profileFiles(process.cwd()); const patch = YAML.parse(files['cordis.patch.yml']);
  patch.find(row => row.id === 'session-persistence-jsonl').config = { root: join(home, 'sessions'), compression: 'none' };
  patch.find(row => row.id === 'sandbox-policy').config.workspaceRoot = root;
  const inserted = patch.find(row => row.insert).insert;
  // Stock controller is confined to synthetic authored cwd in this fixture only. Production specialized controller is UNCHANGED.
  patch.find(row => row.id === 'session-controller').disabled = false;
  for (const id of ['companion-session-controller', 'companion-oauth', 'companion-private-link', 'companion-catalog-api']) {
    const at = inserted.findIndex(row => row.id === id); if (at >= 0) inserted.splice(at, 1);
  }
  const preset = inserted.find(row => row.id === 'preset-companion');
  preset.config.plugins = preset.config.plugins.filter(row => !['companion-session', 'skill-filesystem', 'tool-skill'].includes(row.id));
  for (const id of ['hmr', 'plugin-manager', 'config-editor', 'settings', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics', 'credentials', 'authorization', 'deepseek-account', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'agent-instructions', 'skill-filesystem', 'client-hmr', 'open-in-app']) patch.push({ id, disabled: true });
  patch.push(
    { id: 'credentials', disabled: false, config: { path: join(home, 'own-transport.yaml'), dshHome: home, watch: false } },
    { id: 'storage-json', config: { root: join(home, 'storage') } },
    { id: 'spill-local', config: { root: join(home, 'spill') } },
    { id: 'attachment-local', config: { root: join(home, 'attachments') } },
    { id: 'webserver', config: { host: '127.0.0.1', port: 0, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] } },
  );
  // No listening port or browser connection is needed to exercise Host public APIs.
  for (const id of ['webserver', 'connection', 'file-uploads', 'account-controller']) patch.push({ id, disabled: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), name === 'cordis.patch.yml' ? YAML.stringify(patch) : content);
  const boot = await load('dsh-app-boot'); const profile = boot.loadProfileDirectory('task83-native-test', dir, anchor);
  const origin = { name: 'companion', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home, startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], overlays: [] };
  let app; let rootHandle; let openTurn = false; let childTurn;
  const phase = label => { process.stderr.write(`task83 fixture: ${label}\n`); };
  const evidence = { syntheticHome: home, productionActivation: false, modelCalls: 0, checks: [] };
  try {
    const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile, home });
    app = await boot.boot('task83-native-test', join(dir, 'cordis.yml'), boot.readProfilePatches('task83-native-test', origin, profile), async ctx => {
      ctx.provide('profileContext', origin);
      // Public attachment seam is authored/unavailable: empty creation has no file receipts.
      // This avoids constructing Connection/HTTP while leaving native session/project owners real.
      ctx.provide('fileUploads', { registerAgentResolver: () => () => {}, resolve: () => { throw new Error('Fixture does not admit attachments'); }, bindPrompt: () => { throw new Error('Fixture does not submit prompts'); }, retirePrompt: () => {} });
      const { provideCmdline } = await load('dsh-cmdline'); provideCmdline(ctx, { args: ['--no-open', '--port', '0'], exit: () => {} });
      await ctx.plugin(boot.PluginPackages, { resolution });
    });
    const { LlmAdapter, ToolCallId } = await load('dsh-llm');
    class ForbiddenModel extends LlmAdapter {
      resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] }); }
      stream() { evidence.modelCalls++; throw new Error('NO MODEL DISPATCH ALLOWED IN TASK83 FIXTURE'); }
    }
    await app.plugin({ name: 'task83-forbidden-model', inject: ['llm'], apply: ctx => { ctx.effect(() => ctx.llm.registerAdapter(['openai-codex'], new ForbiddenModel())); } });
    // Internal legacy owner lives only in this authored fixture; production owner
    // routes to dsh-tui and must never be used to manufacture a Companion child.
    const { installModelSelection } = await load('dsh-agent');
    const authority = new AuthorityRegistry({ agents: app.agents, root });
    const handles = new Map();
    const controller = createController(app, { authority, store: new OperationStore(join(home, 'private-ledger')), installModelSelection, handles });
    app.provide('sessionCreateAuthority', authority.public);
    app.provide('sessionCreateOwner', controller);
    app.effect(() => async () => { authority.close(); await controller.drain(); await Promise.allSettled([...handles.values()].map(handle => handle.dispose())); });
    rootHandle = await app.agents.create({ sessionId: 'task83-authored-origin', meta: { cwd: root, agentPreset: 'companion' }, agentOptions: { provider: 'openai-codex', model: 'gpt-6-sol', reasoningEffort: 'low' }, setup: async ctx => { await app.agentPresets.mount(ctx, 'companion'); } });
    const agent = rootHandle.agent;
    await agent.ctx.plugin(legacyTool);
    assert.equal(app.tools.get('session_create', agent), undefined);
    const schema = app.tools.schemas(agent).find(row => row.name === 'legacy_session_create'); assert.ok(schema); assert.equal(schema.parameters.additionalProperties, false);
    assert.equal(app.sessionCreateOwner.capabilities().new_project, true);
    let outcome = 'rejected'; let pending;
    const off = app.on('approval/request', async req => {
      pending = req; assert.equal(req.toolName, 'session_create');
      await assert.rejects(access(join(root, 'projects')), { code: 'ENOENT' });
      return outcome;
    }, { prepend: true });
    agent.session.append('turn/start', { turn: 1 }); openTurn = true;
    phase('ready; entering rejected body gate');
    let seq = 0;
    const invoke = (args, subject = agent) => app.tools.execute({ name: 'legacy_session_create', callId: ToolCallId(`task83-native-${++seq}`), arguments: args, agent: subject, signal: new AbortController().signal });
    const request = { version: 1, owner_intent: 'Autoria fixture: projeto novo vazio', target: { kind: 'new_project', name: 'NativeProject' } };
    // An unrelated pre-hook allow cannot erase a gate inside the actual registered body.
    const preAllow = app.on('tools/pre-execute', async (exec, next) => exec.name === 'legacy_session_create' ? { kind: 'allow' } : next(), { prepend: true });
    const timer = setTimeout(() => { phase(`bounded pending diagnostic ${JSON.stringify(app.sessionCreateOwner.diagnostics())}`); }, 2000);
    const denied = await invoke({ operation: 'create', request }); clearTimeout(timer); assert.equal(denied.isError, false, JSON.stringify(denied)); assert.equal(denied.value.code, 'approval_rejected');
    await assert.rejects(access(join(root, 'projects')), { code: 'ENOENT' }); await assert.rejects(access(join(home, 'private-ledger')), { code: 'ENOENT' });
    assert.ok(pending.reason.includes('CRIAR VAZIA')); assert.ok(pending.reason.includes('create_projects_parent'));
    assert.equal((await invoke({ operation: 'create', request, confirmed: true })).isError, true);
    const { setApprovalPolicy } = await load('dsh-user-approval');
    setApprovalPolicy(agent.session, 'never');
    assert.equal((await invoke({ operation: 'create', request })).value.code, 'approval_rejected');
    await assert.rejects(access(join(root, 'projects')), { code: 'ENOENT' });
    setApprovalPolicy(agent.session, 'ask');
    phase('rejected/never proof complete; entering approved provisioning');
    outcome = 'allowed-once'; const created = await invoke({ operation: 'create', request });
    assert.equal(created.isError, false, JSON.stringify(created)); assert.equal(created.value.status, 'completed', JSON.stringify(created.value));
    off(); preAllow();
    phase('approved provisioning returned; checking native FS');
    const child = app.agents.get(created.value.session_id); assert.ok(child); assert.equal(child.session.header.cwd, join(root, 'projects', 'NativeProject'));
    await child.ctx.plugin(legacyTool);
    const workspace = await app.workspaceRegistry.resolveByPath(child.session.header.cwd); assert.ok(workspace.sessionIds.includes(child.id));
    const policy = app.sandboxPolicy.resolve({ session: child.session }); assert.equal(app.sessionCreateAuthority.allows({ agent: child }, policy), true);
    const execute = (name, args, subject = child) => app.tools.execute({ name, callId: ToolCallId(`task83-native-${++seq}`), arguments: args, agent: subject, signal: new AbortController().signal });
    const nested = join(child.session.header.cwd, 'nested', 'report.txt');
    assert.equal((await execute('write', { file_path: nested, content: 'AUTHORED FIXTURE' })).isError, false);
    assert.equal(await readFile(nested, 'utf8'), 'AUTHORED FIXTURE');
    const outside = join(home, 'outside.txt'); await writeFile(outside, 'NO CHANGE');
    assert.equal((await execute('write', { file_path: outside, content: 'FORBIDDEN' })).isError, true);
    await symlink(home, join(child.session.header.cwd, 'escape'));
    assert.equal((await execute('write', { file_path: join(child.session.header.cwd, 'escape', 'outside.txt'), content: 'FORBIDDEN' })).isError, true);
    assert.equal(await readFile(outside, 'utf8'), 'NO CHANGE');
    // Persisted identity alone never reconstructs authority for an unrelated incarnation.
    const legacyHandle = await app.agents.create({ sessionId: 'task83-no-proof', meta: { cwd: child.session.header.cwd, agentPreset: 'companion' }, agentOptions: { provider: 'openai-codex', model: 'gpt-6-sol' }, setup: async ctx => { await app.agentPresets.mount(ctx, 'companion'); } });
    assert.equal((await execute('write', { file_path: join(child.session.header.cwd, 'no-proof.txt'), content: 'NO' }, legacyHandle.agent)).isError, true);
    await legacyHandle.dispose();
    assert.equal(evidence.modelCalls, 0);
    assert.ok(app.agents.roots().includes(child), 'Provisioned Agent must be a native root, not caller-owned subagent');
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); openTurn = false;
    await rootHandle.dispose(); rootHandle = undefined;
    assert.equal(app.agents.get(child.id), child, 'Disposing the initiating caller must not dispose the new root');
    assert.equal((await execute('write', { file_path: join(child.session.header.cwd, 'after-parent.txt'), content: 'ROOT LIFETIME' })).isError, false);
    child.session.append('turn/start', { turn: 1 }); childTurn = child.session;
    const siblingAnswer = app.on('approval/request', (req, next) => req.toolName === 'session_create' ? Promise.resolve('allowed-once') : next(), { prepend: true });
    const siblingResult = await invoke({ operation: 'create', request: { version: 1, owner_intent: 'Authored sibling in current child project' } }, child);
    siblingAnswer(); assert.equal(siblingResult.value.status, 'completed', JSON.stringify(siblingResult));
    assert.equal(siblingResult.value.cwd, child.session.header.cwd); assert.notEqual(siblingResult.value.session_id, child.id);
    assert.ok(workspace.sessionIds.includes(siblingResult.value.session_id));
    let approveBash; let askedBash;
    const waitingApproval = new Promise(resolve => { approveBash = resolve; });
    const arrival = new Promise(resolve => { askedBash = resolve; });
    const offBash = app.on('approval/request', (req, next) => {
      if (req.toolName !== 'bash') return next();
      assert.ok(req.reason.includes(child.session.header.cwd)); askedBash(); return waitingApproval;
    }, { prepend: true });
    const payload = join(child.session.header.cwd, 'payload-MUST-NOT-RUN.txt');
    const executing = execute('bash', { command: `printf 'MUST NOT RUN' > '${payload}'`, description: 'Synthetic rejected-after-path-drift payload', workdir: child.session.header.cwd });
    await arrival;
    await rename(child.session.header.cwd, `${child.session.header.cwd}-old`); await mkdir(child.session.header.cwd);
    approveBash('allowed-once');
    const fencedBash = await executing; offBash();
    child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); childTurn = undefined;
    assert.equal(fencedBash.isError, true); assert.match(JSON.stringify(fencedBash), /workspace-session-scope-denied/);
    await assert.rejects(access(payload), { code: 'ENOENT' });
    await assert.rejects(access(join(`${child.session.header.cwd}-old`, 'payload-MUST-NOT-RUN.txt')), { code: 'ENOENT' });
    assert.equal(evidence.modelCalls, 0);
    evidence.checks = ['final sync guard fences inode drift DURING pending native Bash ASK, zero payload', 'actual SDK closed schema', 'body gate survives pre-allow', 'rejected zero business effects/ledger', 'new parent+child directory', 'native workspace membership', 'root live handle and incarnation authority', 'caller disposal preserves new root and writable scope', 'current from approved child creates sibling in SAME project', 'native never policy rejects before effects', 'native writable nested files', 'outside/symlink denial', 'foreign same-cwd no-proof denial', 'zero model dispatch'];
    evidence.ok = true;
  } finally {
    phase('teardown');
    if (childTurn) childTurn.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    if (openTurn) rootHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await rootHandle?.dispose(); await app?.fiber.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await writeFile(join(home, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
