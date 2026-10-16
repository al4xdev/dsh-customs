import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as bridgePlugin from '../session/bridge.mjs';
import { discoverProfileHosts, prepareProfileCreate, executeProfileCreate } from './profile-client.mjs';
import { createProfileHost } from './profile-host.mjs';
import { signCreateGrant } from './profile-protocol.mjs';
import { directoryFact } from './preflight.mjs';
import { hash, DEDICATED_ROOT } from './contracts.mjs';
const anchor = '/home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh/package.json';
const require = createRequire(anchor);
const load = name => import(require.resolve(`@deepseek-ai/${name}`));

test('installed SDK: real factory, standard preset, writer ownership and empty target without model dispatch', { timeout: 30000 }, async () => {
  await mkdir('.dumps/tasks', { recursive: true });
  const home = await mkdtemp(resolve('.dumps/tasks/profile-native-'));
  const root = join(home, 'workspace'); await mkdir(root); await mkdir(join(root, 'projects'));
  const profileDir = join(home, 'profiles/dsh-tui'); await mkdir(profileDir, { recursive: true });
  const marker = join(home, 'standard-marker.mjs');
  await writeFile(marker, `export const inject=['tools']; export function apply(ctx){ctx.effect(()=>ctx.tools.register({name:'native_standard_marker',description:'Synthetic standard-only marker; never dispatched',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render:(_a,text)=>[{type:'text',text}]},execute(){throw new Error('NO TOOLS IN FIXTURE')}}));}`);
  const { Context } = await load('cordis'); const ctx = new Context(); ctx.baseUrl = pathToFileURL(anchor).href;
  let host, bridge, calls = 0, literalRequest;
  try {
    ctx.provide('profileContext', { name: 'dsh-tui', home, dir: profileDir, installAnchor: anchor, overlays: [], startedBundles: ['synthetic-native-standard'] });
    ctx.provide('shell', { sandboxMode: 'danger-full-access' });
    ctx.provide('goals', { get: () => null });
    ctx.provide('workspaceRegistry', { get: () => undefined, resolveByPath: async () => undefined });
    await ctx.plugin((await load('cordis-plugin-loader')).default, { baseUrl: pathToFileURL(anchor).href });
    for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-agent']) await ctx.plugin((await load(name)).default);
    await ctx.plugin((await load('dsh-session-persistence-jsonl')).default, { root: join(home, 'sessions'), compression: 'none' });
    await ctx.plugin((await load('dsh-tools')).ToolRuntime, { mode: 'native' });
    await ctx.plugin((await load('dsh-user-approval')).default, { policy: 'never' });
    await ctx.plugin((await load('dsh-sandbox-policy')).default, { mode: 'danger-full-access', workspaceRoot: root });
    await ctx.plugin((await load('dsh-permission-presets')).default, { defaultPreset: 'danger-full-access' });
    await ctx.plugin((await load('dsh-agent-default-model')).default, { provider: 'fixture-native', model: 'never-dispatch' });
    await ctx.plugin((await load('dsh-agent-preset-registry')).default, { default: 'standard' });
    const unregister = await ctx.agentPresets.register({ id: 'standard', name: 'Native synthetic Standard', plugins: [{ id: 'native-marker', name: pathToFileURL(marker).href }] });
    ctx.effect(() => unregister);
    const standard = await ctx.agentPresets.resolve('standard'); assert.equal(standard.broken, undefined, JSON.stringify(standard));
    await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] });
    const { LlmAdapter } = await load('dsh-llm');
    class ForbiddenModel extends LlmAdapter {
      resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] }); }
      stream(options) { calls++; literalRequest = options; throw new Error('SYNTHETIC TERMINAL MODEL ERROR; NO NETWORK'); }
    }
    ctx.effect(() => ctx.llm.registerAdapter(['fixture-native'], new ForbiddenModel()));
    assert.ok(ctx.agents); assert.ok(ctx.permissionPresets); assert.ok(ctx.agentPresets);
    const key = randomBytes(32), identity = { bridgeId: randomUUID(), pid: process.pid, startTime: 'synthetic' };
    host = createProfileHost(ctx, { root: home, key, identity, workspaceRoot: root });
    assert.equal(host.capabilities().available, true);
    const proposal = { operation_id: hash(randomUUID()), session_id: `session-${randomUUID()}`, request_id: randomUUID(), profile: 'dsh-tui', preset: 'standard', cwd: root, delivery: { mode: 'empty' }, target: { kind: 'current' }, directory: 'must_exist', create_projects_parent: false, project: null, facts: { root: await directoryFact(root), projects: await directoryFact(join(root, 'projects')), destination: await directoryFact(root) } };
    const prepared = await host.handle({ operation: 'prepare-create', proposal });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const p = prepared.preparation;
    const result = await host.handle({ operation: 'create-session', preparationId: p.id, preparationHash: p.hash, grant: signCreateGrant(p, identity, key) });
    assert.equal(result.ok, true, JSON.stringify(result));
    const agent = ctx.agents.get(proposal.session_id); assert.ok(agent);
    assert.equal(ctx.agentPresets.composedPreset(agent.ctx), 'standard');
    assert.equal(agent.session.header.agentPreset, 'standard'); assert.equal(agent.session.header.cwd, root);
    assert.ok(ctx.tools.schemas(agent).some(tool => tool.name === 'native_standard_marker'));
    assert.equal(ctx.tools.schemas(agent).some(tool => tool.name === 'session_create'), false);
    assert.equal(ctx.sandboxPolicy.resolve({ session: agent.session }).mode, 'danger-full-access');
    assert.equal(ctx.approval.effectivePolicy(agent.session), 'never');
    assert.equal(calls, 0); assert.equal(agent.status, 'idle');
    assert.equal((await ctx.sessionPersistence.stat(proposal.session_id)).header.agentPreset, 'standard');
    await assert.rejects(ctx.sessionPersistence.open(proposal.session_id, 'write'), /owned|owner/i);
    const submittedProposal = { ...proposal, operation_id: hash(randomUUID()), session_id: `session-${randomUUID()}`, request_id: randomUUID(), delivery: { mode: 'submit', text: 'Exact native literal\nwith Unicode: ação' } };
    const next = await host.handle({ operation: 'prepare-create', proposal: submittedProposal });
    assert.equal(next.ok, true, JSON.stringify(next));
    const n = next.preparation;
    const sent = await host.handle({ operation: 'create-session', preparationId: n.id, preparationHash: n.hash, grant: signCreateGrant(n, identity, key) });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.receipt.effects.submission.accepted, true);
    await ctx.agents.get(submittedProposal.session_id).whenIdle();
    assert.equal(calls, 1);
    assert.ok(literalRequest.messages.some(message => message.role === 'user' && message.content.some(part => part.type === 'text' && part.text === submittedProposal.delivery.text)));
    await host.close(); host = undefined;
    assert.equal(ctx.agents.get(proposal.session_id), undefined); assert.equal(calls, 1);
    // Production-boundary path is metadata only: JSONL/profile/key/ledger all
    // remain synthetic. No workspace tools exist beyond a throwing marker.
    // Unix sockets require a short temporary path, unlike the retained evidence.
    const bridgeRoot = await mkdtemp(join(tmpdir(), 'dsh-native-'));
    const bridgeFiber = await ctx.plugin(bridgePlugin, { root: bridgeRoot });
    bridge = { close: () => bridgeFiber.dispose() };
    const discovery = await discoverProfileHosts({ root: bridgeRoot });
    assert.equal(discovery.records.length, 1);
    const record = discovery.records[0];
    const ipcProposal = { ...proposal, operation_id: hash(randomUUID()), session_id: `session-${randomUUID()}`, request_id: randomUUID(), cwd: DEDICATED_ROOT, facts: { root: await directoryFact(DEDICATED_ROOT), projects: await directoryFact(join(DEDICATED_ROOT, 'projects'), { missing: true }), destination: await directoryFact(DEDICATED_ROOT) } };
    const ipcPrepared = await prepareProfileCreate(record, ipcProposal);
    assert.equal(ipcPrepared.ok, true, JSON.stringify(ipcPrepared));
    const ipcResult = await executeProfileCreate(record, ipcPrepared.preparation);
    assert.equal(ipcResult.ok, true, JSON.stringify(ipcResult));
    const ipcAgent = ctx.agents.get(ipcProposal.session_id);
    assert.ok(ipcAgent); assert.equal(ctx.agentPresets.composedPreset(ipcAgent.ctx), 'standard');
    assert.ok(ctx.tools.schemas(ipcAgent).some(tool => tool.name === 'native_standard_marker'));
    assert.equal(calls, 1); assert.equal(ipcAgent.status, 'idle');
    assert.equal((await ctx.sessionPersistence.stat(ipcProposal.session_id)).header.cwd, DEDICATED_ROOT);
    await bridge.close(); bridge = undefined;
    assert.equal(ctx.agents.get(ipcProposal.session_id), undefined);
  } finally { await bridge?.close(); await host?.close(); await ctx.fiber.dispose(); }
});
