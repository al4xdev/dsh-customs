import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createProfileHost } from './profile-host.mjs';
import { signCreateGrant, verifyCreateGrant } from './profile-protocol.mjs';
import { directoryFact } from './preflight.mjs';
import { hash } from './contracts.mjs';

async function fixture() {
  await mkdir('.dumps/tasks', { recursive: true });
  const home = await mkdtemp(resolve('.dumps/tasks/profile-host-'));
  const root = join(home, 'workspace'); await mkdir(root); await mkdir(join(root, 'projects'));
  const key = randomBytes(32), identity = { bridgeId: randomUUID(), pid: process.pid, startTime: 'test' };
  const live = new Map(), workspaces = new Map(), mounted = new WeakMap();
  const effects = { create: 0, send: 0, dispose: 0, defaults: 0 };
  const model = { provider: 'synthetic', model: 'forbidden', reasoningEffort: 'low' };
  const ctx = {
    profileContext: { name: 'dsh-tui', dir: join(home, 'profiles/dsh-tui'), home },
    loader: { entries: () => [{ id: 'synthetic', options: { name: import.meta.url }, fiber: { config: { version: 1 } } }] },
    tools: { guard: () => () => {} }, on: () => () => {},
    agents: { get: id => live.get(id), async create(options) {
      effects.create++;
      const events = new Map();
      const agentCtx = { on(name, listener) { const list = events.get(name) ?? []; list.push(listener); events.set(name, list); return () => events.set(name, list.filter(item => item !== listener)); }, tools: { guard: () => () => {} }, get: name => name === 'goals' ? { get: () => null } : undefined };
      const agent = { id: options.sessionId, ctx: agentCtx, options: options.agentOptions, status: 'idle', session: { header: { id: options.sessionId, ...options.meta } }, send(message) { effects.send++; ctx.lastMessage = message; if (ctx.throwAfterSend) throw new Error('after-admission'); } };
      await options.setup(agentCtx, agent);
      if (ctx.startupRequest) for (const listener of events.get('agent/request') ?? []) await listener();
      live.set(agent.id, agent);
      return { agent, async dispose() { effects.dispose++; live.delete(agent.id); } };
    } },
    sessions: { flush: async () => true }, sessionPersistence: { stat: async () => null },
    sessionProjections: { stateOf: () => ({ queue: [] }) },
    agentDefaultModel: { currentSelection: () => model },
    agentPresets: { resolve: async () => ({ id: 'standard' }), readDocument: async () => ({ content: 'synthetic-standard' }), mount: async c => { mounted.set(c, 'standard'); }, composedPreset: c => mounted.get(c) },
    permissionPresets: { defaultPreset: 'full', resolve: () => ({ sandbox: 'danger-full-access', approval: 'never' }) },
    sandboxPolicy: { resolve: ({ session }) => ({ mode: 'danger-full-access', workspaceRoot: session.header.cwd }) },
    approval: { config: { policy: 'never' }, overrideOf: () => undefined },
    workspaceRegistry: { get: id => workspaces.get(id), resolveByPath: async path => [...workspaces.values()].find(w => w.path === path), async create(path, title) {
      const workspace = { id: randomUUID(), path, title, updatedAt: 1, async attachSession() { this.updatedAt++; } };
      workspaces.set(workspace.id, workspace); return workspace;
    } },
  };
  const host = createProfileHost(ctx, { root: home, workspaceRoot: root, key, identity });
  async function proposal(changes = {}) {
    return { operation_id: hash(randomUUID()), session_id: `session-${randomUUID()}`, request_id: randomUUID(), profile: 'dsh-tui', preset: 'standard', cwd: root, delivery: { mode: 'empty' }, target: { kind: 'current' }, directory: 'must_exist', create_projects_parent: false, project: null, facts: { root: await directoryFact(root), projects: await directoryFact(join(root, 'projects')), destination: await directoryFact(root) }, ...changes };
  }
  const prepare = async p => host.handle({ operation: 'prepare-create', proposal: p ?? await proposal() });
  const create = prep => host.handle({ operation: 'create-session', preparationId: prep.id, preparationHash: prep.hash, grant: signCreateGrant(prep, identity, key) });
  return { ctx, host, effects, home, root, key, identity, proposal, prepare, create, live, model };
}

