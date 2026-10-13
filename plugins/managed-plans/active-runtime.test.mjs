import test from 'node:test';
import assert from 'node:assert/strict';
import { ActiveGoalRuntime } from './active-runtime.mjs';
const HOUR = 3600000;
function fixture() {
  let time = 0;
  const agent = { id: 'root', status: 'running', session: { id: 'root', header: {} } };
  const state = { goal: { id: 'goal', phase: 'active', activation: 'armed', createdAt: -100 * HOUR }, live: agent, roots: [agent] };
  const agents = { get: id => id === 'root' ? state.live : undefined, roots: () => state.roots };
  const runtime = new ActiveGoalRuntime({ get: () => state.goal }, agents, () => time);
  const event = (type, data = {}) => runtime.event(agent.session, { type, data, time: Date.now() });
  const tick = amount => { time += amount; };
  const start = () => { agent.status = 'running'; runtime.status(agent); event('step/start'); };
  return { agent, state, runtime, event, tick, start };
}

test('counts only observed active steps, never historical goal age or idle gaps', () => {
  const f = fixture();
  assert.equal(f.runtime.snapshot(f.agent), null);
  f.tick(100 * HOUR); f.start(); f.tick(2 * HOUR);
  assert.equal(f.runtime.snapshot(f.agent).elapsed, 2 * HOUR);
  f.event('step/end'); f.event('turn/end', { reason: { kind: 'completed' } });
  f.agent.status = 'idle'; f.runtime.status(f.agent); f.tick(40 * HOUR);
  assert.equal(f.runtime.snapshot(f.agent), null);
  f.start(); f.event('user/message', { source: { kind: 'goal', goalId: 'goal', round: 1 } }); f.tick(3 * HOUR);
  assert.equal(f.runtime.snapshot(f.agent).elapsed, 5 * HOUR);
});

test('goal created mid-step counts only from its activation; same-goal edits preserve time', () => {
  const f = fixture(); f.state.goal = undefined; f.start(); f.tick(HOUR);
  f.state.goal = { id: 'new', phase: 'active', activation: 'armed' };
  f.runtime.goalChanged(f.agent, 'create'); f.tick(HOUR);
  assert.equal(f.runtime.snapshot(f.agent).elapsed, HOUR);
  f.state.goal.revision = 2; f.runtime.goalChanged(f.agent, 'edit'); f.tick(HOUR);
  assert.equal(f.runtime.snapshot(f.agent).elapsed, 2 * HOUR);
});

for (const mutation of [{ phase: 'paused' }, { phase: 'blocked' }, { phase: 'complete' }, { activation: 'disarmed' }, { id: 'replacement' }]) {
  test(`reset on stopped/replaced goal ${JSON.stringify(mutation)}`, () => {
    const f = fixture(); f.start(); f.tick(6 * HOUR);
    Object.assign(f.state.goal, mutation); f.runtime.goalChanged(f.agent);
    f.tick(50 * HOUR);
    if (mutation.id) assert.equal(f.runtime.snapshot(f.agent).elapsed, 50 * HOUR);
    else {
      assert.equal(f.runtime.snapshot(f.agent), null);
      Object.assign(f.state.goal, { phase: 'active', activation: 'armed' });
      f.runtime.goalChanged(f.agent, 'resume');
      assert.equal(f.runtime.snapshot(f.agent).elapsed, 0);
    }
  });
}

test('overlapping approval waits reset continuity and exclude their union', () => {
  const f = fixture(); f.start(); f.tick(4 * HOUR);
  f.event('approval/asked', { id: 'a' }); f.tick(HOUR);
  f.event('approval/asked', { id: 'b' }); f.tick(HOUR);
  f.event('approval/decided', { id: 'a', outcome: 'allowed-once' }); f.tick(HOUR);
  assert.equal(f.runtime.snapshot(f.agent), null);
  f.event('approval/decided', { id: 'b', outcome: 'rejected' }); f.tick(HOUR);
  assert.equal(f.runtime.snapshot(f.agent).elapsed, HOUR);
});

