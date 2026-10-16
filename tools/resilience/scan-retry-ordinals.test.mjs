import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveHost } from '../../plugins/common.mjs';
import { scanSessions, scanLog, zstdFrames } from './scan-retry-ordinals.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const host = id => import(resolveHost(`@deepseek-ai/${id}`));
globalThis.fetch = () => { throw new Error('Network forbidden in scanner fixture'); };

/** Real SDK loop, offline adapter: fail, failed-tool step, fail, text. With the
 * previous pair (controller5/owner6) the chain continues into step 2 with the
 * chain-wide retryId/ordinal; with the current sources it restarts per step. */
async function runScenario(pair, sessionId) {
  const [{ Context }, llm, { default: Sessions }, { default: Projections }, { default: Agents }, { default: SystemPrompt }, { default: Tools, defineTool }, { default: Loop }] =
    await Promise.all(['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop'].map(host));
  const [controllerModule, ownerModule, capability] = pair === 'previous'
    ? [await import('../../plugins/llm-resilience/lib/index-v5-unified.mjs'), await import('../../plugins/agent-self-heal/lib/index-v6-unified.mjs'), 'llmRecoveryHistory']
    : [await import('../../plugins/llm-resilience/index.mjs'), await import('../../plugins/agent-self-heal/index.mjs'), 'llmRecoveryUnbounded'];
  const ctx = new Context(), script = ['fail', 'toolErr', 'fail', 'text'];
  let calls = 0;
  const clock = { random: () => .5, setTimeout(callback) { queueMicrotask(callback); return {}; }, clearTimeout() {} };
  for (const plugin of [llm.default, Sessions, Projections, Agents, SystemPrompt, Tools]) await ctx.plugin(plugin);
  await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 });
  ctx.llm.registerAdapter(['scanner-route'], new class extends llm.LlmAdapter {
    providerRetryPolicy() { return undefined; }
    listModels() { return [{ id: 'm', name: 'offline', contextWindow: 100000, maxTokens: 1000, input: ['text'], output: ['text'] }]; }
    async *stream() {
      const step = script[calls++] ?? 'text';
      if (step === 'fail') throw new llm.LlmError('offline transport failure', 'TRANSPORT');
      if (step === 'toolErr') {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `c${calls}`, name: 'scanner_fail', arguments: '{}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SESSION_CONTENT_CANARY' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }());
  ctx.tools.register(defineTool({ name: 'scanner_fail', description: 'fails', parameters: {}, output: { schema: { type: 'string' }, render: (_a, t) => [{ type: 'text', text: t }] }, execute() { throw new Error('offline tool failure'); } }));
  await ctx.plugin({ name: 'controller', inject: controllerModule.inject, apply(c) { controllerModule.apply(c, {}, clock); } });
  await ctx.plugin({ name: 'owner', inject: ['agents', 'sessionProjections', capability], apply(c) { ownerModule.apply(c, {}); } });
  const agent = (await ctx.agents.create({ sessionId, agentOptions: { provider: 'scanner-route', model: 'm' }, meta: { cwd: repo } })).agent;
  agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'SESSION_CONTENT_CANARY task' }], source: { kind: 'user', rpcId: 'scanner-rpc' } }));
  await agent.whenIdle();
  return { ctx, agent };
}

async function writeSession({ ctx, agent }, root, compression) {
  const { default: Jsonl } = await host('dsh-session-persistence-jsonl');
  const backend = new Jsonl(ctx, { root, compression });
  const writer = await backend.create(agent.session.header);
  const events = agent.session.snapshotEvents();
  // Several appends -> several zstd frames, exercising the per-frame decoder.
  const third = Math.ceil(events.length / 3);
  for (let i = 0; i < events.length; i += third) { await writer.append(events.slice(i, i + third)); await writer.flush(); }
  await writer.close();
  return { backend, path: backend.locate(agent.session.header).path };
}

async function sdkReopens(backend, id) {
  try { const handle = await backend.open(id, 'read'); await handle.read(); await handle.close(); return 'ok'; }
  catch (error) { return String(error.cause?.message ?? error.message); }
}

async function fingerprint(root) {
  const out = {};
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name), info = await stat(path);
    out[path] = [info.mtimeMs, createHash('sha256').update(await readFile(path)).digest('hex')];
  }
  return out;
}

test('flags exactly the owner6 cross-step ordinal reuse the SDK refuses, reading zstd per frame and never printing contents', async () => {
  const scratch = join(repo, '.dumps');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const dshHome = await mkdtemp(join(scratch, 'retry-ordinal-scan-'));
  const root = join(dshHome, 'sessions');
  const written = {};
  for (const [pair, compression] of [['previous', 'zstd'], ['previous', 'none'], ['current', 'zstd'], ['current', 'none']]) {
    const run = await runScenario(pair, `scan-${pair}-${compression}`);
    // The SDK backend keeps one compression mode per root.
    try { written[`${pair}-${compression}`] = { ...(await writeSession(run, join(root, compression), compression)), id: run.agent.session.header.id }; }
    finally { await run.ctx.fiber.dispose(); }
  }
  const zstd = await readFile(written['current-zstd'].path);
  assert(zstdFrames(zstd).frames.length >= 3, 'fixture must span several zstd frames');
  // Ground truth: the SDK reader itself.
  const { ctx, backend } = await (async () => { const { Context } = await host('cordis'); const { default: Jsonl } = await host('dsh-session-persistence-jsonl'); const c = new Context(); return { ctx: c, backend: new Jsonl(c, { root: join(root, 'zstd'), compression: 'zstd' }) }; })();
  try {
    assert.match(await sdkReopens(backend, written['previous-zstd'].id), /skips its policy attempt sequence/);
    assert.equal(await sdkReopens(backend, written['current-zstd'].id), 'ok');
  } finally { await ctx.fiber.dispose(); }
  const before = await fingerprint(root);
  const report = scanSessions({ dshHome });
  assert.equal(report.scanned, 4); assert.equal(report.withRetries, 4); assert.deepEqual(report.unreadable, []);
  assert.deepEqual(report.broken.map(row => row.id).sort(), ['scan-previous-none', 'scan-previous-zstd']);
  assert(report.broken.every(row => row.rule === 'retry-skips-attempt-sequence' && Number.isSafeInteger(row.seq)));
  assert.equal(scanLog(written['current-none'].path).violation, undefined);
  assert.deepEqual(report.ownerV2.map(row => row.id).sort(), ['scan-current-none', 'scan-current-zstd'], 'only owner7 sessions are rollback-unsafe');
  assert.equal(report.contentsPrinted, false);
  assert.deepEqual(await fingerprint(root), before, 'the scanner never writes');
  const cli = await exec(process.execPath, [join(here, 'scan-retry-ordinals.mjs'), '--dsh-home', dshHome]).catch(error => error);
  assert.equal(cli.code, 1, 'broken sessions exit 1');
  assert(!cli.stdout.includes('SESSION_CONTENT_CANARY') && !cli.stdout.includes('offline transport failure'));
  assert.equal(JSON.parse(cli.stdout).broken.length, 2);
});

test('an absent sessions tree is an empty, successful scan', async () => {
  const scratch = join(repo, '.dumps');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const report = scanSessions({ dshHome: await mkdtemp(join(scratch, 'retry-ordinal-empty-')) });
  assert.equal(report.scanned, 0); assert.deepEqual(report.broken, []);
  assert.throws(() => scanSessions({ dshHome: 'relative' }), TypeError);
});
