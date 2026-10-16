import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveHost } from '../common.mjs';
import { DEDICATED_ROOT, hash, fail, freeze, MAX_TEXT_BYTES } from './contracts.mjs';
import { directoryFact } from './preflight.mjs';
import { OperationStore, publicResult } from './operation-store.mjs';
import { verifyCreateGrant, preparationHash } from './profile-protocol.mjs';
const { scopeOf } = await import(resolveHost('@deepseek-ai/dsh-scope'));
const { installModelSelection } = await import(resolveHost('@deepseek-ai/dsh-agent'));
const copy = value => JSON.parse(JSON.stringify(value));
const errorResult = error => ({ ok: false, error: { code: error.code ?? 'profile_create_unavailable', message: error.message }, retrySafe: false });
const view = w => w ? { id: w.id, path: w.path, name: w.title, updatedAt: w.updatedAt } : null;

/** The bridge root owns these handles, never the caller or the foreground TUI tab. */
export function createProfileHost(ctx, { root, key, identity, workspaceRoot = DEDICATED_ROOT }) {
  const preparations = new Map(), handles = new Map(), nonces = new Set(), retainedFences = new Map();
  const store = new OperationStore(join(root, 'profile-create-ledger'));
  let closed = false, chain = Promise.resolve();
  const service = name => ctx.get?.(name) ?? ctx[name];
  function available() {
    try {
      if (closed || scopeOf(ctx) || service('profileContext')?.name !== 'dsh-tui') return false;
      const methods = { agents: ['create', 'get'], sessions: ['flush'], sessionPersistence: ['stat'], agentPresets: ['resolve', 'readDocument', 'mount', 'composedPreset'], agentDefaultModel: ['currentSelection'], permissionPresets: ['resolve'], sandboxPolicy: ['resolve'], sessionProjections: ['stateOf'], workspaceRegistry: ['resolveByPath', 'get'], loader: ['entries'] };
      return Object.entries(methods).every(([name, keys]) => keys.every(method => typeof service(name)?.[method] === 'function')) && !!service('approval') && !!service('tools')?.guard && typeof ctx.on === 'function';
    } catch { return false; }
  }
  // Registry.create is create-or-reuse, not an exclusive ownership grant.
  function capabilities() { return { available: available(), profile: 'dsh-tui', preset: 'standard', version: 1, new_project: false }; }
  function only(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail('invalid_profile_proposal');
  }
  function validateProposal(p) {
    only(p, ['operation_id', 'session_id', 'request_id', 'profile', 'preset', 'cwd', 'delivery', 'model', 'target', 'directory', 'create_projects_parent', 'project', 'facts']);
    only(p.delivery, ['mode', 'text']);
    only(p.target, ['kind', 'project_id', 'name', 'path', 'directory']);
    only(p.facts, ['root', 'projects', 'destination']);
    if (p.model) only(p.model, ['provider', 'model', 'reasoningEffort']);
    if (p.project !== null) only(p.project, ['id', 'path', 'name', 'updatedAt']);
    if (p.target.kind === 'existing_project' && (!p.project || p.target.project_id !== p.project.id || p.project.path !== p.cwd)) fail('project_changed');
    if (!p || !/^[a-f0-9]{64}$/.test(p.operation_id ?? '') || !/^session-[a-f0-9-]{36}$/.test(p.session_id ?? '') || !/^[a-f0-9-]{36}$/.test(p.request_id ?? '') || p.profile !== 'dsh-tui' || p.preset !== 'standard') fail('invalid_profile_proposal');
    if (p.cwd !== workspaceRoot && !(dirname(p.cwd ?? '') === join(workspaceRoot, 'projects') && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(basename(p.cwd)))) fail('project_boundary_unavailable');
    if (!['must_exist', 'create_child'].includes(p.directory) || typeof p.create_projects_parent !== 'boolean' || !['current', 'existing_project', 'new_project'].includes(p.target?.kind)) fail('invalid_profile_proposal');
    if (p.directory === 'create_child' && p.target.kind !== 'new_project' || p.create_projects_parent && p.directory !== 'create_child') fail('invalid_profile_proposal');
    if (p.target.kind === 'new_project' && (p.cwd !== join(workspaceRoot, 'projects', p.target.name ?? '') || p.project)) fail('invalid_profile_proposal');
    if (p.delivery?.mode === 'empty') { if (Object.keys(p.delivery).some(k => k !== 'mode')) fail('invalid_delivery'); }
    else if (p.delivery?.mode !== 'submit' || typeof p.delivery.text !== 'string' || !p.delivery.text.trim() || Buffer.byteLength(p.delivery.text) > MAX_TEXT_BYTES || p.delivery.text.includes('\0')) fail('invalid_delivery');
    if (p.facts?.root?.path !== workspaceRoot || p.facts?.projects?.path !== join(workspaceRoot, 'projects') || p.facts?.destination?.path !== p.cwd) fail('invalid_path_facts');
  }
  async function binding(p) {
    if (!available()) fail('profile_host_unavailable');
    const profile = service('profileContext');
    const presets = service('agentPresets'), resolved = await presets.resolve('standard');
    if (!resolved || resolved.id !== 'standard' || resolved.broken) fail('preset_unavailable');
    const route = service('agentDefaultModel').currentSelection();
    const model = copy({ provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort });
    if (!model.provider || !model.model || p.model && hash(p.model) !== hash(model)) fail('model_unavailable');
    const permissionOwner = service('permissionPresets');
    const permission = { name: permissionOwner.defaultPreset, ...copy(permissionOwner.resolve(permissionOwner.defaultPreset)) };
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(permission.sandbox) || !['ask', 'never'].includes(permission.approval)) fail('policy_unavailable');
    const entries = [...service('loader').entries()];
    const rows = entries.map(e => ({ id: e.id, name: e.options?.name, disabled: !!e.disabled, config: e.fiber?.config ?? e.options?.config, isolate: e.options?.isolate, intercept: e.options?.intercept }));
    const modules = [];
    for (const entry of entries) {
      const name = entry.options?.name;
      if (entry.disabled || entry.options?.group || !name || name === 'cordis:include') continue;
      let modulePath;
      if (name.startsWith('file:')) modulePath = fileURLToPath(name);
      else if (isAbsolute(name)) modulePath = name;
      else for (const anchor of [profile.dir && join(profile.dir, 'package.json'), profile.installAnchor].filter(Boolean)) {
        try { modulePath = createRequire(anchor).resolve(name); break; } catch {}
      }
      if (!modulePath) fail('configuration_unproven');
      modulePath = await realpath(modulePath);
      modules.push({ path: modulePath, hash: hash(await readFile(modulePath, 'utf8')) });
    }
    return copy({ profile: 'dsh-tui', preset: 'standard', origin: profile, model, permission, policy: { mode: permission.sandbox, workspaceRoot: p.cwd, approval: permission.approval }, preset_hash: hash(await presets.readDocument('standard')), configuration_hash: hash({ rows: copy(rows), modules }) });
  }
  async function checkPaths(facts) {
    for (const fact of Object.values(facts)) if (hash(await directoryFact(fact.path, { missing: fact.state === 'missing' })) !== hash(fact)) fail('path_changed');
  }
  async function checkProject(p, project, facts = p.facts) {
    // Native resolveByPath realpaths its input and intentionally rejects missing paths.
    if (facts.destination.state === 'missing') { if (project) fail('project_changed'); return; }
    const registry = service('workspaceRegistry');
    const existing = await registry.resolveByPath(p.cwd);
    if (project ? hash(view(existing)) !== hash(project) : !!existing) fail('project_changed');
    if (project && hash(view(registry.get(project.id))) !== hash(project)) fail('project_changed');
  }
  async function prepare(proposal) {
    validateProposal(proposal);
    const p = copy(proposal);
    if (p.target.kind === 'new_project' && !capabilities().new_project) fail('new_project_unavailable');
    await checkPaths(p.facts);
    if (p.directory === 'create_child' && p.facts.destination.state !== 'missing' || p.directory === 'must_exist' && p.facts.destination.state !== 'directory') fail('path_changed');
    if (p.create_projects_parent !== (p.facts.projects.state === 'missing' && p.directory === 'create_child')) fail('path_changed');
    await checkProject(p, p.project);
    if (service('agents').get(p.session_id) || await service('sessionPersistence').stat(p.session_id)) fail('session_identity_conflict');
    const first = await binding(p);
    if (hash(first) !== hash(await binding(p))) fail('configuration_changed');
    for (const [id, value] of preparations) if (value.expiresAt <= Date.now()) preparations.delete(id);
    if (preparations.size >= 128) fail('preparation_capacity');
    const preparation = { id: randomUUID(), expiresAt: Date.now() + 120_000, proposal: p, binding: first };
    preparation.hash = preparationHash(preparation);
    preparations.set(preparation.id, freeze(preparation));
    return { ok: true, preparation };
  }
  async function create(request) {
    const prepared = preparations.get(request.preparationId);
    if (!prepared || prepared.expiresAt <= Date.now() || request.preparationHash !== prepared.hash || preparationHash(prepared) !== prepared.hash || !verifyCreateGrant(request.grant, request, identity, key)) fail('grant_invalid');
    if (nonces.has(request.grant.nonce)) fail('grant_replayed');
    if (nonces.size >= 4096) fail('dedup_capacity');
    const p = prepared.proposal, facts = copy(p.facts), expected = prepared.binding;
    let project = p.project, handle, lease, violated = false, enteringWriter = false;
    const fences = [];
    const check = async () => {
      if (hash(await binding(p)) !== hash(expected)) fail('configuration_changed');
      await checkPaths(facts); await checkProject(p, project, facts);
      if (!handle && !enteringWriter && (service('agents').get(p.session_id) || await service('sessionPersistence').stat(p.session_id))) fail('session_identity_conflict');
      if (handle) {
        const a = handle.agent, policy = service('sandboxPolicy').resolve({ session: a.session });
        const approval = service('approval').overrideOf?.(a.session) ?? service('approval').config?.policy ?? 'ask';
        if (service('agents').get(p.session_id) !== a || a.session.header.cwd !== p.cwd || a.session.header.agentPreset !== 'standard' || service('agentPresets').composedPreset(a.ctx) !== 'standard') fail('session_identity_mismatch');
        if (policy.mode !== expected.policy.mode || policy.workspaceRoot !== p.cwd || approval !== expected.policy.approval) fail('new_session_policy_mismatch');
        const selected = service('sessionProjections').stateOf(a.session, 'modelSelection')?.next ?? a.options;
        if (!selected || hash(copy({ provider: selected.provider, model: selected.model, reasoningEffort: selected.reasoningEffort })) !== hash(expected.model)) fail('new_session_model_changed');
        if (violated) fail('unapproved_startup_execution');
      }
    };
    await check();
    nonces.add(request.grant.nonce);
    preparations.delete(prepared.id);
    const intent = { ...p, caller: 'profile:dsh-tui', intent_hash: prepared.hash, authority_epoch: identity.bridgeId, binding: expected, model_binding: 'live-pinned; empty-cold-resume-unproven' };
    const prior = await store.read(p.operation_id, intent.caller);
    if (prior) {
      if (prior.request_hash !== hash(p)) fail('request_conflict');
      return { ok: prior.status === 'completed', receipt: receipt(prior, expected) };
    }
    try {
      lease = await store.begin(intent, hash(p));
      const stage = (name, fn) => lease.stage(name, async () => { await check(); return fn(); });
      await stage('session', async () => {
        enteringWriter = true;
        handle = await service('agents').create({ sessionId: p.session_id, meta: { cwd: p.cwd, agentPreset: 'standard' }, agentOptions: expected.model, setup: async (agentCtx) => {
          fences.push(agentCtx.on('agent/request', () => { violated = true; throw new Error('Unapproved startup model request'); }));
          fences.push(agentCtx.tools.guard(() => { violated = true; return 'Unapproved startup tool execution'; }));
          installModelSelection(agentCtx, { current: expected.model, assembled: undefined });
          await service('agentPresets').mount(agentCtx, 'standard');
          await check();
        } });
        handles.set(p.session_id, handle);
        await check();
        const a = handle.agent, inbox = service('sessionProjections').stateOf(a.session, 'inbox');
        const goals = a.ctx.get?.('goals') ?? service('goals');
        if (a.status !== 'idle' || !inbox || Object.values(inbox).some(v => Array.isArray(v) && v.length) || !goals?.get) fail('startup_state_unproven');
        const goal = goals.get(a);
        if (goal && goal.activation !== 'disarmed') fail('unapproved_goal');
        if (await service('sessions').flush(a.session) !== true) fail('session_durability_unknown');
        return { id: p.session_id, created: true };
      });
      if (project) await stage('association', async () => {
        const workspace = service('workspaceRegistry').get(project.id);
        await workspace.attachSession(p.session_id);
        project = view(workspace);
        return { project_id: project.id, session_id: p.session_id };
      });
      await check();
      // Empty sessions retain a startup fence until the operation is fully committed.
      if (p.delivery.mode === 'submit') await stage('submission', async () => {
        for (const dispose of fences.splice(0)) dispose();
        handle.agent.send({ id: p.request_id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: p.delivery.text }] }, 'next-turn', true);
        if (await service('sessions').flush(handle.agent.session) !== true) fail('submission_durability_unknown');
        return { request_id: p.request_id, accepted: true, completed: false, boundary: 'next-turn' };
      });
      await lease.finish('completed');
      return { ok: true, receipt: receipt(lease.record, expected) };
    } catch (error) {
      if (!lease) throw error;
      await lease.finish('partial', error.code ?? 'profile_create_failed').catch(() => {});
      return { ok: false, error: { code: error.code ?? 'profile_create_failed', message: error.message }, receipt: receipt(lease.record, expected), retrySafe: false };
    } finally {
      // A published but failed empty target must not escape startup fences.
      if (handle && lease?.record.status !== 'completed' && fences.length) retainedFences.set(p.session_id, fences);
      else for (const dispose of fences) dispose();
      await lease?.release();
    }
  }
  function receipt(record, binding) { return { ...publicResult(record), state: record.status, profile: 'dsh-tui', preset: 'standard', model: binding.model, policy: binding.policy }; }
  function handle(request) {
    const run = chain.then(async () => {
      try {
        if (!available()) fail('profile_host_unavailable');
        only(request, request.operation === 'prepare-create' ? ['operation', 'identity', 'proposal'] : ['operation', 'identity', 'preparationId', 'preparationHash', 'grant']);
        if (request.operation === 'prepare-create') return await prepare(request.proposal);
        if (request.operation === 'create-session') return await create(request);
        fail('operation_unavailable');
      } catch (error) { return errorResult(error); }
    });
    chain = run.catch(() => {});
    return run;
  }
  async function close() {
    closed = true;
    await chain;
    preparations.clear();
    await Promise.allSettled([...handles.values()].map(async handle => {
      try { await service('sessions').flush(handle.agent.session); } finally { await handle.dispose(); }
    }));
    handles.clear();
    for (const fences of retainedFences.values()) for (const dispose of fences) dispose();
    retainedFences.clear();
  }
  return { capabilities, handle, close };
}
