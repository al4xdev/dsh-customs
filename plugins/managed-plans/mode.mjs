import { resolveHost } from '../common.mjs';
const { Service } = await import(resolveHost('@deepseek-ai/cordis'));
const { createUserMessage } = await import(resolveHost('@deepseek-ai/dsh-llm'));
const { planProjectionDefinition } = await import(resolveHost('@deepseek-ai/dsh-plan-mode'));
export const policy = `You are in managed plan mode. Explore and design; do not implement unapproved work. Submit Markdown using plan_stage, selecting tasks, backlog or para-o-dono from the conversation. The harness allocates ids and paths: never write, move or renumber .plan files with filesystem/shell tools. Submission ends the current turn awaiting owner review. Only an explicit owner approval of the exact revision with category tasks authorizes execution. Backlog and para-o-dono approvals save only. Saved comments, conversation agreement, mode toggles and rejected plans are not execution grants. A rejection with comments requests a staged revision of the same id; rejection without comments means wait. Use plan_read for the current artifact and feedback. plan_reopen proposes an exact-copy staged revision of the current approved/rejected/closed plan with the same id, records the reason and ends the turn; already staged is a no-op. Reopening never inherits approval or authorizes implementation. After owner feedback, use plan_stage to revise that proposal; history and sent/deleted comments are immutable. Human O only opens/stages for review and does not request automatic implementation. exit_plan_mode is a staging compatibility adapter, not an approval shortcut.`;
export class ManagedPlanMode extends Service {
  constructor(ctx) {
    super(ctx, 'planMode');
    this.pending = new WeakMap();
    // A browser/decision command is not a mode toggle. Retain native replay semantics
    // for /plan new, but never let merely opening /plan select planning mode.
    ctx.sessionProjections.register({ ...planProjectionDefinition, stateVersion: 4,
      apply(state, event) {
        if (event.type === 'command/run' && event.data.name === 'plan' && !/^new(?:\s|$)/.test((event.data.args ?? '').trim())) return state;
        return planProjectionDefinition.apply(state, event);
      } });
    ctx.systemPrompt.section({ name: 'plan:policy', order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY'),
      text: ({ agent }) => agent && this.effective(agent) ? policy : '' });
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal.aborted) return decision;
      const state = this.state(agent), selection = this.pending.get(agent.session) ?? state.wanted;
      if (selection !== null && selection !== undefined) this.commit(agent, selection);
      return decision;
    });
  }
  state(agent) {
    const value = this.ctx.sessionProjections.stateOf(agent.session, 'plan');
    if (!value) throw new Error('Managed plan mode requires the plan session projection.');
    return value;
  }
  effective(agent) { return this.pending.get(agent.session) ?? this.state(agent).wanted ?? this.state(agent).active; }
  get(agent) {
    const active = this.state(agent).active, pending = this.pending.get(agent.session) ?? this.state(agent).wanted;
    return pending === null || pending === undefined ? { active } : { active, pending };
  }
  set(agent, active) {
    if (!active) throw new Error('Only owner approval of a staged tasks revision can release managed planning.');
    const boundary = this.ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
    if (boundary?.openTurnStartSeq !== null && boundary !== undefined) { this.pending.set(agent.session, true); return 'queued'; }
    return this.commit(agent, true);
  }
  commit(agent, active) {
    this.pending.delete(agent.session);
    if (this.state(agent).active === active && this.state(agent).wanted === null) return 'noop';
    // Accepted artifact submissions and owner decisions are durable boundaries even
    // without another model step; reviews must survive a concluded turn/restart.
    agent.session.append('plan/mode', { active });
    return 'committed';
  }
  notice(text) { return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }); }
}
