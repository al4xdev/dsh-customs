import test from 'node:test';
import assert from 'node:assert/strict';
import { captureApprovalGoal, resumeApprovalGoal } from './goal-resume.mjs';

function fixture(phase = 'paused') {
  const agent = { id: 'session-owner', session: { id: 'session-owner', header: { origin: 'user' } } };
  const state = { goal: { id: 'goal-current', revision: 4, phase, activation: 'disarmed',
    objective: 'Current request', roundsStarted: 2, maxGoalRounds: 10 }, calls: [], reads: 0 };
  const goals = {
    get(received) { assert.equal(received, agent); state.reads++; return state.goal; },
    resume(received, ref) { state.calls.push({ agent: received, ref }); return { ...state.goal, phase: 'active', revision: ref.revision + 1 }; },
  };
  const ctx = { get: key => key === 'goals' ? goals : undefined,
    agents: { get: id => id === agent.id ? agent : undefined, roots: () => [agent] } };
  return { ctx, agent, state, goals };
}

for (const phase of ['paused', 'blocked']) {
  test(`captures and resumes the current ${phase} goal with exact native CAS`, () => {
    const { ctx, agent, state } = fixture(phase);
    const before = structuredClone(state.goal);
    const capture = captureApprovalGoal(ctx, agent);
    assert.equal(capture.result, null);
    assert.deepEqual(capture.candidate, { session_id: agent.id, id: before.id, revision: before.revision,
      phase, roundsStarted: 2, maxGoalRounds: 10 });
    assert.ok(Object.isFrozen(capture.candidate));
    const outcome = resumeApprovalGoal(ctx, agent, capture.candidate);
    assert.equal(outcome.status, 'resumed');
    assert.equal(typeof outcome.message, 'string');
    assert.deepEqual(state.calls, [{ agent, ref: { id: before.id, revision: before.revision } }]);
    assert.deepEqual(state.goal, before, 'helpers do not edit counters, objective, or native views');
  });
}

for (const phase of ['active', 'complete']) {
  test(`${phase} goals never resume, including active/disarmed`, () => {
    const { ctx, agent, state } = fixture(phase);
    const capture = captureApprovalGoal(ctx, agent);
    assert.equal(capture.candidate, null);
    assert.equal(capture.result.status, 'not-needed');
    assert.equal(resumeApprovalGoal(ctx, agent, capture.candidate).status, 'not-needed');
    assert.equal(state.calls.length, 0);
  });
}

test('absent goal is not-needed; absent or incomplete native capability is optional', () => {
  const { ctx, agent, state } = fixture();
  state.goal = undefined;
  assert.equal(captureApprovalGoal(ctx, agent).result.status, 'not-needed');
  for (const value of [undefined, {}, { get() {} }]) {
    ctx.get = () => value;
    assert.equal(captureApprovalGoal(ctx, agent).result.status, 'unavailable');
  }
  delete ctx.get;
  assert.equal(captureApprovalGoal(ctx, agent).result.status, 'unavailable');
  assert.equal(state.calls.length, 0);
});

test('uses the goal current at approval capture, not a historical plan origin', () => {
  const { ctx, agent, state } = fixture();
  state.goal = { ...state.goal, id: 'new-goal-after-many-changes', revision: 1 };
  const { candidate } = captureApprovalGoal(ctx, agent);
  assert.equal(candidate.id, 'new-goal-after-many-changes');
  assert.equal(resumeApprovalGoal(ctx, agent, candidate).status, 'resumed');
  assert.equal(state.calls[0].ref.id, 'new-goal-after-many-changes');
});

test('snapshot is detached even when the service returns mutable state', () => {
  const { ctx, agent, state } = fixture();
  const { candidate } = captureApprovalGoal(ctx, agent);
  state.goal.revision++;
  assert.equal(candidate.revision, 4);
  assert.equal(resumeApprovalGoal(ctx, agent, candidate).status, 'skipped');
  assert.equal(state.calls.length, 0);
});

for (const change of [{ id: 'replacement' }, { revision: 5 }, { phase: 'blocked' }, { phase: 'active' },
  { phase: 'complete' }, { roundsStarted: 3 }, { maxGoalRounds: 11 }]) {
  test(`post-capture change ${JSON.stringify(change)} skips without recapture or retry`, () => {
    const { ctx, agent, state } = fixture();
    const { candidate } = captureApprovalGoal(ctx, agent);
    state.goal = { ...state.goal, ...change };
    assert.equal(resumeApprovalGoal(ctx, agent, candidate).status, 'skipped');
    assert.equal(state.reads, 2);
    assert.equal(state.calls.length, 0);
  });
}

test('cleared goal and service removal after approval are nonthrowing', () => {
  const { ctx, agent, state } = fixture();
  const { candidate } = captureApprovalGoal(ctx, agent);
  state.goal = undefined;
  assert.equal(resumeApprovalGoal(ctx, agent, candidate).status, 'skipped');
  ctx.get = () => undefined;
  assert.equal(resumeApprovalGoal(ctx, agent, candidate).status, 'unavailable');
  assert.equal(state.calls.length, 0);
});

