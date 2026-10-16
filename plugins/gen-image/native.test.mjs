import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { resolveHost } from '../common.mjs';

const host = id => import(resolveHost(`@deepseek-ai/${id}`));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMQqTjxH4QZYAwATZwJTT1ZqfsAAAAASUVORK5CYII=';
const names = ['gen_image', 'gen_image_list', 'gen_image_tail'];

async function until(read, accept, label) {
  const deadline = performance.now() + 10000;
  do {
    const value = await read();
    if (accept(value)) return value;
    // Yield actual I/O turns; never assume an arbitrary sleep makes the child ready.
    await yieldTurn();
  } while (performance.now() < deadline);
  throw new Error(`Native fixture deadline: ${label}`);
}

async function fixture(t, { resultError = false, omitResult = false, invalidImage = false, missingImage = false, symlinkImage = false, softDeny = false, oversizedResult = false, policyMode = 'danger-full-access' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-gen-image-native-test-'));
  const socketPath = path.join(root, 'release.sock');
  const sockets = new Set(), launches = [], privateRoots = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let pending = '';
    socket.on('data', chunk => {
      pending += chunk;
      const end = pending.indexOf('\n');
      if (end >= 0 && !socket.recorded) {
        socket.recorded = true;
        launches.push({ ...JSON.parse(pending.slice(0, end)), socket });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const executable = path.join(root, 'fake-agy.mjs');
  await writeFile(executable, `#!${process.execPath}
import net from 'node:net';
import fs from 'node:fs';
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf('--print') + 1] ?? '';
console.log(JSON.stringify({event:'init',conversation_id:'fixture-official-session',model:'gemini-3.8-flash-low'}));
console.error('fixture stderr diagnostic');
const gate = net.createConnection(${JSON.stringify(socketPath)}, () => gate.write(JSON.stringify({argv,cwd:process.cwd(),prompt})+'\\n'));
gate.once('data', () => {
  const imagePath = process.cwd() + '/output.png';
  ${missingImage ? '' : symlinkImage ? `fs.writeFileSync(${JSON.stringify(path.join(root, 'outside.png'))}, Buffer.from('${PNG}', 'base64')); fs.symlinkSync(${JSON.stringify(path.join(root, 'outside.png'))}, imagePath);` : `fs.writeFileSync(imagePath, ${invalidImage ? "Buffer.from('not a png')" : `Buffer.from('${PNG}', 'base64')`});`}
  ${softDeny ? `console.log(JSON.stringify({event:'error',error:{code:'PERMISSION_DENIED',message:'fixture soft deny'}}));` : ''}
  ${omitResult ? '' : `console.log(JSON.stringify({event:'result',result:{status:${JSON.stringify(resultError ? 'ERROR' : 'SUCCESS')},conversation_id:'fixture-official-session',message:${oversizedResult ? "'x'.repeat(300000)" : JSON.stringify(resultError ? 'fixture result error' : 'Created requested image')}}}));`}
  gate.end();
});
gate.on('error', error => { console.error(error.message); process.exitCode = 1; });
`);
  await chmod(executable, 0o700);
  const { Context } = await host('cordis');
  const ctx = new Context();
  let manager;
  t.after(async () => {
    await manager?.dispose();
    await ctx.fiber.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    // The only removed tree is this test's freshly allocated scratch directory.
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith('dsh-gen-image-native-test-'));
    await rm(root, { recursive: true, force: true });
    for (const privateRoot of privateRoots) {
      assert.equal(path.dirname(privateRoot), '/tmp');
      assert.ok(path.basename(privateRoot).startsWith('dsh-gen-image-'));
      await rm(privateRoot, { recursive: true, force: true });
    }
  });
  for (const id of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-subprocess-local']) {
    await ctx.plugin((await host(id)).default);
  }
  await ctx.plugin((await host('dsh-agent-loop')).default, { agents: [] });
  await ctx.plugin((await host('dsh-attachment-local')).default, { dshHome: path.join(root, 'home') });
  await ctx.plugin((await host('dsh-sandbox-policy')).default, { mode: policyMode, workspaceRoot: root });
  const plugin = await import('./index.mjs');
  manager = plugin.install(ctx, { executable });
  assert.equal(plugin.apply, plugin.install);
  const handle = await ctx.agents.create({ sessionId: `image-native-${path.basename(root)}`, meta: { cwd: root } });
  const { agent } = handle;
  const { agent: other } = await ctx.agents.create({ sessionId: `image-other-${path.basename(root)}`, meta: { cwd: root } });
  let call = 0;
  const execute = (name, args, owner = agent, signal = new AbortController().signal) => ctx.tools.execute({ name, arguments: args, agent: owner, signal, callId: `fixture-${++call}` });
  const success = async (name, args, owner, signal) => {
    const result = await execute(name, args, owner, signal);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.ok(Object.isFrozen(result));
    if (name === 'gen_image') privateRoots.add(jobOf(result.value).tmp_root);
    return result.value;
  };
  return { ctx, manager, root, executable, launches, agent, handle, other, execute, success };
}

function jobOf(value) { return value.job ?? value; }
function terminal(job) { return ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.state); }

// These are integration tests: neither registry validation, subprocess ownership,
// nor image admission is replaced with a hand-written mock service.
test('native gen-image registry launches headless argv and tracks an isolated background image job', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(f.ctx.tools.schemas().map(tool => tool.name).sort(), [...names].sort());
  const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent, signal: new AbortController().signal });
  assert.deepEqual(assembly.tools.map(tool => tool.name).sort(), [...names].sort());
  for (const tool of assembly.tools) {
    assert.equal(tool.parameters.type, 'object', tool.name);
    assert.equal(tool.parameters.additionalProperties, false, tool.name);
    assert.ok(tool.parameters.properties, tool.name);
    for (const property of Object.values(tool.parameters.properties)) {
      assert.equal(Object.hasOwn(property, 'required'), false, tool.name);
    }
  }
  assert.deepEqual(assembly.tools.find(tool => tool.name === 'gen_image').parameters.required, ['tmp_path', 'description']);
  assert.deepEqual(assembly.tools.find(tool => tool.name === 'gen_image_tail').parameters.required, ['id']);
  const description = 'Fixture image; literal $(touch SHOULD_NOT_EXIST) and "quoted" text';
  const launchController = new AbortController();
  const started = jobOf(await f.success('gen_image', { tmp_path: 'output.png', description }, f.agent, launchController.signal));
  launchController.abort();
  assert.equal(typeof started.id, 'string');
  assert.equal(terminal(started), false, 'launch must return while gated fake CLI is still running');
  const launch = await until(() => f.launches[0], Boolean, 'fake CLI connects');
  assert.equal(launch.cwd, started.tmp_root);
  assert.equal(started.session_id, f.agent.session.id);
  assert.equal(started.output_path, path.join(started.tmp_root, 'output.png'));
  assert.equal(launch.argv[launch.argv.indexOf('--model') + 1], 'gemini-3.8-flash-low');
  assert.equal(launch.argv[launch.argv.indexOf('--output-format') + 1], 'stream-json');
  assert.deepEqual(launch.argv, ['--print', launch.prompt, '--model', 'gemini-3.8-flash-low', '--output-format', 'stream-json', '--print-timeout', '600s', '--sandbox', '--disable-slash-commands']);
  assert.ok(!launch.argv.some(arg => /yolo|dangerously-skip-permissions/.test(arg)));
  assert.ok(launch.prompt.includes(JSON.stringify(description)), 'description remains JSON data in a literal argv value');
  const listed = await f.success('gen_image_list', { id: started.id });
  assert.equal(listed.jobs.length, 1);
  assert.equal(listed.jobs[0].id, started.id);
  assert.equal(terminal(listed.jobs[0]), false);
  for (const lines of [0, 201, 1.5]) {
    const invalid = await f.execute('gen_image_tail', { id: started.id, lines });
    assert.equal(invalid.isError, true);
    assert.match(invalid.error.message, /lines|integer|200/);
  }
  assert.deepEqual((await f.success('gen_image_list', {}, f.other)).jobs, []);
  assert.equal((await f.execute('gen_image_tail', { id: started.id }, f.other)).isError, true);
  const activeTail = await until(() => f.success('gen_image_tail', { id: started.id }), value => JSON.stringify(value.lines).includes('fixture stderr diagnostic') && JSON.stringify(value.lines).includes('fixture-official-session'), 'stdout and stderr tail capture');
  assert.equal(typeof activeTail.truncated, 'boolean');
  launch.socket.write('release\n');
  const done = await until(() => f.success('gen_image_list', { id: started.id }), value => terminal(value.jobs[0]), 'job completion');
  assert.equal(done.jobs[0].state, 'succeeded');
  const tail = await f.success('gen_image_tail', { id: started.id, lines: 1 });
  assert.equal(tail.lines.length, 1);
  assert.equal(tail.truncated, true);
  assert.ok((await stat(started.output_path)).size > 0);
  assert.deepEqual(await readFile(started.output_path), Buffer.from(PNG, 'base64'));
  await f.manager.dispose();
  assert.ok((await stat(started.output_path)).size > 0, 'dispose must not delete images');
});

