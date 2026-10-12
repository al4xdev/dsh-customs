import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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
async function fixture(directory = tmpdir()) {
  await mkdir(directory, { recursive: true });
  const base = await mkdtemp(join(directory, 'dsh-project-mcp-test-'));
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
async function toolModule(root, source, filename = 'tools.mjs', directory = '.agents/tools') {
  const dir = join(root, directory);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), source);
  return dir;
}
async function assertToolError(tool, args) {
  // Both protocol rejection and an MCP error result are legitimate validation failures.
  let result;
  try { result = await tool.execute(args, { signal: new AbortController().signal }); }
  catch (error) { assert.ok(error instanceof Error); return; }
  assert.equal(result.isError, true, 'invalid values must not produce a successful tool result');
}
async function startupDiagnostic(root) {
  const [entry] = await serverConfigs({ mcpServers: { local: { builtin: true } } }, root, mcp.Config);
  const child = spawn(entry.command, entry.args, { cwd: entry.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr += text; });
  child.stdout.resume();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(timedOut, false, 'malformed modules must fail before the MCP handshake');
    assert.notEqual(code, 0, 'startup errors must terminate with failure');
    return stderr;
  } finally { clearTimeout(timer); child.stdin.destroy(); }
}

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

test('builtin config defaults, custom directory/deadline, disabled skip and invalid fields', async () => {
  const { root } = await fixture();
  const builtin = raw => serverConfigs({ mcpServers: { local: raw } }, root, mcp.Config);
  await assert.rejects(builtin({ builtin: true }), /ENOENT|toolsDir|directory/i);
  const dir = await toolModule(root, 'export const tools = [];');
  const [defaults] = await builtin({ builtin: true });
  assert.equal(defaults.transport, 'stdio');
  assert.equal(defaults.command, process.execPath);
  assert.equal(defaults.serverName, 'local');
  assert.equal(defaults.cwd, root);
  assert.equal(defaults.toolCallTimeoutMs, 30000);
  assert.equal(defaults.failOnStartupError, true);
  assert.equal(defaults.reconnect.enabled, false);
  const flag = (entry, name) => entry.args[entry.args.indexOf(name) + 1];
  assert.equal(flag(defaults, '--tools-dir'), dir);
  assert.equal(flag(defaults, '--project-root'), root);
  assert.equal(flag(defaults, '--server-name'), 'local');
  assert.equal(flag(defaults, '--tool-call-timeout-ms'), '30000');
  await mkdir(join(root, 'custom'));
  const [custom] = await builtin({ builtin: true, toolsDir: 'custom', timeoutMs: 1234 });
  assert.equal(flag(custom, '--tools-dir'), join(root, 'custom'));
  assert.equal(flag(custom, '--tool-call-timeout-ms'), '1234');
  assert.equal(custom.toolCallTimeoutMs, 1234);
  assert.deepEqual(await builtin({ builtin: true, enabled: false, toolsDir: 'missing', timeoutMs: -1, approval: 'prompt' }), []);
  for (const timeoutMs of [0, -1, 1.5, '30000']) {
    await assert.rejects(builtin({ builtin: true, timeoutMs }), /timeoutMs/);
  }
  await assert.rejects(builtin({ builtin: true, toolsDir: 7 }), /toolsDir/);
  await assert.rejects(builtin({ builtin: true, command: 'must-not-run' }), /unsupported field command/);
  await assert.rejects(builtin({ builtin: true, enabled: 'false' }), /enabled must be boolean/);
  await assert.rejects(serverConfigs({ mcpServers: { 'invalid.name': { builtin: true } } }, root, mcp.Config), /invalid native configuration/);
});

test('builtin toolsDir rejects an existing symlink outside the project and a regular file', async () => {
  const { base, root } = await fixture();
  const outside = join(base, 'outside-tools');
  await mkdir(outside);
  await writeFile(join(outside, 'external.mjs'), 'export const tools = [];');
  await symlink(outside, join(root, '.agents', 'tools'));
  await assert.rejects(serverConfigs({ mcpServers: { local: { builtin: true } } }, root, mcp.Config), /outside the project/);
  await writeFile(join(root, 'not-a-directory'), '');
  await assert.rejects(serverConfigs({ mcpServers: { local: { builtin: true, toolsDir: 'not-a-directory' } } }, root, mcp.Config), /directory|toolsDir/i);
});

