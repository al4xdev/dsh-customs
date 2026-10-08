import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { defineTool, stringOutput, assertActive, resolveHost } from '../common.mjs';
import { PlanStore } from './store.mjs';
import { ManagedPlanMode } from './mode.mjs';
const { Service } = await import(resolveHost('@deepseek-ai/cordis'));
const { createUserMessage } = await import(resolveHost('@deepseek-ai/dsh-llm'));
const { writableRoots, sandboxDenialMarker } = await import(resolveHost('@deepseek-ai/dsh-sandbox'));
const { z } = await import(resolveHost('zod'));
export const name = 'alex-managed-plans';
export const inject = ['tools', 'systemPrompt', 'sessionProjections', 'commands', 'agents', 'sessionPersistence', 'sandboxPolicy'];
const text = (description, required = false) => ({ type: 'string', description, required });
const number = (description, required = false) => ({ type: 'integer', minimum: 1, description, required });
const categories = { type: 'string', enum: ['tasks', 'backlog', 'para-o-dono'], required: true, description: 'Proposed destination; only owner approval of tasks permits execution.' };
const json = value => JSON.stringify(value);
function heading(plan) { return /^#{1,6}\s+(.+)$/m.exec(plan)?.[1] ?? 'Proposed plan'; }
function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
function within(target, root) { const part = relative(root, target); return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)); }