test('native registry enforces tool arguments, cancellation, and canonical output validation', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const [name, args] of [['gen_image', { description: 'missing path' }], ['gen_image_tail', {}], ['gen_image_tail', { id: 'unknown', lines: 0 }], ['gen_image_tail', { id: 'unknown', lines: 201 }]]) {
    assert.equal((await f.execute(name, args)).isError, true);
  }
  const controller = new AbortController(); controller.abort();
  const cancelled = await f.execute('gen_image', { tmp_path: path.join(f.root, 'cancelled.png'), description: 'never launch' }, f.agent, controller.signal);
  assert.equal(cancelled.isError, true);
  assert.equal(cancelled.error.info.code, 'ABORTED_BEFORE_DISPATCH');
  assert.equal(f.launches.length, 0);
  const agentless = await f.ctx.tools.execute({ name: 'gen_image', arguments: { tmp_path: 'output.png', description: 'agentless' }, signal: new AbortController().signal, callId: 'agentless' });
  assert.equal(agentless.isError, true);
  assert.match(agentless.error.message, /Agent session/);
  const original = f.manager.list;
  f.manager.list = async () => undefined;
  try {
    const invalid = await f.execute('gen_image_list', {});
    assert.equal(invalid.isError, true, 'non-JSON runtime result must be rejected by the real registry');
    assert.ok(invalid.error);
  } finally { f.manager.list = original; }
});