test('profile create: readonly preparation, actual destination policies, empty root handle lifetime', async t => {
  const f = await fixture(); t.after(() => f.host.close());
  const result = await f.prepare(); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.preparation.binding.policy.mode, 'danger-full-access'); assert.equal(result.preparation.binding.policy.approval, 'never');
  assert.equal(f.effects.create, 0); await assert.rejects(access(join(f.home, 'profile-create-ledger')), { code: 'ENOENT' });
  const made = await f.create(result.preparation); assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.receipt.profile, 'dsh-tui'); assert.equal(made.receipt.preset, 'standard');
  assert.equal(f.effects.send, 0); assert.equal(f.effects.dispose, 0); assert.equal(f.live.size, 1);
  await f.host.close(); assert.equal(f.effects.dispose, 1);
});
test('profile host refuses Companion and header-only identity', async t => {
  const f = await fixture(); t.after(() => f.host.close());
  f.ctx.profileContext.name = 'companion'; assert.equal(f.host.capabilities().available, false);
  assert.equal((await f.prepare()).ok, false); assert.equal(f.effects.create, 0);
});
test('profile preparation is bounded and rejects unproved service owner', async t => {
  const f = await fixture(); t.after(() => f.host.close()); delete f.ctx.agentPresets.mount;
  assert.equal(f.host.capabilities().available, false); assert.equal((await f.prepare()).ok, false);
});
test('profile drift after approval has no creation or ledger effects', async t => {
  const f = await fixture(); t.after(() => f.host.close());
  const { preparation } = await f.prepare(); f.model.model = 'changed';
  assert.equal((await f.create(preparation)).error.code, 'configuration_changed'); assert.equal(f.effects.create, 0);
  await assert.rejects(access(join(f.home, 'profile-create-ledger')), { code: 'ENOENT' });
});
test('profile grants bind preparation and exact process, reject tampering and send grants', async t => {
  const f = await fixture(); t.after(() => f.host.close()); const { preparation: p } = await f.prepare();
  const request = { preparationId: p.id, preparationHash: p.hash }; const grant = signCreateGrant(p, f.identity, f.key);
  assert.equal(verifyCreateGrant(grant, request, f.identity, f.key), true);
  for (const changed of [{ operation: 'send' }, { preparationHash: 'f'.repeat(64) }, { pid: -1 }, { expiresAt: Date.now() - 1 }]) assert.equal(verifyCreateGrant({ ...grant, ...changed }, request, f.identity, f.key), false);
  const bad = await f.host.handle({ operation: 'create-session', ...request, grant: { ...grant, preparationId: randomUUID() } }); assert.equal(bad.ok, false); assert.equal(f.effects.create, 0);
});
test('explicit literal submits once, replay does not create or send twice', async t => {
  const f = await fixture(); t.after(() => f.host.close()); const { preparation } = await f.prepare(await f.proposal({ delivery: { mode: 'submit', text: 'literal\n exact' } }));
  const first = await f.create(preparation); assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(f.lastMessage, undefined); assert.equal(f.ctx.lastMessage.content[0].text, 'literal\n exact');
  assert.equal((await f.create(preparation)).ok, false); assert.equal(f.effects.create, 1); assert.equal(f.effects.send, 1);
});
test('post admission throw is unknown and retains root handle', async t => {
  const f = await fixture(); t.after(() => f.host.close()); f.ctx.throwAfterSend = true;
  const { preparation } = await f.prepare(await f.proposal({ delivery: { mode: 'submit', text: 'literal' } }));
  const result = await f.create(preparation); assert.equal(result.receipt.state, 'unknown'); assert.equal(result.receipt.effects.submission.state, 'unknown'); assert.equal(f.live.size, 1); assert.equal(f.effects.dispose, 0);
});
test('startup model request is fenced even in an empty session', async t => {
  const f = await fixture(); t.after(() => f.host.close()); f.ctx.startupRequest = true;
  const { preparation } = await f.prepare(); const result = await f.create(preparation);
  assert.equal(result.ok, false); assert.equal(result.receipt.state, 'unknown'); assert.equal(f.effects.send, 0);
});
test('new project fails closed without exclusive registry ownership seam', async t => {
  const f = await fixture(); t.after(() => f.host.close()); const cwd = join(f.root, 'projects', 'New');
  const p = await f.proposal({ cwd, target: { kind: 'new_project', name: 'New' }, directory: 'create_child' });
  p.facts.destination = await directoryFact(cwd, { missing: true });
  const result = await f.prepare(p); assert.equal(result.error.code, 'new_project_unavailable');
  assert.equal(f.host.capabilities().new_project, false); assert.equal(f.effects.create, 0);
  await assert.rejects(access(cwd), { code: 'ENOENT' });
  await assert.rejects(access(join(f.home, 'profile-create-ledger')), { code: 'ENOENT' });
});
test('existing project association retains native identity without changing foreground', async t => {
  const f = await fixture(); t.after(() => f.host.close());
  const workspace = await f.ctx.workspaceRegistry.create(f.root, 'Existing');
  const project = { id: workspace.id, path: workspace.path, name: workspace.title, updatedAt: workspace.updatedAt };
  const result = await f.prepare(await f.proposal({ target: { kind: 'existing_project', project_id: workspace.id }, project }));
  assert.equal(result.ok, true, JSON.stringify(result)); const made = await f.create(result.preparation);
  assert.equal(made.ok, true, JSON.stringify(made)); assert.equal(made.receipt.effects.association.project_id, workspace.id);
  assert.equal(f.effects.send, 0); assert.equal(f.effects.dispose, 0);
});
test('preset and permission drift invalidate an approved preparation before any effect', async t => {
  for (const mutate of [f => { f.ctx.agentPresets.readDocument = async () => ({ content: 'changed' }); }, f => { f.ctx.permissionPresets.resolve = () => ({ sandbox: 'workspace-write', approval: 'ask' }); }]) {
    const f = await fixture(); t.after(() => f.host.close()); const { preparation } = await f.prepare(); mutate(f);
    const result = await f.create(preparation); assert.equal(result.error.code, 'configuration_changed'); assert.equal(f.effects.create, 0);
  }
});
test('protocol has closed requests and does not treat model booleans as authority', async t => {
  const f = await fixture(); t.after(() => f.host.close());
  const proposal = await f.proposal(); const result = await f.host.handle({ operation: 'prepare-create', proposal, confirmed: true });
  assert.equal(result.ok, false); assert.equal(f.effects.create, 0);
  const prepared = await f.prepare();
  const noGrant = await f.host.handle({ operation: 'create-session', preparationId: prepared.preparation.id, preparationHash: prepared.preparation.hash });
  assert.equal(noGrant.error.code, 'grant_invalid'); assert.equal(f.effects.create, 0);
});
