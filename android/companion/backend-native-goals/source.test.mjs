import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeGoals } from './source.mjs';

function fixture({ tracing = false, missingOperatorUid = false } = {}) {
  const original = Symbol('public-cordis-original-fixture');
  let time = 1000, sequence = 0;
  const scope = {};
  const peer = { id: 'operator', ctx: { fiber: { uid: 2 } } };
  const profile = { name: 'companion' };
  const connection = { operator: peer };
  const calls = [];
  const agent = { id: 'session-own', ctx: { scope }, status: 'idle', session: {
    id: 'session-own', header: { id: 'session-own', agentPreset: 'companion', isSeeded: false },
  } };
  const goal = { id: 'goal-own', revision: 2, objective: 'Authored fixture', phase: 'paused', activation: 'disarmed', maxGoalRounds: 4, roundsStarted: 1 };
  const agents = new Map([[agent.id, agent]]);
  let roots = [agent];
  const values = () => ({ goal: goal.id ? { goal: Object.fromEntries(Object.entries(goal).filter(([k]) => !['activation', 'roundsStarted'].includes(k))),
    roundsStarted: goal.roundsStarted, createdAt: 1, updatedAt: 2 } : null, todos: [{ content: 'Fixture task', status: 'in_progress' }] });
  const services = {
    profileContext: profile, connection,
    agents: { get: id => agents.get(id), roots: () => roots },
    goals: { get: current => { assert.equal(agents.get(current.id), current); return goal.id ? { ...goal } : undefined; },
      pause(current, ref) { mutate(current, ref, 'pause', 'paused', 'disarmed'); },
      resume(current, ref) { mutate(current, ref, 'resume', 'active', 'armed'); } },
    sessionProjections: { snapshot: (session, keys) => { assert.deepEqual(keys, ['goal', 'todos']); assert.equal(session, agents.get(session.id).session); return { asOfSeq: 5, values: values() }; } },
    agentPresets: { composedPreset: () => 'companion' },
    sessionPersistence: new Proxy({}, { get() { assert.fail('No persistence/history/loader reads allowed'); } }),
  };
  function mutate(current, ref, action, phase, activation) {
    assert.equal(current, agents.get(agent.id)); assert.deepEqual(ref, { id: goal.id, revision: goal.revision });
    calls.push(action); Object.assign(goal, { phase, activation, revision: goal.revision + 1 });
  }
  const ctx = { get: key => tracing && key !== 'profileContext' && services[key] ? new Proxy(services[key], {
    get: (target, name) => name === original ? target : Reflect.get(target, name),
  }) : services[key], scope };
  ctx.fiber = { uid: 1 }; ctx.root = { fiber: { uid: 0 }, get: ctx.get };
  Object.assign(peer.ctx, { root: ctx.root, get: ctx.get });
  if (missingOperatorUid) delete peer.ctx.fiber.uid;
  const source = createNativeGoals(ctx, { scopeOf: context => context.scope, scopeChainOf: key => key ? [key] : [],
    identityOf: value => value?.[original] ?? value, now: () => time, mint: () => `fixture-${++sequence}` });
  const invoke = (method, request, sender = peer, signal) => source.dispatch(`nativeGoals/${method}`, { args: { request } }, signal, sender);
  async function capture() { const response = await invoke('read', { sessionId: agent.id, generation: 7 }); assert.equal(response.ok, true); return response.value; }
  const request = row => ({ sessionId: row.sessionId, goalId: row.projections.goal.goal.id, revision: row.projections.goal.goal.revision,
    sourceId: row.sourceId, incarnation: row.incarnation, generation: row.generation, permit: row.permit, action: 'resume' });
  return { source, ctx, services, agent, agents, peer, profile, goal, calls, invoke, capture, request,
    advance: amount => { time += amount; }, setRoots: value => { roots = value; } };
}