for (const settings of [{ resultError: true, expectedCode: 'CLI_FAILED' }, { omitResult: true, expectedCode: 'CLI_NO_SUCCESS' }, { invalidImage: true, expectedCode: 'IMAGE_INVALID' }, { missingImage: true, expectedCode: 'IMAGE_MISSING' }, { symlinkImage: true, expectedCode: 'IMAGE_PATH_DENIED' }, { softDeny: true, expectedCode: 'PERMISSION_DENIED' }, { oversizedResult: true, expectedCode: 'CLI_NO_SUCCESS' }]) {
  test(`native job fails closed for ${JSON.stringify(settings)}`, { timeout: 20000 }, async t => {
    const f = await fixture(t, settings);
    const job = jobOf(await f.success('gen_image', { tmp_path: 'output.png', description: 'offline failure fixture' }));
    const launch = await until(() => f.launches[0], Boolean, 'fake CLI connects');
    launch.socket.write('release\n');
    const done = await until(() => f.success('gen_image_list', { id: job.id }), value => terminal(value.jobs[0]), 'failure completion');
    assert.equal(done.jobs[0].state, 'failed');
    assert.equal(done.jobs[0].error?.code, settings.expectedCode);
  });
}

test('native sandbox policy denies launching outside danger-full-access', { timeout: 20000 }, async t => {
  const f = await fixture(t, { policyMode: 'workspace-write' });
  const denied = await f.execute('gen_image', { tmp_path: 'output.png', description: 'must not launch' });
  assert.equal(denied.isError, true);
  assert.match(denied.error.message, /danger-full-access/);
  assert.equal(f.launches.length, 0);
  assert.deepEqual((await f.success('gen_image_list', {})).jobs, []);
});

test('native agent disposal quiesces an active CLI job but keeps its diagnostic metadata', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const job = jobOf(await f.success('gen_image', { tmp_path: 'output.png', description: 'wait for disposal' }));
  await until(() => f.launches[0], Boolean, 'fake CLI connects');
  await f.handle.dispose();
  // agent/disposed is an emit event; its async job observer completes independently.
  const listed = await until(() => f.success('gen_image_list', { id: job.id }), value => terminal(value.jobs[0]), 'agent disposal observer');
  assert.equal(listed.jobs[0].state, 'cancelled');
  assert.ok(listed.jobs[0].finished_at);
  assert.notEqual(listed.jobs[0].signal, null);
});