test('rejects non-live identities, delegated owners, and session switches', () => {
  for (const alter of [
    ({ ctx }) => { ctx.agents.get = () => ({}); },
    ({ ctx }) => { ctx.agents.roots = () => []; },
    ({ agent }) => { agent.session.header.origin = 'subagent'; },
    ({ agent }) => { agent.session.id = 'different-session'; },
  ]) {
    const f = fixture();
    const { candidate } = captureApprovalGoal(f.ctx, f.agent);
    alter(f);
    assert.equal(captureApprovalGoal(f.ctx, f.agent).result.status, 'skipped');
    assert.equal(resumeApprovalGoal(f.ctx, f.agent, candidate).status, 'skipped');
    assert.equal(f.state.calls.length, 0);
  }
});

test('a different live root cannot consume another session capture', () => {
  const { ctx, agent, state } = fixture();
  const { candidate } = captureApprovalGoal(ctx, agent);
  const other = { id: 'other-session', session: { id: 'other-session', header: { origin: 'user' } } };
  ctx.agents = { get: () => other, roots: () => [other] };
  assert.equal(resumeApprovalGoal(ctx, other, candidate).status, 'skipped');
  assert.equal(state.calls.length, 0);
});

test('roots capability is optional; subagent header remains forbidden without it', () => {
  const { ctx, agent, state } = fixture();
  delete ctx.agents.roots;
  assert.ok(captureApprovalGoal(ctx, agent).candidate);
  agent.session.header.origin = 'subagent';
  assert.equal(captureApprovalGoal(ctx, agent).result.status, 'skipped');
  assert.equal(state.calls.length, 0);
});

test('exhausted budget and malformed counters never cause mutations', () => {
  for (const fields of [{ roundsStarted: 10 }, { roundsStarted: 11 }, { roundsStarted: -1 },
    { roundsStarted: NaN }, { maxGoalRounds: 0 }, { revision: 0 }, { id: '' }]) {
    const { ctx, agent, state } = fixture();
    state.goal = { ...state.goal, ...fields };
    const capture = captureApprovalGoal(ctx, agent);
    assert.equal(capture.candidate, null);
    assert.ok(['skipped', 'failed'].includes(capture.result.status));
    assert.equal(state.calls.length, 0);
  }
});

test('read, capability, and registry errors are contained without exposing exception text', () => {
  for (const alter of [
    ({ goals }) => { goals.get = () => { throw new Error('PRIVATE_DETAILS'); }; },
    ({ ctx }) => { ctx.get = () => { throw new Error('PRIVATE_DETAILS'); }; },
    ({ ctx }) => { ctx.agents.roots = () => { throw new Error('PRIVATE_DETAILS'); }; },
  ]) {
    const f = fixture();
    const { candidate } = captureApprovalGoal(f.ctx, f.agent);
    alter(f);
    const capture = captureApprovalGoal(f.ctx, f.agent);
    assert.equal(capture.result.status, 'failed');
    assert.doesNotMatch(capture.result.message, /PRIVATE_DETAILS/);
    const resumed = resumeApprovalGoal(f.ctx, f.agent, candidate);
    assert.equal(resumed.status, 'failed');
    assert.doesNotMatch(resumed.message, /PRIVATE_DETAILS/);
    assert.equal(f.state.calls.length, 0);
  }
});

test('native stale rejection is attempted once and never retried with a new revision', () => {
  const { ctx, agent, state, goals } = fixture('blocked');
  const { candidate } = captureApprovalGoal(ctx, agent);
  goals.resume = (_agent, ref) => {
    state.calls.push(ref);
    state.goal = { ...state.goal, revision: 5 };
    throw Object.assign(new Error('PRIVATE stale ref'), { code: 'GOAL_STALE_REVISION' });
  };
  const outcome = resumeApprovalGoal(ctx, agent, candidate);
  assert.equal(outcome.status, 'failed');
  assert.doesNotMatch(outcome.message, /PRIVATE/);
  assert.deepEqual(state.calls, [{ id: candidate.id, revision: 4 }]);
  assert.equal(state.reads, 2);
});

test('null and malformed captures are safe, and resume never returns a promise', () => {
  const { ctx, agent, state } = fixture();
  for (const candidate of [null, {}, { session_id: agent.id, phase: 'active' },
    { session_id: agent.id, phase: 'paused', id: 'g', revision: 1, roundsStarted: 10, maxGoalRounds: 10 }]) {
    const outcome = resumeApprovalGoal(ctx, agent, candidate);
    assert.ok(['not-needed', 'skipped'].includes(outcome.status));
    assert.equal(outcome.then, undefined);
  }
  assert.equal(state.calls.length, 0);
});