test('timed questions exclude foreground wait but allow independent work after pending result', () => {
  const f = fixture(); f.start(); f.tick(4 * HOUR);
  f.event('tool/call', { name: 'ask_user_question', callId: 'q' }); f.tick(10 * HOUR);
  assert.equal(f.runtime.snapshot(f.agent), null);
  f.event('tool/result', { message: { toolCallId: 'q', content: [{ type: 'text', text: '{"pending":true}' }] } });
  f.tick(HOUR); assert.equal(f.runtime.snapshot(f.agent).elapsed, HOUR);
  f.runtime.inbox(f.agent, { source: { kind: 'user-question-reply', callId: 'q' } });
  f.tick(HOUR); assert.equal(f.runtime.snapshot(f.agent).elapsed, HOUR);
});

test('questions and approvals overlap without prematurely restarting accrual', () => {
  const f = fixture(); f.start(); f.tick(HOUR);
  f.event('tool/call', { name: 'ask_user_question', callId: 'q' });
  f.event('approval/asked', { id: 'a' }); f.tick(HOUR);
  f.event('tool/result', { message: { toolCallId: 'q', isError: true, content: [] } }); f.tick(HOUR);
  assert.equal(f.runtime.snapshot(f.agent), null);
  f.event('approval/decided', { id: 'a' }); f.tick(HOUR);
  assert.equal(f.runtime.snapshot(f.agent).elapsed, HOUR);
});

test('human input resets but automatic rounds and runtime-context updates do not', () => {
  const f = fixture(); f.start(); f.tick(HOUR);
  for (const kind of ['goal', 'runtime-context']) f.runtime.inbox(f.agent, { source: { kind } });
  assert.equal(f.runtime.snapshot(f.agent).elapsed, HOUR);
  f.runtime.inbox(f.agent, { source: { kind: 'user' } });
  assert.equal(f.runtime.snapshot(f.agent).elapsed, 0);
});

test('current runtime status wins over a stale idle notification', () => {
  const f = fixture(); f.start(); f.tick(HOUR);
  f.runtime.status(f.agent, 'idle'); f.tick(HOUR);
  assert.equal(f.runtime.snapshot(f.agent).elapsed, 2 * HOUR);
});

test('runtime ownership, live identity and disposal fence resumed forks and old instances', () => {
  const f = fixture(); f.agent.session.header.origin = 'subagent'; f.start(); f.tick(HOUR);
  assert.equal(f.runtime.snapshot(f.agent).elapsed, HOUR, 'a resumed fork root is eligible');
  f.state.roots = []; assert.equal(f.runtime.snapshot(f.agent), null);
  f.state.roots = [f.agent];
  const replacement = { ...f.agent, session: { ...f.agent.session } }; f.state.live = replacement;
  assert.equal(f.runtime.snapshot(f.agent), null);
  assert.equal(f.runtime.snapshot(replacement), null);
  f.state.live = f.agent; f.runtime.dispose(f.agent); f.tick(50 * HOUR);
  assert.equal(f.runtime.snapshot(f.agent), null);
});

for (const kind of ['error', 'aborted', 'max-tokens']) {
  test(`interrupted turn ${kind} resets the sequence`, () => {
    const f = fixture(); f.start(); f.tick(6 * HOUR);
    f.event('turn/end', { reason: { kind } }); f.start();
    assert.equal(f.runtime.snapshot(f.agent).elapsed, 0);
  });
}

test('stale session events never accrue to a replacement session', () => {
  const f = fixture(); const old = f.agent.session;
  f.agent.session = { ...old }; f.runtime.event(old, { type: 'step/start', data: {} }); f.tick(HOUR);
  assert.equal(f.runtime.snapshot(f.agent), null);
});