test('builtin SDK tools work through native install in two scopes, validate arguments and preserve results', async () => {
  const a = await fixture(), b = await fixture();
  const source = `
    export const tools = [
      {
        name: 'inspect', description: 'Inspect arguments and handler context',
        inputSchema: { type: 'object', properties: { value: { type: 'string' }, count: { type: 'integer', minimum: 1 } }, required: ['value', 'count'], additionalProperties: false },
        handler(args, ctx) {
          if (!(ctx.signal instanceof AbortSignal)) throw new Error('missing AbortSignal');
          return { value: args.value, count: args.count, root: ctx.root, cwd: ctx.cwd, serverName: ctx.serverName, env: typeof ctx.env.PATH, aborted: ctx.signal.aborted };
        }
      },
      { name: 'text', description: 'String result', inputSchema: { type: 'object' }, handler() { return 'plain text'; } },
      {
        name: 'structured', description: 'MCP result passthrough', inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
        handler() { return { content: [{ type: 'text', text: 'formatted' }], structuredContent: { value: 'valid' } }; }
      },
      {
        name: 'invalid_output', description: 'Invalid structured output', inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        handler() { return { content: [{ type: 'text', text: 'invalid' }], structuredContent: { value: 7 } }; }
      },
      { name: 'error', description: 'Explicit MCP error', inputSchema: { type: 'object' }, handler() { return { content: [{ type: 'text', text: 'intentional error' }], isError: true }; } }
    ];
  `;
  for (const project of [a, b]) {
    // A URL fragment in the filename must not alter the imported module path.
    await toolModule(project.root, source, 'tools#fixture.mjs');
    await config(project.root, { local: { builtin: true } });
  }
  const ctx = await nativeWorld();
  const wrapper = await ctx.plugin({ apply(inner) { install(inner, mcp); } });
  const first = agentScope(ctx, a.cwd), second = agentScope(ctx, b.cwd);
  const call = (tool, args = {}) => tool.execute(args, { signal: new AbortController().signal });
  const get = (name, agent = first.agent) => ctx.tools.get(`mcp__local__${name}`, agent);
  try {
    await Promise.all([announce(ctx, first.agent), announce(ctx, second.agent)]);
    assert.equal(ctx.tools.get('mcp__local__inspect'), undefined);
    assert.ok(get('inspect') && get('inspect', second.agent));
    assert.notEqual(get('inspect'), get('inspect', second.agent));
    for (const [project, agent] of [[a, first.agent], [b, second.agent]]) {
      const result = await call(get('inspect', agent), { value: 'hello', count: 2 });
      assert.notEqual(result.isError, true);
      assert.deepEqual(JSON.parse(result.content[0].text), {
        value: 'hello', count: 2, root: project.root, cwd: project.root, serverName: 'local', env: 'string', aborted: false,
      });
    }
    assert.deepEqual((await call(get('text'))).content, [{ type: 'text', text: 'plain text' }]);
    assert.deepEqual(get('structured').output.schema.properties.structuredContent, {
      type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false,
    });
    const structured = await call(get('structured'));
    assert.deepEqual(structured.content, [{ type: 'text', text: 'formatted' }]);
    assert.deepEqual(structured.structuredContent, { value: 'valid' });
    // The native bridge deliberately turns upstream MCP isError into rejection.
    await assert.rejects(call(get('error')), /intentional error/);
    await assertToolError(get('inspect'), { value: 7, count: 2 });
    await assertToolError(get('inspect'), { value: 'hello' });
    await assertToolError(get('inspect'), { value: 'hello', count: 0 });
    await assertToolError(get('invalid_output'), {});
    await first.scope.dispose();
    assert.equal(get('inspect'), undefined);
    assert.equal((await call(get('text', second.agent))).content[0].text, 'plain text');
    await quiesceFiber(wrapper);
    assert.equal(get('inspect', second.agent), undefined);
  } finally {
    await Promise.all([first.scope.dispose(), second.scope.dispose()]);
    await quiesceFiber(wrapper);
  }
});

