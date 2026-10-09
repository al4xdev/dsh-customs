import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostRequire, nativeMcp } from './host.mjs';
import { projectRoot, readProjectConfig, serverConfigs } from './config.mjs';
import { install, loadProject, quiesceFiber } from './index.mjs';

const require = hostRequire();
const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
const { createScope, scopeTarget } = await import(require.resolve('@deepseek-ai/dsh-scope'));
const { ToolRuntime } = await import(require.resolve('@deepseek-ai/dsh-tools'));
const { SystemPrompt } = await import(require.resolve('@deepseek-ai/dsh-system-prompt'));
const mcp = await nativeMcp();
const stub = fileURLToPath(new URL('./stub.mjs', import.meta.url));
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-project-mcp-test-'));
  const root = join(base, 'project');
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(join(root, '.agents'));
  await mkdir(join(root, 'nested'));
  return { base, root, cwd: join(root, 'nested') };
}
function server(extra = {}) { return { command: process.execPath, args: [stub], reconnect: { enabled: false }, ...extra }; }
async function config(root, servers) { await writeFile(join(root, '.agents', 'mcp.json'), JSON.stringify({ mcpServers: servers })); }
async function nativeWorld() {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  assert.ok(ctx.tools, 'native tools service must be active');
  return ctx;
}
function agentScope(ctx, cwd) {
  const agent = { session: { header: Object.freeze({ cwd }) } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  return { agent, scope };
}
function announce(ctx, agent) { return ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' }); }

test('nearest canonical root, nested repositories, gitfiles and missing cwd', async () => {
  const { base, root, cwd } = await fixture();
  assert.equal(await projectRoot(cwd), root);
  assert.equal(await projectRoot(undefined), null);
  assert.equal(await projectRoot(base), null);
  await assert.rejects(projectRoot('relative'), /absolute/);
  const alias = join(base, 'alias');
  await symlink(root, alias);
  assert.equal(await projectRoot(join(alias, 'nested')), root);
  const child = join(cwd, 'child');
  await mkdir(child);
  const metadata = join(base, 'worktree-meta');
  await mkdir(metadata);
  await writeFile(join(metadata, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(join(child, '.git'), `gitdir: ${metadata}\n`);
  assert.equal(await projectRoot(child), child);
});

test('only project-local config; absent config contributes nothing; symlink escape denied', async () => {
  const { base, root, cwd } = await fixture();
  assert.equal(await readProjectConfig(root), null);
  assert.deepEqual(await loadProject(cwd, mcp), []);
  await writeFile(join(base, 'mcp.json'), '{"mcpServers":{}}');
  await symlink(join(base, 'mcp.json'), join(root, '.agents', 'mcp.json'));
  await assert.rejects(readProjectConfig(root), /outside the project/);
});

test('native schema, cwd normalization, HTTP, disabled exclusion and policy rejection', async () => {
  const { root, cwd } = await fixture();
  const values = await serverConfigs({ mcpServers: {
    relative: server({ cwd: 'nested' }), absolute: server({ cwd }),
    http: { url: 'http://127.0.0.1:1/mcp', headers: { 'X-Test': 'offline' } },
    disabled: { enabled: false, approval: 'prompt', command: 'must-not-run' },
  } }, root, mcp.Config);
  assert.equal(values.length, 3);
  assert.equal(values[0].cwd, cwd);
  assert.equal(values[1].cwd, cwd);
  assert.equal(values[2].transport, 'streamable-http');
  assert.equal(values[0].failOnStartupError, true);
  assert.equal(values[0].toolCallTimeoutMs, 60000);
  for (const approval of ['prompt', 'writes']) {
    await assert.rejects(serverConfigs({ mcpServers: { denied: server({ approval }) } }, root, mcp.Config), /unsupported field approval/);
  }
  await assert.rejects(serverConfigs({ mcpServers: { 'invalid.name': server() } }, root, mcp.Config), /invalid native configuration/);
  await assert.rejects(serverConfigs({ mcpServers: { bad: { command: 7 } } }, root, mcp.Config), /invalid native configuration/);
  await assert.rejects(serverConfigs({ mcpServers: { bad: server({ enabled: 'false' }) } }, root, mcp.Config), /enabled must be boolean/);
  await assert.rejects(serverConfigs({ mcpServers: { bad: server({ serverName: 'different' }) } }, root, mcp.Config), /must match/);
});

test('real native transport and registry isolate identical names in separate Agent scopes; wrapper unload closes both', async () => {
  const a = await fixture(), b = await fixture(), empty = await fixture();
  const log = join(a.base, 'lifecycle.log');
  await config(a.root, { local: server({ env: { PROJECT_MCP_TEST_LOG: log } }) });
  await config(b.root, { local: server({ env: { PROJECT_MCP_TEST_LOG: log } }) });
  const ctx = await nativeWorld();
  const wrapper = ctx.plugin({ apply(inner) { install(inner, mcp); } });
  await wrapper;
  const first = agentScope(ctx, a.cwd), second = agentScope(ctx, b.cwd), absent = agentScope(ctx, empty.cwd);
  try {
    await Promise.all([announce(ctx, first.agent), announce(ctx, second.agent), announce(ctx, absent.agent)]);
    const name = 'mcp__local__where';
    assert.equal(ctx.tools.get(name), undefined);
    assert.equal(ctx.tools.get(name, absent.agent), undefined);
    const one = ctx.tools.get(name, first.agent), two = ctx.tools.get(name, second.agent);
    assert.ok(one && two);
    assert.notEqual(one, two);
    const signal = new AbortController().signal;
    assert.equal((await one.execute({}, { signal })).content[0].text, a.root);
    assert.equal((await two.execute({}, { signal })).content[0].text, b.root);
    await quiesceFiber(wrapper);
    assert.equal(ctx.tools.get(name, first.agent), undefined);
    assert.equal(ctx.tools.get(name, second.agent), undefined);
    const events = (await readFile(log, 'utf8')).trim().split('\n');
    // Native SDK auto version negotiation may start/close a probe process first.
    const starts = events.filter(line => line.startsWith('start ')).map(line => line.slice(6)).sort();
    const stops = events.filter(line => line.startsWith('stop ')).map(line => line.slice(5)).sort();
    assert.ok(starts.length >= 2);
    assert.deepEqual(stops, starts, 'every native transport/probe child must exit');
  } finally {
    await Promise.all([first.scope.dispose(), second.scope.dispose(), absent.scope.dispose()]);
    await quiesceFiber(wrapper);
  }
});

test('native agent-scope disposal closes server independently of wrapper', async () => {
  const { root, cwd, base } = await fixture();
  const log = join(base, 'lifecycle.log');
  await config(root, { local: server({ env: { PROJECT_MCP_TEST_LOG: log } }) });
  const ctx = await nativeWorld();
  const wrapper = await ctx.plugin({ apply(inner) { install(inner, mcp); } });
  const { agent, scope } = agentScope(ctx, cwd);
  await announce(ctx, agent);
  await scope.dispose();
  ctx.emit(scopeTarget(agent, agent), 'agent/disposed', { agent });
  assert.equal(ctx.tools.get('mcp__local__where', agent), undefined);
  assert.match(await readFile(log, 'utf8'), /stop /);
  await quiesceFiber(wrapper);
});

test('bad second server rolls back first native connection', async () => {
  const { root, cwd, base } = await fixture();
  const log = join(base, 'lifecycle.log');
  await config(root, { local: server({ env: { PROJECT_MCP_TEST_LOG: log } }), broken: server({ command: join(base, 'does-not-exist') }) });
  const ctx = await nativeWorld();
  const wrapper = await ctx.plugin({ apply(inner) { install(inner, mcp); } });
  const { agent, scope } = agentScope(ctx, cwd);
  try {
    await assert.rejects(announce(ctx, agent), /initial connection or tool synchronization failed/);
    assert.equal(ctx.tools.get('mcp__local__where', agent), undefined);
    assert.match(await readFile(log, 'utf8'), /stop /);
  } finally { await scope.dispose(); await quiesceFiber(wrapper); }
});

test('unload during config IO never starts a native child', async () => {
  const { root, cwd } = await fixture();
  const ctx = await nativeWorld();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const wrapper = await ctx.plugin({ apply(inner) { install(inner, mcp, async () => { await gate; return serverConfigs({ mcpServers: { local: server() } }, root, mcp.Config); }); } });
  const { agent, scope } = agentScope(ctx, cwd);
  const creation = announce(ctx, agent);
  const rejection = assert.rejects(creation, /closed during initialization/);
  const closing = quiesceFiber(wrapper);
  release();
  await Promise.all([rejection, closing]);
  assert.equal(ctx.tools.get('mcp__local__where', agent), undefined);
  await scope.dispose();
});