export class ManagedPlans extends Service {
  constructor(ctx, { wakeAgent = true } = {}) {
    super(ctx, 'managedPlans');
    this.mode = ctx.planMode;
    this.wakeAgent = wakeAgent;
    this.bindings = new WeakMap();
    this.writers = new Map();
    this.delivering = new WeakSet();
    this.browser = null;
    // Native inbox events provide a replayable delivery receipt. Flush them before
    // acknowledging the project notice, avoiding duplicate delivery after a crash.
    ctx.sessionProjections.register({ key: 'managedPlanDelivery', stateVersion: 1,
      stateSchema: z.object({ ids: z.array(z.string()) }), init: () => ({ ids: [] }),
      apply(state, event) {
        if (event.type !== 'agent/inbox/spliced') return state;
        const ids = event.data.inserted.filter(m => m.source?.kind === 'managed-plan' && typeof m.source.notification_id === 'string').map(m => m.source.notification_id);
        return ids.length ? { ids: [...new Set([...state.ids, ...ids])] } : state;
      } });
    this.registerTools();
    ctx.commands.register({ definitionId: 'alex-managed-plans', name: 'plan', description: 'Browse managed plans, start planning, or review an exact revision',
      input: { hint: '[new <request>]', attachments: false }, handler: invocation => this.command(invocation) });
    ctx.on('agent/created', async ({ agent }) => { await this.deliver(agent); });
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.deliver(agent).catch(error => ctx.logger.warn('Managed plan notice remains pending: %s', error.message));
    });
    ctx.on('dispose', () => { for (const store of this.writers.values()) store.dispose(); this.writers.clear(); });
  }
  registerBrowserOpener(opener) {
    if (this.browser) throw new Error('Managed plan browser already registered.');
    this.browser = opener;
    return () => { if (this.browser === opener) this.browser = null; };
  }
  async binding(agent) {
    if (!agent?.session) throw new Error('Managed plans require a live agent session.');
    if (this.bindings.has(agent.session)) return this.bindings.get(agent.session);
    let ownerId = agent.session.id, header = agent.session.header;
    const visited = new Set([ownerId]);
    while (header.origin === 'subagent') {
      const parent = header.parentSession;
      if (!parent || visited.has(parent) || visited.size > 64) throw new Error('Cannot identify the root owner of this delegated plan.');
      visited.add(parent); ownerId = parent;
      const live = this.ctx.agents.get(parent);
      header = live?.session.header ?? (await this.ctx.sessionPersistence.stat(parent))?.header;
      if (!header) throw new Error('Delegated plan owner session is unavailable.');
    }
    if (!isAbsolute(header.cwd)) throw new Error('Session initial cwd must be absolute.');
    // Resolve the initial directory once, not Git/workdir overrides. Logical aliases
    // still identify the folder the owner opened; later alias retargeting cannot move it.
    const canonical = await realpath(header.cwd);
    const value = Object.freeze({ initial_cwd: header.cwd, canonical_cwd: canonical, owner_session_id: ownerId, root: join(canonical, '.plan') });
    this.bindings.set(agent.session, value);
    return value;
  }
  async permitWrite(agent, binding) {
    const policy = this.ctx.sandboxPolicy.resolve({ session: agent.session });
    if (policy.mode === 'danger-full-access') return;
    if (policy.mode !== 'workspace-write') throw new Error(`${sandboxDenialMarker(policy.mode)} Managed plan mutation needs a writable .plan directory.`);
    for (const root of writableRoots(policy)) {
      const canonical = await realpath(root).catch(() => null);
      if (canonical && within(binding.root, canonical)) return;
    }
    throw new Error(`${sandboxDenialMarker(policy.mode)} Anchored .plan is outside this session's writable roots.`);
  }
  async withStore(agent, write, operation) {
    const binding = await this.binding(agent);
    if (write) {
      await this.permitWrite(agent, binding);
      let store = this.writers.get(binding.root);
      if (!store) { store = new PlanStore(binding.canonical_cwd); await store.initialize(); this.writers.set(binding.root, store); }
      return operation(store, binding);
    }
    // Fresh read-only handles observe other processes and never bootstrap files just
    // because someone browses an empty workspace. Do not retain an empty snapshot.
    const store = new PlanStore(binding.canonical_cwd);
    try { await store.initialize({ readOnly: true }); return await operation(store, binding); }
    finally { store.dispose(); }
  }
  async stage(args, exec) {
    assertActive(exec);
    if (typeof args.plan !== 'string' || !/^#{1,6}\s+\S/.test(args.plan.trimStart())) throw new Error('Plan must start with a Markdown heading.');
    if (Buffer.byteLength(args.plan) > 256 * 1024) throw new Error('Plan exceeds the 256 KiB artifact limit.');
    const result = await this.withStore(exec.agent, true, async (store, binding) => {
      const staged = await store.stage({ title: args.title ?? heading(args.plan), plan: args.plan, category: args.category ?? 'tasks',
        ...(args.plan_id === undefined ? {} : { plan_id: args.plan_id, expected_revision: args.expected_revision }),
        origin: { session_id: binding.owner_session_id, call_id: exec.callId } });
      this.mode.commit(exec.agent, true);
      await this.ctx.sessionPersistence.flush();
      return { ...staged, initial_cwd: binding.initial_cwd, waiting_for_owner: true, execution_authorized: false,
        next_action: 'Stop this turn. The owner reviews the exact revision in /plan; do not implement or move files.' };
    });
    exec.concludeTurn();
    return json(result);
  }
  registerTools() {
    const stageParameters = { title: text('Artifact title.', true), plan: text('Complete Markdown beginning with a heading.', true), category: categories,
      plan_id: number('Existing id for a revision; omit for harness allocation.'), expected_revision: number('Required when revising an existing id.') };
    const register = (name, description, parameters, execute) => this.ctx.tools.register(defineTool({ name, description, parameters, output: stringOutput, execute }));
    register('plan_stage', 'Stage a numbered Markdown artifact for owner review. Never self-approve; submission concludes the current turn. Harness manages filenames and moves.', stageParameters, (args, exec) => this.stage(args, exec));
    register('exit_plan_mode', 'Compatibility adapter: stage a Markdown plan for owner review, not an automatic mode exit or execution grant.',
      { plan: stageParameters.plan, title: text('Optional artifact title.'), category: { ...categories, required: false }, plan_id: stageParameters.plan_id, expected_revision: stageParameters.expected_revision },
      (args, exec) => this.stage(args, exec));
    register('plan_list', 'List the plans belonging to the immutable initial session folder; does not create files.',
      { category: text('Optional tasks, backlog, para-o-dono, staging or closed.'), status: text('Optional staged, rejected, approved or closed.') },
      async (args, exec) => { assertActive(exec); return json(await this.withStore(exec.agent, false, s => s.list(args))); });
    register('plan_read', 'Read one artifact/revision and its review feedback. Source lines are 1-based; reads are bounded by default.',
      { plan_id: number('Harness-assigned plan id.', true), revision: number('Optional historical revision.'), offset: number('First source line; default 1.'), limit: number('Maximum source lines; default 2000.') },
      async (args, exec) => { assertActive(exec); return json(await this.withStore(exec.agent, false, s => s.read(args.plan_id, { revision: args.revision, offset: args.offset ?? 1, limit: args.limit ?? 2000 }))); });
    register('plan_close', 'Close an approved task/owner decision with evidence. Harness moves it to closed; no arbitrary paths or model self-cancellation.',
      { plan_id: number('Plan id.', true), expected_revision: number('Exact current revision.', true), outcome: { type: 'string', enum: ['completed', 'decided'], required: true }, reason: text('Why it is complete/decided.', true), evidence: text('Concrete completed result or recorded owner answer.', true) },
      async (args, exec) => {
        assertActive(exec);
        return json(await this.withStore(exec.agent, true, async (s, binding) => {
          const current = await s.read(args.plan_id);
          if (current.origin?.session_id !== binding.owner_session_id || !current.execution_authorized && args.outcome === 'completed') throw new Error('Only the originating owner session can close its authorized managed work.');
          return s.close({ plan_id: args.plan_id, expected_revision: args.expected_revision, outcome: args.outcome, reason: args.reason, evidence: args.evidence });
        }));
      });
  }
  async newPlan(agent, request) {
    if (typeof request !== 'string' || !request.trim()) throw new Error('Describe the new plan after /plan new.');
    if (request.length > 16384) throw new Error('Planning request is too long.');
    this.mode.set(agent, true);
    const message = createUserMessage({ content: [{ type: 'text', text: `Plan this request without implementing it. Submit using plan_stage for owner review.\n\n${request}` }], source: { kind: 'user' } });
    agent.send(message, 'next-turn', this.wakeAgent);
    await this.ctx.sessionPersistence.flush();
    return { planning: true, queued: true };
  }
  async command({ agent, rawInput, signal }) {
    signal.throwIfAborted();
    const raw = rawInput.trim();
    try {
      if (!raw) {
        if (this.browser) { this.browser(agent); return { kind: 'success' }; }
        return { kind: 'success', text: json({ ok: true, data: await this.withStore(agent, false, s => s.list()) }) };
      }
      if (/^new(?:\s|$)/.test(raw)) return { kind: 'success', text: json({ ok: true, data: await this.newPlan(agent, raw.slice(3).trim()) }) };
      if (!raw.startsWith('ui ')) throw new Error('Use /plan to browse or /plan new <request> to plan. Mode off is not approval.');
      const payload = JSON.parse(raw.slice(3));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid plan UI action.');
      // This is an authenticated human CommandRuntime boundary, not a model tool.
      // Derive session/root from the invocation; ignore any supplied actor/path flags.
      let data;
      if (payload.action === 'list') data = await this.withStore(agent, false, s => s.list({ category: payload.category, status: payload.status }));
      else if (payload.action === 'read') data = await this.withStore(agent, false, s => s.read(payload.plan_id, { revision: payload.revision }));
      else if (payload.action === 'new') data = await this.newPlan(agent, payload.request);
      else if (payload.action === 'comment') data = await this.withStore(agent, true, (s, binding) => s.saveComment({ plan_id: payload.plan_id, revision: payload.revision, hash: payload.hash,
        line_start: payload.line_start, line_end: payload.line_end, text: payload.text, comment_id: payload.comment_id, owner_session_id: binding.owner_session_id }));
      else if (payload.action === 'decide') {
        data = await this.withStore(agent, true, (s, binding) => s.decide({ plan_id: payload.plan_id, revision: payload.revision, hash: payload.hash, decision: payload.decision, owner_session_id: binding.owner_session_id }));
        const current = await this.withStore(agent, false, s => s.read(payload.plan_id));
        const recipient = current.origin?.session_id ? this.ctx.agents.get(current.origin.session_id) : undefined;
        if (recipient) await this.deliver(recipient);
        data = { ...data, notice: data.execution_authorized ? 'Approved tasks; execution instruction is queued for the origin session.' : payload.decision === 'reject' ? 'Rejected; saved comments request revision, no comments means wait.' : 'Saved only; no implementation authorized.' };
      } else if (payload.action === 'cancel') data = await this.withStore(agent, true, s => s.close({ plan_id: payload.plan_id, expected_revision: payload.expected_revision,
        outcome: 'cancelled', reason: payload.reason, owner_cancel_authorized: true }));
      else throw new Error('Unknown plan UI action.');
      await this.ctx.sessionPersistence.flush();
      return { kind: 'success', text: json({ ok: true, data }) };
    } catch (error) { return { kind: 'error', text: `${error.code ?? 'PLAN_ERROR'}: ${error.message}` }; }
  }
  async deliver(agent) {
    if (!agent?.session || this.delivering.has(agent.session) || agent.status === 'running') return;
    this.delivering.add(agent.session);
    try {
      const id = agent.session.id;
      const notices = await this.withStore(agent, false, s => s.pendingNotifications(id));
      if (!notices.length) return;
      await this.withStore(agent, true, async store => {
        // Re-read inside the writer transaction boundary; queued notices can be
        // superseded by revision/closure while their originating session is offline.
        for (const notice of await store.pendingNotifications(id)) {
          if (!notice.is_current || notice.action === 'superseded') { await store.ackNotification(notice.notification_id); continue; }
          const seen = this.ctx.sessionProjections.stateOf(agent.session, 'managedPlanDelivery')?.ids.includes(notice.notification_id);
          const wake = notice.action === 'execute' || notice.action === 'revise';
          if (!seen) {
            if (notice.action === 'execute') this.mode.commit(agent, false);
            else if (notice.action === 'revise' || notice.action === 'wait') this.mode.commit(agent, true);
            const instruction = notice.action === 'execute' ? 'Owner approved this exact tasks revision. Use plan_read to recheck it before implementing; no other revision is approved.'
              : notice.action === 'revise' ? 'Owner rejected this revision. Use its saved comments to propose a new revision with the same plan_id; remain in plan mode. Do not implement.'
              : notice.action === 'wait' ? 'Owner rejected without comments. Wait for owner instructions; do not invent a revision or implement.'
              : 'Owner approved save-only backlog/para-o-dono. No implementation is authorized.';
            const message = createUserMessage({ content: [{ type: 'text', text: `${instruction}\n${json(notice)}` }],
              source: { kind: 'managed-plan', form: 'notice', summary: `Plan ${notice.plan_id} r${notice.revision}: ${notice.action}`, notification_id: notice.notification_id } });
            agent.send(message, wake ? 'next-turn' : 'next-step', wake && this.wakeAgent);
          }
          await this.ctx.sessionPersistence.flush();
          await store.ackNotification(notice.notification_id);
          if (wake && this.wakeAgent) break; // Never flip mode for another notice while this task starts.
        }
      });
    } finally { this.delivering.delete(agent.session); }
  }
}
export function apply(ctx, config = {}) {
  if (hasOwn(config, 'wakeAgent') && typeof config.wakeAgent !== 'boolean') throw new Error('wakeAgent must be boolean.');
  new ManagedPlanMode(ctx);
  new ManagedPlans(ctx, config);
}
