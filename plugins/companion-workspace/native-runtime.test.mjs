import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { profileFiles, YAML } from '../../tools/session-companion/profile.mjs';
import { COMPANION_WORKSPACE_ROOT } from './controller-policy.mjs';
import { DSH_CLI_ANCHOR } from '../session/host-paths.mjs';

const anchor = DSH_CLI_ANCHOR;
const require = createRequire(anchor);
const load = name => import(require.resolve(`@deepseek-ai/${name}`));

function ownPixelPng() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([prefix, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

test('actual Gateway creates dedicated cwd; native host reads and workspace-only writes survive legacy cwd', { timeout: 30000 }, async () => {
  await mkdir('.dumps/tasks', { recursive: true });
  const home = await mkdtemp(resolve('.dumps/tasks/task79-native-regression-'));
  const dir = join(home, 'profiles', 'companion');
  await mkdir(dir, { recursive: true });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const files = profileFiles(process.cwd());
  const patch = YAML.parse(files['cordis.patch.yml']);
  patch.find(row => row.id === 'session-persistence-jsonl').config = { root: join(home, 'sessions'), compression: 'none' };
  const inserted = patch.find(row => row.insert);
  inserted.insert = inserted.insert.filter(row => !['companion-oauth', 'companion-private-link', 'companion-catalog-api'].includes(row.id));
  inserted.insert.find(row => row.id === 'preset-companion').config.plugins.find(row => row.id === 'companion-session').config = { profile: 'companion', root: join(home, 'bridge'), ledgerPath: join(home, 'no-ledger') };
  // Keep actual controller/Gateway/Connection/FileUploads/FS providers. Only
  // readers of existing history, account credentials and network models are absent.
  for (const id of ['hmr', 'plugin-manager', 'config-editor', 'settings', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics', 'credentials', 'authorization', 'deepseek-account', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'agent-instructions', 'skill-filesystem', 'client-hmr', 'open-in-app']) patch.push({ id, disabled: true });
  patch.push(
    { id: 'credentials', disabled: false, config: { path: join(home, 'own-transport-credentials.yaml'), dshHome: home, watch: false } },
    { id: 'storage-json', config: { root: join(home, 'storage') } },
    { id: 'spill-local', config: { root: join(home, 'spill') } },
    { id: 'attachment-local', config: { root: join(home, 'attachments') } },
    { id: 'webserver', config: { host: '127.0.0.1', port: 0, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 } },
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] } },
  );
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), name === 'cordis.patch.yml' ? YAML.stringify(patch) : content);
  const boot = await load('dsh-app-boot');
  const profile = boot.loadProfileDirectory('task79-native-test', dir, anchor);
  const origin = { name: 'companion', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: process.cwd(), home, startedBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], overlays: [] };
  let app;
  const evidence = { preparedNotInstalled: true, modelCalls: 0, processCwd: process.cwd() };
  try {
    const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile, home });
    app = await boot.boot('task79-native-test', join(dir, 'cordis.yml'), boot.readProfilePatches('task79-native-test', origin, profile), async ctx => {
      ctx.provide('profileContext', origin);
      const { provideCmdline } = await load('dsh-cmdline');
      provideCmdline(ctx, { args: ['--no-open', '--port', '0'], exit: () => {} });
      await ctx.plugin(boot.PluginPackages, { resolution });
    });
    // read_image requires an image-capable route even without an LLM request.
    // This fixture supplies metadata only and fails any network dispatch.
    const { LlmAdapter } = await load('dsh-llm');
    class FixtureMetadata extends LlmAdapter {
      resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] }); }
      stream() { evidence.modelCalls++; assert.fail('No fixture model request is permitted'); }
    }
    await app.plugin({ name: 'own-fixture-image-metadata', inject: ['llm'], apply: ctx => { ctx.effect(() => ctx.llm.registerAdapter(['openai-codex', 'fixture-no-network'], new FixtureMetadata())); } });
    assert.equal(app.sessionController.constructor.name, 'CompanionSessionController');
    const invoke = request => app.typertGateway.invoke({ namespace: 'session', method: 'create', args: { request }, signal: new AbortController().signal });
    const receipt = await invoke({ agentPreset: 'companion' });
    const agent = app.agents.get(receipt.sessionId);
    assert.ok(agent);
    assert.equal(agent.session.header.cwd, COMPANION_WORKSPACE_ROOT);
    assert.equal(app.agentPresets.composedPreset(agent.ctx), 'companion');
    const policy = app.sandboxPolicy.resolve({ session: agent.session });
    assert.equal(policy.mode, 'workspace-write');
    assert.equal(policy.workspaceRoot, COMPANION_WORKSPACE_ROOT);
    await assert.rejects(invoke({ agentPreset: 'companion', cwd: home }), error => error.code === 'companion/invalid-create-request');
    const { scopeOf } = await load('dsh-scope');
    const { renderContextSections } = await load('dsh-system-prompt');
    const assembly = await app.systemPrompt.assemble({ scope: scopeOf(agent.ctx), agent, session: agent.session });
    assert.ok(renderContextSections(assembly).some(row => row.name === 'sandbox:policy' && row.text.includes(COMPANION_WORKSPACE_ROOT)));
    const outside = join(home, 'outside-host.txt');
    await writeFile(outside, 'SYNTHETIC_HOST_READ\n');
    await mkdir(join(COMPANION_WORKSPACE_ROOT, '.dumps'), { recursive: true });
    const ownedWorkspace = await mkdtemp(join(COMPANION_WORKSPACE_ROOT, '.dumps', 'task79-fixture-'));
    const { ToolCallId } = await load('dsh-llm');
    let call = 0;
    const tool = (name, args, subject = agent, signal = new AbortController().signal) => app.tools.execute({ name, callId: ToolCallId(`fixture-${++call}`), arguments: args, agent: subject, signal });
    const hostRead = await tool('read', { file_path: outside });
    assert.equal(hostRead.isError, false);
    assert.ok(JSON.stringify(hostRead.value).includes('SYNTHETIC_HOST_READ'));
    assert.equal((await tool('list', { path: home, limit: 100 })).isError, false);
    const image = join(home, 'own-pixel.png');
    await writeFile(image, ownPixelPng());
    const imageRead = await tool('read_image', { file_path: image });
    assert.equal(imageRead.isError, false, JSON.stringify(imageRead));
    const technicalTemp = await mkdtemp('/tmp/task79-own-');
    assert.equal((await tool('write', { file_path: join(technicalTemp, 'technical.txt'), content: 'OWN_TEMP' })).isError, false);
    const inside = join(ownedWorkspace, 'normal/nested/report.txt');
    assert.equal((await tool('write', { file_path: inside, content: 'OWN_INSIDE\n' })).isError, false);
    assert.equal((await tool('read', { file_path: inside })).isError, false);
    assert.equal((await tool('edit', { file_path: inside, old_string: 'OWN_INSIDE', new_string: 'OWN_EDITED' })).isError, false);
    const outsideWrite = await tool('write', { file_path: outside, content: 'MUST_NOT_WRITE' });
    assert.equal(outsideWrite.isError, true);
    assert.match(JSON.stringify(outsideWrite), /workspace-write/);
    assert.equal((await tool('edit', { file_path: outside, old_string: 'SYNTHETIC_HOST_READ', new_string: 'MUST_NOT_EDIT' })).isError, true);
    const link = join(ownedWorkspace, 'outside-link');
    await symlink(home, link);
    const linkedWrite = await tool('write', { file_path: join(link, 'outside-host.txt'), content: 'MUST_NOT_WRITE' });
    assert.equal(linkedWrite.isError, true);
    assert.match(JSON.stringify(linkedWrite), /workspace-write/);
    assert.equal(await readFile(outside, 'utf8'), 'SYNTHETIC_HOST_READ\n');
    // Only this new synthetic Agent models the immutable cwd of a legacy chat.
    const legacyHandle = await app.agents.create({ sessionId: `synthetic-legacy-${Date.now()}`, meta: { cwd: home, agentPreset: 'companion' }, agentOptions: { provider: 'fixture-no-network', model: 'fixture' }, setup: async ctx => { await app.agentPresets.mount(ctx, 'companion'); } });
    const legacy = legacyHandle.agent;
    assert.equal((await tool('read', { file_path: outside }, legacy)).isError, false);
    assert.equal((await tool('list', { path: home }, legacy)).isError, false);
    assert.equal((await tool('read_image', { file_path: image }, legacy)).isError, false);
    // Exercise the actual preset-scoped pre-execute waterfall, but never answer
    // an approval or dispatch a Bash body. Native confine may probe its runner.
    const { scopeTarget } = await load('dsh-scope');
    const command = 'printf "OWN_LITERAL\\n"\n# trailing full command';
    const bashExec = { name: 'bash', callId: ToolCallId('own-bash-preflight'), arguments: { command, description: 'Owned synthetic preflight' }, agent, signal: new AbortController().signal };
    const ask = await app.waterfall(scopeTarget(agent, agent), 'tools/pre-execute', bashExec, () => Promise.resolve({ kind: 'allow' }));
    assert.equal(ask.kind, 'ask');
    assert.ok(ask.reason.endsWith(command));
    assert.ok(ask.reason.includes(`CWD: ${COMPANION_WORKSPACE_ROOT}`));
    const refusedLegacyBash = await app.waterfall(scopeTarget(legacy, legacy), 'tools/pre-execute', { ...bashExec, agent: legacy }, () => Promise.resolve({ kind: 'allow' }));
    assert.equal(refusedLegacyBash.kind, 'deny');
    assert.equal((await tool('write', { file_path: outside, content: 'MUST_NOT_WRITE' }, legacy)).isError, true);
    assert.equal((await tool('edit', { file_path: outside, old_string: 'SYNTHETIC', new_string: 'MUST_NOT_EDIT' }, legacy)).isError, true);
    assert.equal(legacy.session.header.cwd, home);
    const canceled = new AbortController(); canceled.abort();
    assert.equal((await tool('read', { file_path: outside }, agent, canceled.signal)).isError, true);
    assert.equal(evidence.modelCalls, 0);
    evidence.ok = true;
    evidence.controller = app.sessionController.constructor.name;
    evidence.headerCwd = agent.session.header.cwd;
    evidence.policyRoot = policy.workspaceRoot;
    evidence.checks = ['actual Gateway subclass dispatch', 'dedicated header/preset/policy/context', 'reject client-selected cwd', 'host read/list/image outside workspace', 'normal nested write/edit inside workspace', 'native technical temp write permitted', 'outside write/edit denied', 'symlink write denied', 'legacy read/list/image allowed; mutations/Bash denied; header unchanged', 'actual native scoped Bash ASK full literal+cwd without dispatch', 'cancel before native read'];
  } finally {
    await app?.fiber.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await writeFile(join(home, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
