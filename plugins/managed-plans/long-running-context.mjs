import { ActiveGoalRuntime } from './active-runtime.mjs';
export const LONG_GOAL_THRESHOLD_MS = 5 * 60 * 60 * 1000;
export const LONG_GOAL_CONTEXT = 'managed-plans:long-running-goal';

export async function longGoalContext(runtime, agent, listPlans) {
  const before = runtime.snapshot(agent);
  if (!before || !Number.isFinite(before.elapsed) || before.elapsed < LONG_GOAL_THRESHOLD_MS) return '';
  const plans = await listPlans(agent);
  // Catalog IO can race human input, a goal pause/replacement, or disposal.
  const current = runtime.snapshot(agent);
  if (!current || current.epoch !== before.epoch || current.goalId !== before.goalId || current.generation !== before.generation
    || !Number.isFinite(current.elapsed) || current.elapsed < LONG_GOAL_THRESHOLD_MS) return '';
  const open = plans.filter(plan => plan.status !== 'closed' && plan.category !== 'closed').length;
  const minutes = Math.floor(current.elapsed / 60000);
  return `Continuous autonomous execution: ${Math.floor(minutes / 60)}h ${minutes % 60}m. Open tasks in this project (not closed): ${open}.`;
}

export function registerLongGoalContext(ctx, listPlans, { now } = {}) {
  // Only this child feature depends on goals and runtime-context capabilities;
  // their absence never disables or breaks the managed-plan tools.
  return ctx.inject(['agents', 'goals', 'systemPrompt'], scoped => {
    const prompt = scoped.get('systemPrompt');
    if (typeof prompt?.context !== 'function' || typeof prompt?.getContextOrder !== 'function') return;
    const runtime = new ActiveGoalRuntime(scoped.get('goals'), scoped.get('agents'), now);
    const safely = operation => (...args) => { try { operation(...args); } catch { /* Optional telemetry is fail-closed. */ } };
    scoped.on('session/event', safely((session, event) => runtime.event(session, event)));
    scoped.on('agent/status', safely(({ agent }) => runtime.status(agent)));
    scoped.on('goal/changed', safely(({ agent, change }) => runtime.goalChanged(agent, change.operation)));
    scoped.on('goal/activation-changed', safely(({ sessionId }) => {
      const agent = scoped.get('agents').get(sessionId);
      if (agent) runtime.goalChanged(agent);
    }));
    for (const event of ['agent/inbox/inserted', 'agent/inbox/claimed']) {
      scoped.on(event, safely(({ agent, message }) => runtime.inbox(agent, message)));
    }
    for (const event of ['agent/error', 'agent/disposed']) {
      scoped.on(event, safely(({ agent }) => runtime.dispose(agent)));
    }
    // Native service-only / nested questions may have no top-level tool/call.
    // Stay transparent even if the answerer throws, and precede short-circuiting
    // answerers. Tool audit events additionally cover timed no-provider waits.
    scoped.on('user-questions/request', async (request, next) => {
      const token = Symbol('foreground-question');
      safely(() => runtime.beginWait(request.agent, token))();
      try { return await next(); }
      finally { safely(() => runtime.endWait(request.agent, token))(); }
    }, { prepend: true });
    prompt.context({ name: LONG_GOAL_CONTEXT,
      order: prompt.getContextOrder('SANDBOX_POLICY') + 1, text: '' });
    // Context text callbacks are synchronous; catalog reads belong in assembly's
    // async waterfall. A single snapshot is replaced, never queued into the inbox.
    scoped.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
      const assembly = await next();
      if (!assembly.contexts.some(entry => entry.name === LONG_GOAL_CONTEXT)) return assembly;
      let text = '';
      try { text = await longGoalContext(runtime, agent, listPlans); }
      catch { /* Never break assembly or invent a task count on optional failures. */ }
      return { ...assembly, contexts: assembly.contexts.map(entry =>
        entry.name === LONG_GOAL_CONTEXT ? { ...entry, text } : entry) };
    });
  });
}
