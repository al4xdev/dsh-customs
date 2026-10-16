import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const anchor = '/home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh/package.json';
const require = createRequire(anchor);
export const load = name => import(require.resolve(`@deepseek-ai/${name}`));
export async function fixture({ installed = true, driver = false, instructions = false } = {}) {
  await mkdir('.dumps/tasks', { recursive: true });
  const root = await mkdtemp(resolve('.dumps/tasks/task99-sdk-'));
  const profileDirectory = join(root, 'profile'); await mkdir(profileDirectory);
  const cwd = join(root, 'workspace'); await mkdir(cwd);
  if (instructions) await mkdir(join(cwd, '.git'));
  const config = join(root, 'cordis.yml'); await writeFile(config, '[]\n');
  const rows = [
    ['llm', 'dsh-llm'], ['session', 'dsh-session'], ['session-projection', 'dsh-session-projection'],
    ['agent', 'dsh-agent'], ['system-prompt', 'dsh-system-prompt'],
    ['tools', 'dsh-tools', { mode: 'native' }], ['agent-loop', 'dsh-agent-loop', { agents: [], maxParallelToolCalls: 2 }],
    ['agent-preset-registry', 'dsh-agent-preset-registry', { default: 'companion' }],
    ['goal', 'dsh-goal'], ['commands', 'dsh-commands'],
    ...(driver ? [['goal-round-driver', 'dsh-goal-round-driver']] : []),
    ...(instructions ? [['fs-local', 'dsh-fs-local', { cwd }]] : []),
  ].map(([id, name, config]) => ({ id, name: require.resolve(`@deepseek-ai/${name}`), ...(config ? { config } : {}) }));
  rows.push({ id: 'preset-companion', name: require.resolve('@deepseek-ai/dsh-agent-preset'), config: {
    id: 'companion', name: 'Companion', description: 'owned isolated native SDK fixture', order: 0,
    plugins: [
      { id: 'tool-goal', name: require.resolve('@deepseek-ai/dsh-tool-goal'), config: { blockedAfterConsecutiveRounds: 3 } },
      { id: 'command-goal', name: require.resolve('@deepseek-ai/dsh-command-goal') },
      ...(instructions ? [{ id: 'agent-instructions', name: require.resolve('@deepseek-ai/dsh-agent-instructions'), config: { maxBytes: 65536, dshHome: join(root, 'empty-home') } }] : []),
      ...(installed ? [{ id: 'companion-notifications', name: resolve('plugins/companion-notifications/index.mjs'), config: { profile: 'companion' } }] : []),
    ],
  } });
  rows.push({ id: 'preset-other', name: require.resolve('@deepseek-ai/dsh-agent-preset'), config: {
    id: 'other', name: 'Other', description: 'no mock installed', order: 1, plugins: [],
  } });
  const boot = await load('dsh-app-boot');
  const app = await boot.boot('task99-isolated', config, [{ insert: rows }], ctx => {
    ctx.provide('profileContext', { name: 'companion', dir: profileDirectory });
  }, pathToFileURL(anchor).href);
  let modelCalls = 0;
  const { LlmAdapter } = await load('dsh-llm');
  class NoModel extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'] }; }
    stream() { modelCalls++; throw new Error('task99 model dispatch forbidden'); }
  }
  await app.plugin({ name: 'task99-no-model', inject: ['llm'], apply(ctx) { ctx.effect(() => ctx.llm.registerAdapter(['task99-no-model'], new NoModel())); } });
  const create = async (preset = 'companion', extra = {}) => {
    const { meta = {}, ...options } = extra;
    const handle = await app.agents.create({ sessionId: `task99-${randomUUID()}`, meta: { cwd, agentPreset: preset, ...meta },
      agentOptions: { provider: 'task99-no-model', model: 'never' }, ...options,
      setup: async ctx => { await app.agentPresets.mount(ctx, preset); },
    });
    return handle;
  };
  return { app, root, cwd, profileDirectory, create, get modelCalls() { return modelCalls; }, close: () => app.fiber.dispose() };
}