test('builtin startup fails fast with diagnostics for malformed modules, schemas and duplicates', async t => {
  const tool = "{ name: 'valid', description: 'Valid tool', inputSchema: { type: 'object' }, handler() { return 'ok'; } }";
  const cases = [
    ['broken module', "throw new Error('fixture module exploded');", /broken\.mjs|fixture module exploded/i],
    ['syntax error', 'export const tools = [;', /broken\.mjs|syntax|unexpected/i],
    ['missing export', 'export const other = [];', /tools|export/i],
    ['non-array export', 'export const tools = {};', /tools|array/i],
    ['null schema', "export const tools = [{ name: 'bad', description: 'Bad', inputSchema: null, handler() {} }];", /inputSchema|schema/i],
    ['non-object schema', "export const tools = [{ name: 'bad', description: 'Bad', inputSchema: { type: 'string' }, handler() {} }];", /inputSchema|schema|object/i],
    ['invalid schema keyword', "export const tools = [{ name: 'bad', description: 'Bad', inputSchema: { type: 'object', properties: { x: { type: 'not-a-json-schema-type' } } }, handler() {} }];", /schema|type/i],
    ['invalid output schema', "export const tools = [{ name: 'bad', description: 'Bad', inputSchema: { type: 'object' }, outputSchema: { type: 'array' }, handler() {} }];", /outputSchema|schema|object/i],
    ['duplicate name', `export const tools = [${tool}, ${tool}];`, /duplicate|valid/i],
  ];
  for (const [name, source, diagnostic] of cases) {
    await t.test(name, async () => {
      const { root } = await fixture();
      await toolModule(root, source, 'broken.mjs');
      assert.match(await startupDiagnostic(root), diagnostic);
    });
  }
  await t.test('duplicate names across modules', async () => {
    const { root } = await fixture();
    await toolModule(root, `export const tools = [${tool}];`, 'first.mjs');
    await toolModule(root, `export const tools = [${tool}];`, 'second.mjs');
    assert.match(await startupDiagnostic(root), /duplicate|valid/i);
  });
  await t.test('broken module symlink', async () => {
    const { root } = await fixture();
    const dir = await toolModule(root, 'export const tools = [];');
    await symlink(join(root, 'missing.mjs'), join(dir, 'broken-link.mjs'));
    assert.match(await startupDiagnostic(root), /broken-link|missing|ENOENT/i);
  });
  await t.test('existing module symlink escaping project', async () => {
    const { base, root } = await fixture();
    const dir = await toolModule(root, 'export const tools = [];');
    const outside = join(base, 'external.mjs');
    await writeFile(outside, `export const tools = [${tool}];`);
    await symlink(outside, join(dir, 'escape.mjs'));
    assert.match(await startupDiagnostic(root), /outside|escape/i);
  });
});

test('builtin empty tools directory initializes successfully through the native client', async () => {
  const { root, cwd } = await fixture();
  await mkdir(join(root, '.agents', 'tools'));
  await config(root, { local: { builtin: true } });
  const ctx = await nativeWorld();
  const wrapper = await ctx.plugin({ apply(inner) { install(inner, mcp); } });
  const { agent, scope } = agentScope(ctx, cwd);
  try {
    await announce(ctx, agent);
    assert.equal(ctx.tools.get('mcp__local__where', agent), undefined);
  } finally { await scope.dispose(); await quiesceFiber(wrapper); }
});

