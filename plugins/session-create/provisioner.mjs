import { mkdir } from 'node:fs/promises';
import { directoryFact, revalidate, liveBinding, modelOf } from './preflight.mjs';
import { hash, fail } from './contracts.mjs';

function projectView(workspace) { return { id: workspace.id, path: workspace.path, name: workspace.title, updatedAt: workspace.updatedAt }; }

/** Foreground, root-owned provisioning. Native ownership/rollback is not replaced with TUI routing. */
export async function provision(ctx, exec, authority, intent, lease, { installModelSelection, handles }) {
  const facts = structuredClone(intent.facts);
  let project = intent.project;
  let handle;
  let createdSession = false;
  const check = async () => {
    await revalidate(ctx, exec, authority, intent, facts, { createdSession, project });
    if (!createdSession) return;
    const agent = handle.agent;
    if (ctx.agents.get(intent.session_id) !== agent || agent.session.header.cwd !== intent.cwd || agent.session.header.agentPreset !== 'companion' || ctx.agentPresets.composedPreset(agent.ctx) !== 'companion') fail('session_identity_mismatch');
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session });
    const approval = ctx.approval.overrideOf(agent.session) ?? ctx.approval.config?.policy ?? 'ask';
    if (policy.mode !== 'workspace-write' || policy.workspaceRoot !== intent.cwd || approval !== 'ask' || hash(modelOf(ctx, agent)) !== hash(intent.binding.model)) fail('new_session_configuration_changed');
    if (intent.cwd !== authority.root && !authority.allows({ agent, signal: exec.signal }, policy)) fail('authority_unavailable');
  };
  const stage = (name, action) => lease.stage(name, async () => { await check(); exec.signal.throwIfAborted(); return action(); });
  try {
    if (intent.create_projects_parent) {
      await stage('projects_parent', async () => { await mkdir(facts.projects.path, { mode: 0o700 }); return { path: facts.projects.path, created: true }; });
      facts.projects = await directoryFact(facts.projects.path);
      // Parent creation deliberately changes the previously missing path fact.
      if (facts.destination.path === facts.projects.path) facts.destination = facts.projects;
    }
    if (intent.directory === 'create_child') {
      await stage('directory', async () => { await mkdir(intent.cwd, { mode: 0o700 }); return { path: intent.cwd, created: true }; });
      facts.destination = await directoryFact(intent.cwd);
    }
    if (intent.target.kind === 'new_project') {
      await stage('project', async () => {
        // Do not rename or claim a record another owner introduced after approval.
        if (await ctx.workspaceRegistry.resolveByPath(intent.cwd)) fail('project_changed');
        await check();
        exec.signal.throwIfAborted();
        const result = await ctx.workspaceController.create({ path: intent.cwd });
        const workspace = ctx.workspaceRegistry.get(result.workspace.workspaceId);
        if (!workspace || workspace.path !== intent.cwd || workspace.title !== intent.target.name) fail('project_changed');
        project = projectView(workspace);
        return { id: workspace.id, path: workspace.path, created: result.created === true, name: workspace.title };
      });
      if (lease.record.effects.project.created !== true) fail('project_changed');
    } else if (project) {
      lease.record.effects.project = { state: 'confirmed', id: project.id, path: project.path, created: false, name: project.name };
      await lease.finish('pending');
    }
    await stage('session', async () => {
      handle = await ctx.agents.create({
        sessionId: intent.session_id, signal: exec.signal,
        meta: { cwd: intent.cwd, agentPreset: 'companion' }, agentOptions: { ...intent.binding.model },
        setup(agentCtx, agent) {
          // composeFrom retains the exact public caller preset revision, not a new default revision.
          if (ctx.agentPresets.composeFrom(agentCtx, exec.agent.ctx) !== 'companion') fail('preset_changed');
          installModelSelection(agentCtx, { current: { ...intent.binding.model }, assembled: undefined });
          return { commit() {
            if (hash(liveBinding(ctx, exec, authority)) !== hash({ caller: intent.binding.caller, cwd: intent.binding.cwd, policy: intent.binding.policy, model: intent.binding.model, approval: intent.binding.approval, new_permission: intent.binding.new_permission, epoch: intent.binding.epoch })) fail('configuration_changed');
            if (intent.cwd !== authority.root) authority.register(agent, { ...intent, directory_fact: facts.destination, root_fact: facts.root, projects_fact: facts.projects });
          } };
        },
      });
      createdSession = true;
      handles.set(intent.session_id, handle);
      const agent = handle.agent;
      if (ctx.agents.get(intent.session_id) !== agent || agent.session.header.cwd !== intent.cwd || agent.session.header.agentPreset !== 'companion') fail('session_identity_mismatch');
      const policy = ctx.sandboxPolicy.resolve({ session: agent.session });
      const approval = ctx.approval.overrideOf(agent.session) ?? ctx.approval.config?.policy ?? 'ask';
      if (policy.mode !== 'workspace-write' || policy.workspaceRoot !== intent.cwd || approval !== 'ask') fail('new_session_policy_mismatch');
      if (intent.cwd !== authority.root && !authority.allows({ agent, signal: exec.signal }, policy)) fail('authority_unavailable');
      if (await ctx.sessions.flush(agent.session) !== true) fail('session_durability_unknown');
      return { id: intent.session_id, created: true, writable_scope: policy.workspaceRoot, model_binding: intent.model_binding };
    });
    if (project) {
      await stage('association', async () => {
        const workspace = ctx.workspaceRegistry.get(project.id);
        await workspace.attachSession(intent.session_id);
        project = projectView(workspace);
        return { project_id: project.id, session_id: intent.session_id };
      });
    }
    if (intent.delivery.mode === 'submit') {
      await stage('submission', async () => {
        const agent = handle.agent;
        if (ctx.agents.get(intent.session_id) !== agent || agent.session.header.cwd !== intent.cwd || agent.session.header.agentPreset !== 'companion') fail('session_identity_mismatch');
        // The scoped selection created above is fixed. No selectModel/default save path is involved.
        exec.signal.throwIfAborted();
        const receipt = await ctx.sessionController.prompt({ sessionId: intent.session_id, requestId: intent.request_id, mode: 'queue', content: [{ type: 'text', text: intent.delivery.text }] }, exec.signal);
        if (receipt?.accepted !== true) fail('submission_unknown');
        if (await ctx.sessions.flush(agent.session) !== true) fail('submission_durability_unknown');
        return { request_id: intent.request_id, accepted: true, completed: false, boundary: 'next-turn' };
      });
    }
    await check();
    await lease.finish('completed');
  } catch (error) {
    // No delete/archive/stop compensation. If published, preserve the root-owned handle.
    if (handle && intent.cwd !== authority.root) authority.revoke(handle.agent);
    const touched = Object.values(lease.record.effects).some(value => value.state !== 'not_started');
    await lease.finish(touched ? 'partial' : 'not_started', error.code ?? (exec.signal.aborted ? 'cancelled' : 'provisioning_failed')).catch(() => {});
    throw error;
  }
}
