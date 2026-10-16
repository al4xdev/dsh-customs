import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { resolveHost } from '../../plugins/common.mjs';
import { YAML, profileFiles } from './profile.mjs';

const names = ['companion-sessions', 'companion-research'];
const load = name => import(resolveHost(`@deepseek-ai/${name}`));

async function fixture() {
  // This worker mounts only native in-memory services: no persistence, credentials,
  // telemetry, transport or real adapters. A mistaken network call fails closed.
  globalThis.fetch = () => { throw new Error('Network forbidden'); };
  globalThis.WebSocket = class { constructor() { throw new Error('Network forbidden'); } };
  const home = await mkdtemp(join(tmpdir(), 'companion-skills-native-'));
  const ownedHome = await realpath(home);
  const root = join(home, 'workspace'), child = join(root, 'projects', 'nested-git');
  const [{ Context }, llm, sessions, projections, agents, prompt, tools, loop, skills, scope] = await Promise.all(
    ['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop', 'dsh-skill', 'dsh-scope'].map(load));
  const ctx = new Context();
  const calls = [];
  let standing;
  try {
    for (const cwd of [root, child]) await mkdir(join(cwd, '.git'), { recursive: true });
    const shared = join(root, '.agents', 'skills');
    for (const name of names) {
      await mkdir(join(shared, name), { recursive: true });
      await writeFile(join(shared, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic offline ${name}\n---\nFixture instructions for ${name}.\n`);
    }
    for (const plugin of [llm.default, sessions.default, projections.default, agents.default, prompt.default, tools.default, skills.default]) await ctx.plugin(plugin);
    await ctx.plugin(loop.default, { agents: [] });
    ctx.llm.registerAdapter(['companion-offline'], new class extends llm.LlmAdapter {
      listModels() { return [{ id: 'fixture', name: 'Offline', contextWindow: 10000, maxTokens: 1000, input: ['text'], output: ['text'] }]; }
      async *stream(options) {
        calls.push({ sessionId: options.sessionId, messages: options.messages });
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'offline verified' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'offline verified' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }());
    const patch = YAML.parse(profileFiles(process.cwd())['cordis.patch.yml']);
    const preset = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-companion');
    const rows = preset.config.plugins.filter(row => ['skill-filesystem', 'tool-skill'].includes(row.id));
    assert.equal(rows.length, 2);
    const key = {};
    standing = scope.createScope(ctx, key);
    // Mount the generated preset's actual plugin identities/config; substitute only
    // fixture-owned roots and disable watchers so no real user skills are inspected.
    for (const row of rows) {
      const plugin = await import(resolveHost(row.name));
      const config = row.id === 'skill-filesystem' ? { ...row.config, customSkillDirs: [shared], dshHome: home, agentsHome: home, watch: false } : row.config;
      await standing.ctx.plugin(plugin.default ?? plugin, config);
    }
    assert.equal(ctx.tools.get('skill'), undefined, 'no global tool leakage');
    for (const [index, cwd] of [root, child].entries()) {
      const { agent } = await ctx.agents.create({ sessionId: `companion-skills-${index}`, meta: { cwd, agentPreset: 'companion' }, agentOptions: { provider: 'companion-offline', model: 'fixture' } });
      assert.equal(ctx.tools.get('skill', agent), undefined, 'unrelated agent cannot see preset tool');
      scope.bindScopeParent(agent, key);
      assert.ok(ctx.tools.schemas(agent).some(row => row.name === 'skill'));
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Offline catalog check only.' }], source: { kind: 'user' } }));
      await agent.whenIdle();
      const requests = calls.filter(call => call.sessionId === agent.id);
      assert.equal(requests.length, 1, 'first model request must reach only the fake adapter');
      const catalog = requests[0].messages.find(message => message.source?.kind === 'skill-catalog');
      assert.ok(catalog, 'first request must contain the actual agent catalog');
      assert.deepEqual(catalog.source.entries.map(entry => entry.name).sort(), [...names].sort());
      agent.session.append('turn/start', { turn: 2 });
      for (const name of names) {
        const result = await ctx.tools.execute({ name: 'skill', callId: llm.ToolCallId(`${index}-${name}`), arguments: { name }, agent, signal: new AbortController().signal });
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.equal(result.value.name, name);
        assert.equal(result.value.provider, 'filesystem');
        assert.deepEqual(result.value.resourceBase, { kind: 'directory', path: join(shared, name) });
        assert.equal(result.value.content, `Fixture instructions for ${name}.`);
      }
      agent.session.append('turn/end', { reason: { kind: 'completed' } });
    }
    return { fakeRequests: calls.length, publicToolLoads: 4, rootAndNestedGit: true };
  } finally {
    await standing?.dispose();
    await ctx.fiber.dispose();
    // Only this mkdtemp-owned canonical directory is eligible for cleanup.
    assert.equal(await realpath(home), ownedHome);
    assert.ok(ownedHome.startsWith(join(tmpdir(), 'companion-skills-native-')));
    await rm(ownedHome, { recursive: true });
  }
}

if (!isMainThread) {
  try { parentPort.postMessage({ result: await fixture() }); }
  catch (error) { parentPort.postMessage({ error: error.stack }); }
} else {
  test('native scoped skill tools and first-request catalog survive a child Git boundary', { timeout: 20000 }, async () => {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url));
      let message;
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Native skill fixture timed out')); }, 15000);
      worker.on('message', value => { message = value; });
      worker.on('error', reject);
      worker.on('exit', code => { clearTimeout(timer); if (code || message?.error) reject(new Error(message?.error ?? `Worker exited ${code}`)); else resolve(message?.result); });
    });
    assert.deepEqual(result, { fakeRequests: 2, publicToolLoads: 4, rootAndNestedGit: true });
  });
}