test('one real current goal plus independent native TODO; no projection activation invented', async () => {
  const f = fixture(); const row = await f.capture();
  assert.equal(row.projections.goal.goal.phase, 'paused'); assert.equal(row.activation, 'disarmed');
  assert.equal(Object.hasOwn(row.projections.goal, 'activation'), false);
  assert.deepEqual(row.projections.todos, [{ content: 'Fixture task', status: 'in_progress' }]);
  assert.equal(f.calls.length, 0);
});
test('human operator-only PUBLIC GoalService resume uses exact ref; one-time permit rejects replay', async () => {
  const f = fixture(); const request = f.request(await f.capture());
  const result = await f.invoke('control', request);
  assert.equal(result.ok, true); assert.equal(result.value.projections.goal.goal.revision, 3);
  assert.equal(result.value.activation, 'armed'); assert.deepEqual(f.calls, ['resume']);
  assert.equal((await f.invoke('control', request)).ok, false); assert.deepEqual(f.calls, ['resume']);
});
test('native active pause and human active-disarmed rearm are distinct valid transitions', async () => {
  const f = fixture(); f.goal.phase = 'active'; f.goal.activation = 'armed';
  const request = { ...f.request(await f.capture()), action: 'pause' };
  assert.equal((await f.invoke('control', request)).ok, true);
  f.goal.phase = 'active'; f.goal.activation = 'disarmed';
  assert.equal((await f.invoke('control', f.request(await f.capture()))).ok, true);
  assert.deepEqual(f.calls, ['pause', 'resume']);
});
for (const [name, modify] of Object.entries({
  source: r => { r.sourceId = 'foreign-source'; }, incarnation: r => { r.incarnation = 'foreign-incarnation'; },
  generation: r => { r.generation++; }, goalId: r => { r.goalId = 'goal-other'; }, revision: r => { r.revision++; },
})) test(`stale ${name} consumes permit, never recaptures or mutates`, async () => {
  const f = fixture(); const original = f.request(await f.capture()); const request = { ...original }; modify(request);
  assert.equal((await f.invoke('control', request)).ok, false);
  assert.equal((await f.invoke('control', original)).ok, false); assert.deepEqual(f.calls, []);
});
for (const [name, modify] of Object.entries({
  'edited native revision': f => { f.goal.revision++; }, 'changed phase': f => { f.goal.phase = 'blocked'; },
  'activation edge': f => { f.goal.activation = 'armed'; }, 'admitted native round': f => { f.goal.roundsStarted++; },
  'round cap': f => { f.goal.maxGoalRounds++; }, 'expired': f => { f.advance(30000); },
  'agent replacement': f => { f.agents.set(f.agent.id, { ...f.agent }); },
  'no longer root': f => { f.setRoots([]); }, 'foreign preset': f => { f.agent.session.header.agentPreset = 'other'; },
  'subagent': f => { f.agent.session.header.origin = 'subagent'; }, 'seed': f => { f.agent.session.header.isSeeded = true; },
  'scope': f => { f.agent.ctx.scope = {}; }, 'profile source': f => { f.services.profileContext = { name: 'companion' }; },
  'connection source': f => { f.services.connection = { operator: f.peer }; },
  'goal service source': f => { f.services.goals = { ...f.services.goals }; },
  'projection service source': f => { f.services.sessionProjections = { ...f.services.sessionProjections }; },
})) test(`control rejects ${name} without native effect`, async () => {
  const f = fixture(); const request = f.request(await f.capture()); modify(f);
  assert.equal((await f.invoke('control', request)).ok, false); assert.deepEqual(f.calls, []);
});
test('JSON role/human/source claims and a same-id forged Peer cannot acquire operator authority', async () => {
  const f = fixture(); const row = await f.capture();
  assert.equal((await f.invoke('control', f.request(row), { ...f.peer })).ok, false);
  assert.equal((await f.invoke('control', { ...f.request(row), role: 'human' })).ok, false);
  assert.equal((await f.invoke('read', { sessionId: f.agent.id, generation: 1, human: true })).ok, false);
  assert.deepEqual(f.calls, []);
});
test('budget exhausted, complete, active-armed cannot human-resume; no silent cap edit', async () => {
  for (const mode of ['cap', 'complete', 'active']) {
    const f = fixture();
    if (mode === 'cap') f.goal.roundsStarted = 4;
    if (mode === 'complete') f.goal.phase = 'complete';
    if (mode === 'active') Object.assign(f.goal, { phase: 'active', activation: 'armed' });
    const row = await f.capture();
    if (row.permit) assert.equal((await f.invoke('control', f.request(row))).ok, false);
    else assert.equal(mode, 'complete');
    assert.deepEqual(f.calls, []);
  }
});
test('catalog uses CURRENT exact live status, not head/history: absent/foreign is unknown, bounded 100', async () => {
  const f = fixture(); f.goal.phase = 'active'; f.goal.activation = 'armed'; f.agent.status = 'running';
  const result = await f.invoke('catalog', { sessionIds: [f.agent.id, 'cold-session', 'foreign-session'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.activities, [
    { sessionId: f.agent.id, goalRunning: true, responding: true },
    { sessionId: 'cold-session', goalRunning: null, responding: null },
    { sessionId: 'foreign-session', goalRunning: null, responding: null },
  ]);
  assert.equal((await f.invoke('catalog', { sessionIds: Array.from({ length: 101 }, (_, n) => `session-${n}`) })).ok, false);
  assert.equal((await f.invoke('catalog', { sessionIds: [f.agent.id, f.agent.id] })).ok, false);
  f.agent.status = 'idle'; f.goal.activation = 'disarmed';
  assert.deepEqual((await f.invoke('catalog', { sessionIds: [f.agent.id] })).value.activities[0], { sessionId: f.agent.id, goalRunning: false, responding: false });
});
test('cancellation and adapter withdrawal invalidate control; no unknown side-effect retry', async () => {
  const f = fixture(); const request = f.request(await f.capture());
  const abort = new AbortController(); abort.abort();
  assert.equal((await f.invoke('control', request, f.peer, abort.signal)).ok, false); assert.deepEqual(f.calls, []);
  f.source.close(); assert.equal((await f.invoke('control', request)).ok, false);
});
test('public tracing proxy identity changes do not invalidate the exact provider binding', async () => {
  const f = fixture({ tracing: true }); const request = f.request(await f.capture());
  assert.equal((await f.invoke('control', request)).ok, true); assert.deepEqual(f.calls, ['resume']);
});
test('host-only push ownership resolver is live/operator/scope fenced and closed on withdrawal', () => {
  const f = fixture();
  assert.equal(f.source.ownsSession(f.agent.id, f.peer), true);
  assert.equal(f.source.ownsSession('cold-session', f.peer), false);
  assert.equal(f.source.ownsSession(f.agent.id, { ...f.peer }), false);
  f.source.close(); assert.equal(f.source.ownsSession(f.agent.id, f.peer), false);
});
test('errors cannot leak objective/private exception; reply is sanitized', async () => {
  const f = fixture(); f.services.goals.get = () => { throw new Error('SECRET private path objective'); };
  const result = await f.invoke('read', { sessionId: f.agent.id, generation: 1 });
  assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

for (const [name, invalidate] of [
  ['operator UID null', f => { f.peer.ctx.fiber.uid = null; }],
  ['owner UID null', f => { f.ctx.fiber.uid = null; }],
  ['root UID null', f => { f.ctx.root.fiber.uid = null; }],
  ['operator context replaced', f => { f.peer.ctx = { ...f.peer.ctx }; }],
  ['operator fiber replaced with same numeric UID', f => { f.peer.ctx.fiber = { uid: 2 }; }],
  ['owner fiber replaced with same numeric UID', f => { f.ctx.fiber = { uid: 1 }; }],
  ['operator root replaced', f => { f.peer.ctx.root = { ...f.ctx.root }; }],
  ['operator object replaced', f => { f.services.connection.operator = { ...f.peer }; }],
]) test(`pinned public lifetime rejects ${name} for read/catalog/control and ownership`, async () => {
  const f = fixture(), request = f.request(await f.capture()); invalidate(f);
  for (const [method, input] of [['read', { sessionId: f.agent.id, generation: 7 }], ['catalog', { sessionIds: [f.agent.id] }], ['control', request]]) {
    const result = await f.invoke(method, input);
    assert.equal(result.ok, false); assert.equal(result.error.code, 'nativeGoals/operator-required');
  }
  assert.equal(f.source.ownsSession(f.agent.id, f.peer), false); assert.deepEqual(f.calls, []);
});
test('missing UID at source assembly never defaults to a later numeric UID', async () => {
  const f = fixture({ missingOperatorUid: true }); f.peer.ctx.fiber.uid = 2;
  const result = await f.invoke('read', { sessionId: f.agent.id, generation: 7 });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'nativeGoals/operator-required'); assert.deepEqual(f.calls, []);
});