test('builtin deadline aborts cooperative handlers without delayed side effects', async () => {
  const { root, cwd } = await fixture();
  await toolModule(root, `
    import { setTimeout } from 'node:timers/promises';
    let completed = false, aborted = false;
    export const tools = [
      {
        name: 'wait', description: 'Cooperative cancellation', inputSchema: { type: 'object' },
        async handler(args, ctx) {
          try { await setTimeout(500, undefined, { signal: ctx.signal }); completed = true; return 'unexpected completion'; }
          catch (error) { aborted = ctx.signal.aborted; throw error; }
        }
      },
      { name: 'state', description: 'Check handler state', inputSchema: { type: 'object' }, handler() { return { completed, aborted }; } }
    ];
  `);
  await config(root, { local: { builtin: true, timeoutMs: 100 } });
  const ctx = await nativeWorld();
  const wrapper = await ctx.plugin({ apply(inner) { install(inner, mcp); } });
  const { agent, scope } = agentScope(ctx, cwd);
  try {
    await announce(ctx, agent);
    await assertToolError(ctx.tools.get('mcp__local__wait', agent), {});
    // Outlive the original work: cancellation must stop it, not merely race its response.
    await new Promise(resolve => setTimeout(resolve, 650));
    const state = await ctx.tools.get('mcp__local__state', agent).execute({}, { signal: new AbortController().signal });
    assert.deepEqual(JSON.parse(state.content[0].text), { completed: false, aborted: true });
  } finally { await scope.dispose(); await quiesceFiber(wrapper); }
});

test('builtin explicit client cancellation reaches a running handler and keeps the connection usable', { timeout: 15000 }, async () => {
  const { root, cwd } = await fixture(fileURLToPath(new URL('../../.dumps/', import.meta.url)));
  await toolModule(root, `
    import { setTimeout } from 'node:timers/promises';
    let started = false, completed = false, aborted = false;
    export const tools = [
      {
        name: 'wait', description: 'Explicit client cancellation', inputSchema: { type: 'object' },
        async handler(args, ctx) {
          started = true;
          try { await setTimeout(1000, undefined, { signal: ctx.signal }); completed = true; return 'unexpected completion'; }
          catch (error) { aborted = ctx.signal.aborted; throw error; }
        }
      },
      { name: 'state', description: 'Check cancellation state', inputSchema: { type: 'object' }, handler() { return { started, completed, aborted }; } }
    ];
  `);
  // A long deadline distinguishes request cancellation from the existing timer test.
  await config(root, { local: { builtin: true, timeoutMs: 30000 } });
  const ctx = await nativeWorld();
  const wrapper = await ctx.plugin({ apply(inner) { install(inner, mcp); } });
  const { agent, scope } = agentScope(ctx, cwd);
  const controller = new AbortController();
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let rejection;
  try {
    await announce(ctx, agent);
    const stateTool = ctx.tools.get('mcp__local__state', agent);
    const state = async () => JSON.parse((await stateTool.execute({}, { signal: new AbortController().signal })).content[0].text);
    const waiting = ctx.tools.get('mcp__local__wait', agent).execute({}, { signal: controller.signal });
    rejection = assert.rejects(waiting, 'explicit cancellation must reject the client call');
    // Confirm the request is in flight, not merely cancelled before transmission.
    const until = Date.now() + 3000;
    let observed = await state();
    while (!observed.started && Date.now() < until) { await pause(10); observed = await state(); }
    assert.deepEqual(observed, { started: true, completed: false, aborted: false });
    controller.abort(new Error('Fixture client cancellation'));
    await rejection;
    // Outlive the handler's original work without waiting for its 30-second deadline.
    await pause(1100);
    assert.deepEqual(await state(), { started: true, completed: false, aborted: true });
  } finally {
    controller.abort();
    if (rejection) await rejection.catch(() => {});
    await scope.dispose();
    await quiesceFiber(wrapper);
  }
});

test('builtin module and schema startup errors reject native agent initialization', async t => {
  for (const source of [
    "throw new Error('native startup fixture failure');",
    "export const tools = [{ name: 'bad', description: 'Bad', inputSchema: { type: 'string' }, handler() {} }];",
  ]) {
    await t.test(source.startsWith('throw') ? 'module' : 'schema', async () => {
      const { root, cwd } = await fixture();
      await toolModule(root, source);
      await config(root, { local: { builtin: true } });
      const ctx = await nativeWorld();
      const wrapper = await ctx.plugin({ apply(inner) { install(inner, mcp); } });
      const { agent, scope } = agentScope(ctx, cwd);
      try {
        await assert.rejects(announce(ctx, agent), /initial connection or tool synchronization failed|startup|closed|connect/i);
        assert.equal(ctx.tools.get('mcp__local__bad', agent), undefined);
      } finally { await scope.dispose(); await quiesceFiber(wrapper); }
    });
  }
});
