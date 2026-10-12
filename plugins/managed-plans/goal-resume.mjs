const result = (status, message) => ({ status, message });
const stopped = phase => phase === 'paused' || phase === 'blocked';
const positive = value => Number.isSafeInteger(value) && value > 0;

function isRootLive(ctx, agent) {
  if (!agent?.session || typeof agent.id !== 'string' || agent.session.id !== agent.id) return false;
  if (ctx.agents?.get?.(agent.id) !== agent || agent.session.header?.origin === 'subagent') return false;
  return typeof ctx.agents.roots !== 'function' || ctx.agents.roots().includes(agent);
}
function service(ctx) {
  const goals = typeof ctx.get === 'function' ? ctx.get('goals') : undefined;
  return goals && typeof goals.get === 'function' && typeof goals.resume === 'function' ? goals : null;
}
function validGoal(goal) {
  return typeof goal.id === 'string' && goal.id.length > 0 && positive(goal.revision)
    && positive(goal.maxGoalRounds) && Number.isSafeInteger(goal.roundsStarted) && goal.roundsStarted >= 0;
}

/**
 * Capture the CURRENT approving session's stopped goal, never a plan's origin.
 * The caller MUST be an authenticated real root human command approving tasks.
 * These helpers do not create authority: never call them from model tools,
 * autonomous approval, notification delivery, or lifecycle/background hooks.
 * Capture before plan approval; commit approval, notice, and durability before
 * resuming. A missing goal capability must not invalidate the plan decision.
 */
function capture(ctx, agent) {
  try {
    if (!isRootLive(ctx, agent)) return result('skipped', 'Goal resume skipped: the approving session is not a live root session.');
    const goals = service(ctx);
    if (!goals) return result('unavailable', 'Goal resume unavailable: no native goal service is composed.');
    const goal = goals.get(agent);
    if (!goal || !stopped(goal.phase)) return result('not-needed', 'No paused or blocked session goal needs resuming.');
    if (!validGoal(goal)) return result('failed', 'Goal resume failed: the native goal snapshot is invalid.');
    if (goal.roundsStarted >= goal.maxGoalRounds) return result('skipped', 'Goal resume skipped: the goal round budget is exhausted.');
    return Object.freeze({ status: 'ready', session_id: agent.session.id,
      goal: Object.freeze({ id: goal.id, revision: goal.revision, phase: goal.phase }),
      roundsStarted: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds });
  } catch {
    // Exception text can include private session data; approval gets a safe status.
    return result('failed', 'Goal resume failed: the current session goal could not be read.');
  }
}

export function captureApprovalGoal(ctx, agent) {
  const captured = capture(ctx, agent);
  if (captured.status !== 'ready') return { candidate: null, result: captured };
  return { candidate: Object.freeze({ session_id: captured.session_id, ...captured.goal,
    roundsStarted: captured.roundsStarted, maxGoalRounds: captured.maxGoalRounds }), result: null };
}

/**
 * Synchronous CAS handoff after the human approval's notice is durable.
 * No await, recapture, or retry may cross the final check and native resume.
 * A goal edit while blocked changes revision and needs new human consent.
 */
export function resumeApprovalGoal(ctx, agent, candidate) {
  try {
    if (!candidate) return result('not-needed', 'No captured session goal needs resuming.');
    if (!isRootLive(ctx, agent) || agent.session.id !== candidate.session_id) return result('skipped', 'Goal resume skipped: the approving session changed or is no longer a live root.');
    const expected = candidate;
    if (!expected || !stopped(expected.phase) || !validGoal({ ...expected, roundsStarted: candidate.roundsStarted, maxGoalRounds: candidate.maxGoalRounds })) {
      return result('skipped', 'Goal resume skipped: the captured goal is not a valid stopped goal.');
    }
    const goals = service(ctx);
    if (!goals) return result('unavailable', 'Goal resume unavailable: no native goal service is composed.');
    const current = goals.get(agent);
    if (!current || current.id !== expected.id || current.revision !== expected.revision || current.phase !== expected.phase
      || current.roundsStarted !== candidate.roundsStarted || current.maxGoalRounds !== candidate.maxGoalRounds) {
      return result('skipped', 'Goal resume skipped: the session goal changed after approval consent.');
    }
    if (!validGoal(current) || current.roundsStarted >= current.maxGoalRounds) return result('skipped', 'Goal resume skipped: the goal round budget is unavailable or exhausted.');
    goals.resume(agent, { id: current.id, revision: current.revision });
    return result('resumed', 'The current session goal was resumed after human approval.');
  } catch {
    // Never undo an approved plan or retry a potentially stale native mutation.
    return result('failed', 'Goal resume failed: the native goal service rejected the captured resume.');
  }
}
