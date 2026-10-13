const active = goal => goal?.phase === 'active' && goal.activation === 'armed' && typeof goal.id === 'string';

/** Observed execution only: never infer active time from goal age or disk history. */
export class ActiveGoalRuntime {
  constructor(goals, agents, now = () => performance.now()) {
    this.goals = goals;
    this.agents = agents;
    this.now = now;
    this.states = new WeakMap();
  }
  state(agent) {
    // Live runtime ownership matters: a resumed fork can itself be a root.
    if (!agent?.session || this.agents?.get?.(agent.id) !== agent
      || typeof this.agents.roots !== 'function' || !this.agents.roots().includes(agent)) {
      this.states.delete(agent);
      return null;
    }
    let state = this.states.get(agent);
    if (!state) {
      state = { epoch: Symbol('observed-lifecycle'), goalId: null, step: false, running: false,
        elapsed: 0, since: null, waits: new Set(), generation: 0 };
      this.states.set(agent, state);
    }
    let goal;
    try { goal = this.goals.get(agent); }
    catch { this.states.delete(agent); return null; }
    if (!active(goal) || state.goalId !== goal.id) {
      this.reset(state);
      state.goalId = active(goal) ? goal.id : null;
    }
    state.running = agent.status === 'running';
    this.reconcile(state);
    return state;
  }
  reset(state) {
    state.elapsed = 0;
    state.since = null;
    state.generation++;
  }
  reconcile(state) {
    const counting = state.goalId !== null && state.running && state.step && state.waits.size === 0;
    const now = this.now();
    if (!counting && state.since !== null) {
      state.elapsed += Math.max(0, now - state.since);
      state.since = null;
    } else if (counting && state.since === null) state.since = now;
  }
  snapshot(agent) {
    const state = this.state(agent);
    if (!state || state.goalId === null || !state.running || state.waits.size) return null;
    // Native prompt assembly precedes step/start. Show settled prior execution
    // at that boundary without charging the pre-step/idle gap as active time.
    if (!state.step && state.elapsed === 0) return null;
    return { epoch: state.epoch, goalId: state.goalId, generation: state.generation,
      elapsed: state.elapsed + (state.since === null ? 0 : Math.max(0, this.now() - state.since)) };
  }
  goalChanged(agent, operation) {
    const state = this.state(agent);
    if (!state) return;
    if (operation === 'resume') this.reset(state);
    this.reconcile(state);
  }
  status(agent) {
    const state = this.state(agent);
    if (!state) return;
    // Another listener may already have queued the next round during an idle
    // notification. Read the current agent, never trust a stale event payload.
    if (agent.status === 'idle') state.step = false;
    // Idle checkpoint gaps between automatic rounds pause accrual, not continuity.
    this.reconcile(state);
  }
  interrupt(agent) {
    const state = this.state(agent);
    if (!state) return;
    this.reset(state);
    this.reconcile(state);
  }
  beginWait(agent, token) {
    const state = this.state(agent);
    if (!state) return;
    this.reset(state);
    state.waits.add(token);
    this.reconcile(state);
  }
  endWait(agent, token) {
    const state = this.state(agent);
    if (!state) return;
    state.waits.delete(token);
    this.reconcile(state);
  }
  inbox(agent, message) {
    const kind = message?.source?.kind;
    if (kind === 'user' || kind === 'user-question-reply' || kind === 'managed-plan') this.interrupt(agent);
  }
  event(session, event) {
    const agent = this.agents.get(session.id);
    if (agent?.session !== session) return;
    const state = this.state(agent);
    if (!state) return;
    const data = event.data;
    switch (event.type) {
      case 'step/start': state.step = true; break;
      case 'step/end': state.step = false; break;
      case 'turn/end':
        state.step = false;
        if (data.reason?.kind !== 'completed') this.reset(state);
        break;
      case 'approval/asked': this.beginWait(agent, `approval:${data.id}`); break;
      case 'approval/decided': this.endWait(agent, `approval:${data.id}`); break;
      case 'tool/call':
        if (data.name === 'ask_user_question') this.beginWait(agent, `question:${data.callId}`);
        break;
      case 'tool/result':
        // A timed pending result ends foreground waiting. Independent work may
        // start a new sequence even before a late human reply arrives.
        this.endWait(agent, `question:${data.message?.toolCallId}`);
        break;
      case 'tool/ptc-dispatch':
        if (data.name === 'ask_user_question') {
          this.interrupt(agent);
          this.endWait(agent, `question:${data.subCallId}`);
        }
        break;
      case 'user/message':
        if (data.source?.kind === 'user-question-reply') this.endWait(agent, `question:${data.source.callId}`);
        // Runtime-context messages are not human interventions.
        if (data.source?.kind === 'user' || data.source?.kind === 'user-question-reply') this.interrupt(agent);
        break;
    }
    this.reconcile(state);
  }
  dispose(agent) { this.states.delete(agent); }
}
