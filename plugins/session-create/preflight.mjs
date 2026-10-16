import { lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { hash, freeze, fail } from './contracts.mjs';

export async function directoryFact(path, { missing = false } = {}) {
  if (!isAbsolute(path)) fail('path_unavailable');
  let stat;
  try { stat = await lstat(path); } catch (error) {
    if (missing && error.code === 'ENOENT') return { path, state: 'missing' };
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('path_unavailable', 'Directory links and non-directories are unavailable.');
  const canonical = await realpath(path);
  if (canonical !== path) fail('path_unavailable', 'The path must already be canonical without linked ancestors.');
  return { path, state: 'directory', dev: stat.dev, ino: stat.ino };
}
export function callerKey(exec) {
  const header = exec.agent?.session?.header;
  if (!header || typeof header.id !== 'string' || header.createdAt === undefined) fail('caller_unavailable');
  return hash({ id: header.id, createdAt: header.createdAt });
}
export function modelOf(ctx, agent) {
  const projected = ctx.sessionProjections.snapshot(agent.session, ['modelSelection']).values.modelSelection?.next;
  const fallback = ctx.agentDefaultModel.currentSelection();
  const source = projected ?? (agent.options?.provider && agent.options?.model ? agent.options : fallback);
  if (typeof source.provider !== 'string' || typeof source.model !== 'string') fail('model_unavailable');
  return { provider: source.provider, model: source.model, ...(source.reasoningEffort === undefined ? {} : { reasoningEffort: source.reasoningEffort }) };
}
export function liveBinding(ctx, exec, authority) {
  exec.signal.throwIfAborted();
  const agent = exec.agent;
  if (!agent || ctx.agents.get(agent.id) !== agent || agent.session.header.agentPreset !== 'companion' || ctx.agentPresets.composedPreset(agent.ctx) !== 'companion') fail('caller_unavailable');
  const policy = ctx.sandboxPolicy.resolve({ session: agent.session });
  if (policy.mode !== 'workspace-write' || !(agent.session.header.cwd === authority.root && policy.workspaceRoot === authority.root || authority.allows(exec, policy))) fail('caller_policy_unavailable');
  const permissionName = ctx.permissionPresets.defaultPreset;
  const newPermission = ctx.permissionPresets.resolve(permissionName);
  if (newPermission.sandbox !== 'workspace-write' || newPermission.approval !== 'ask') fail('new_session_policy_unavailable');
  return { caller: callerKey(exec), cwd: agent.session.header.cwd, policy, model: modelOf(ctx, agent), approval: ctx.approval?.overrideOf(agent.session) ?? ctx.approval?.config?.policy ?? 'ask', new_permission: { name: permissionName, sandbox: newPermission.sandbox, approval: newPermission.approval }, epoch: authority.epoch };
}
export async function configuration(ctx, exec, authority) {
  const before = liveBinding(ctx, exec, authority);
  const document = await ctx.agentPresets.readDocument('companion');
  exec.signal.throwIfAborted();
  const after = liveBinding(ctx, exec, authority);
  if (hash(before) !== hash(after)) fail('configuration_changed');
  return { ...after, preset_document_hash: hash(document), preset: 'companion', preset_binding: 'exact-caller-retained-revision' };
}
export async function prepare(ctx, request, exec, authority, ids) {
  if (typeof ctx.approval?.request !== 'function') fail('approval_unavailable');
  const binding = await configuration(ctx, exec, authority);
  const root = await directoryFact(authority.root);
  const projects = await directoryFact(join(authority.root, 'projects'), { missing: true });
  exec.signal.throwIfAborted();
  let cwd = binding.cwd;
  let workspace;
  let directory = 'must_exist';
  if (request.target.kind === 'existing_project') {
    workspace = ctx.workspaceRegistry.get(request.target.project_id);
    if (!workspace) fail('project_not_found');
    cwd = workspace.path;
    if (cwd !== authority.root && !authority.isProjectCwd(cwd)) fail('project_boundary_unavailable');
  } else if (request.target.kind === 'new_project') {
    cwd = join(authority.root, 'projects', request.target.name);
    if (request.target.path !== undefined && request.target.path !== cwd) fail('project_boundary_unavailable');
    directory = request.target.directory;
  }
  if (cwd !== authority.root && !authority.ready) fail('project_authority_unavailable', 'The companion guard has not joined the narrow host authority. No approval or business effect attempted.');
  const destination = cwd === authority.root ? root : await directoryFact(cwd, { missing: directory === 'create_child' });
  if (directory === 'create_child' && destination.state !== 'missing') fail('project_exists');
  if (destination.state === 'directory') {
    const existing = await ctx.workspaceRegistry.resolveByPath(cwd);
    if (workspace && existing?.id !== workspace.id) fail('project_changed');
    workspace = existing;
    if (request.target.kind === 'new_project' && workspace) fail('project_exists');
  }
  if (request.model) {
    const supplied = { provider: request.model.provider, model: request.model.model, ...(request.model.reasoning_effort === undefined ? {} : { reasoningEffort: request.model.reasoning_effort }) };
    if (hash(supplied) !== hash(binding.model)) fail('model_unavailable', 'Explicit model must match the current effective session route; this tool never changes defaults.');
  }
  // A definite persistence miss is required; faults are not evidence of freshness.
  if (ctx.agents.get(ids.session_id) || await ctx.sessionPersistence.stat(ids.session_id, { signal: exec.signal })) fail('session_identity_conflict');
  exec.signal.throwIfAborted();
  const intent = {
    version: 1, caller: binding.caller, call_id: exec.callId, ...ids,
    owner_intent: request.owner_intent, delivery: request.delivery,
    target: request.target, cwd, directory, create_projects_parent: projects.state === 'missing' && directory === 'create_child',
    project: workspace ? { id: workspace.id, path: workspace.path, name: workspace.title, updatedAt: workspace.updatedAt } : null,
    binding, facts: { root, projects, destination }, authority_epoch: authority.epoch,
    model_binding: request.delivery.mode === 'empty' ? 'live-pinned; empty-cold-resume-unproven' : 'live-pinned; durable-request-header-after-execution',
  };
  return freeze({ ...intent, intent_hash: hash(intent) });
}
export async function revalidate(ctx, exec, authority, intent, facts, { createdSession = false, project = intent.project } = {}) {
  const binding = await configuration(ctx, exec, authority);
  if (hash(binding) !== hash(intent.binding) || authority.epoch !== intent.authority_epoch || intent.cwd !== authority.root && !authority.ready) fail('configuration_changed');
  for (const fact of Object.values(facts)) {
    const now = await directoryFact(fact.path, { missing: fact.state === 'missing' });
    exec.signal.throwIfAborted();
    if (hash(now) !== hash(fact)) fail('path_changed');
  }
  if (project) {
    const now = ctx.workspaceRegistry.get(project.id);
    if (!now || now.path !== project.path || now.title !== project.name || now.updatedAt !== project.updatedAt) fail('project_changed');
  }
  if (!createdSession && (ctx.agents.get(intent.session_id) || await ctx.sessionPersistence.stat(intent.session_id, { signal: exec.signal }))) fail('session_identity_conflict');
  exec.signal.throwIfAborted();
  if (hash(await configuration(ctx, exec, authority)) !== hash(intent.binding)) fail('configuration_changed');
}
