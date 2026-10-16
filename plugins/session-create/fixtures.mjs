import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { AuthorityRegistry } from './authority.mjs';
import { OperationStore } from './operation-store.mjs';
import { createController } from './controller.mjs';

export async function fixture() {
  await mkdir('.dumps/tasks', { recursive: true });
  const home = await mkdtemp(resolve('.dumps/tasks/task83-unit-'));
  const root = join(home, 'workspace'); await mkdir(root);
  const effects = { create: 0, project: 0, attach: 0, submit: 0, model: 0, saveDefault: 0, asks: 0 };
  const agents = new Map(); const projects = new Map(); const contexts = new WeakMap();
  const ctx = {
    agents: { get: id => agents.get(id), async create(options) {
      effects.create++;
      if (agents.has(options.sessionId)) throw new Error('occupied');
      const agent = { id: options.sessionId, session: { header: Object.freeze({ id: options.sessionId, createdAt: 'synthetic-created', ...options.meta }) }, options: options.agentOptions, ctx: {} };
      const committed = await options.setup(agent.ctx, agent);
      committed?.commit(); agents.set(agent.id, agent);
      return { agent, async dispose() { agents.delete(agent.id); } };
    } },
    sessions: { async flush() { return true; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'never-dispatch', reasoningEffort: 'low' }), saveSelection() { effects.saveDefault++; throw new Error('PROHIBITED'); } },
    sessionProjections: { snapshot: () => ({ values: { modelSelection: { next: null } } }) },
    agentPresets: { composedPreset: agentCtx => contexts.get(agentCtx), readDocument: async () => ({ agentPreset: 'companion', content: 'synthetic preset' }), composeFrom(agentCtx, parent) { const preset = contexts.get(parent); contexts.set(agentCtx, preset); return preset; } },
    sandboxPolicy: { resolve: ({ session }) => ({ mode: 'workspace-write', workspaceRoot: session.header.cwd }) },
    sessionPersistence: { async stat() { return undefined; } },
    permissionPresets: { defaultPreset: 'workspace-write', resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }) },
    approval: { config: { policy: 'ask' }, overrideOf: () => undefined, async request(req) { effects.asks++; return ctx.answer(req); } },
    workspaceRegistry: { get: id => projects.get(id), async resolveByPath(path) { return [...projects.values()].find(value => value.path === path); } },
    workspaceController: { async create({ path }) {
      const existing = [...projects.values()].find(value => value.path === path);
      if (existing) return { workspace: { workspaceId: existing.id }, created: false };
      effects.project++;
      const workspace = { id: `workspace-${projects.size}`, path, title: basename(path), updatedAt: '0', sessionIds: [], async attachSession(id) { effects.attach++; this.sessionIds.push(id); this.updatedAt = String(Number(this.updatedAt) + 1); } };
      projects.set(workspace.id, workspace); return { workspace: { workspaceId: workspace.id }, created: true };
    } },
    sessionController: { async prompt(request) { effects.submit++; ctx.promptRequest = request; return { accepted: true }; } },
    answer: async () => 'allowed-once',
  };
  const caller = { id: 'own-synthetic-caller', session: { header: Object.freeze({ id: 'own-synthetic-caller', createdAt: 'fixture-origin', cwd: root, agentPreset: 'companion' }) }, options: { provider: 'fixture', model: 'never-dispatch', reasoningEffort: 'low' }, ctx: {} };
  agents.set(caller.id, caller); contexts.set(caller.ctx, 'companion');
  const authority = new AuthorityRegistry({ agents: ctx.agents, root });
  const releaseGuard = authority.public.attachGuard({ workspaceRoot: root, revision: 1 });
  const store = new OperationStore(join(home, 'private-ledger'));
  const handles = new Map();
  const controller = createController(ctx, { authority, store, handles, installModelSelection(agentCtx, ref) { agentCtx.selection = ref; } });
  let seq = 0;
  const exec = (signal = new AbortController().signal) => ({ agent: caller, callId: `fixture-${++seq}`, signal });
  const run = (request = {}, execution = exec()) => controller.execute({ operation: 'create', request: { version: 1, owner_intent: 'Pedido sintético autorado', ...request } }, execution);
  return { home, root, effects, agents, projects, ctx, caller, authority, releaseGuard, store, handles, controller, exec, run };
}
