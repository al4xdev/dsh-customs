import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHost } from '../common.mjs';
import { longGoalContext, registerLongGoalContext, LONG_GOAL_THRESHOLD_MS, LONG_GOAL_CONTEXT } from './long-running-context.mjs';
const { Context } = await import(resolveHost('@deepseek-ai/cordis'));
const HOUR = 3600000;
const plans = [
  { category: 'tasks', status: 'approved' },
  { category: 'backlog', status: 'staged' },
  { category: 'blocked', status: 'approved' },
  { category: 'para-o-dono', status: 'rejected' },
  { category: 'closed', status: 'closed' },
];

test('threshold and concise active time count every non-closed category', async () => {
  const snapshot = { goalId: 'goal', generation: 1, elapsed: LONG_GOAL_THRESHOLD_MS - 1 };
  const runtime = { snapshot: () => ({ ...snapshot }) };
  let reads = 0;
  const list = async () => { reads++; return plans; };
  assert.equal(await longGoalContext(runtime, {}, list), ''); assert.equal(reads, 0);
  snapshot.elapsed++;
  assert.equal(await longGoalContext(runtime, {}, list),
    'Continuous autonomous execution: 5h 0m. Open tasks in this project (not closed): 4.');
  snapshot.elapsed += 20 * 60000;
  assert.equal(await longGoalContext(runtime, {}, async () => []),
    'Continuous autonomous execution: 5h 20m. Open tasks in this project (not closed): 0.');
});

test('unknown/malformed active duration omits the notice without catalog IO', async () => {
  for (const snapshot of [null, { elapsed: NaN }, { elapsed: Infinity }, { elapsed: -1 }]) {
    assert.equal(await longGoalContext({ snapshot: () => snapshot }, {}, () => { throw new Error('unexpected read'); }), '');
  }
});

test('catalog IO races revalidate active goal and uninterrupted generation', async () => {
  for (const after of [null, { goalId: 'replacement', generation: 1, elapsed: 6 * HOUR },
    { goalId: 'goal', generation: 2, elapsed: 6 * HOUR }, { goalId: 'goal', generation: 1, elapsed: 0 },
    { epoch: Symbol('new-lifecycle'), goalId: 'goal', generation: 1, elapsed: 6 * HOUR }]) {
    let snapshot = { goalId: 'goal', generation: 1, elapsed: 6 * HOUR };
    assert.equal(await longGoalContext({ snapshot: () => snapshot }, {}, async () => { snapshot = after; return plans; }), '');
  }
});

async function fixture({ withGoals = true, withContext = true, withAgents = true, list = async () => plans, incompleteContext = false } = {}) {
  const ctx = new Context();
  const agent = { id: 'root', status: 'running', session: { id: 'root', header: {} } };
  const state = { goal: { id: 'goal', phase: 'active', activation: 'armed', createdAt: Date.now() - 100 * HOUR }, time: 0 };
  const agents = { get: id => id === agent.id ? agent : undefined, roots: () => [agent] };
  const goals = { get: () => state.goal };
  const entries = [];
  if (withAgents) ctx.provide('agents', agents);
  if (withGoals) ctx.provide('goals', goals);
  if (withContext) ctx.provide('systemPrompt', incompleteContext ? {} : {
    context: entry => entries.push(entry), getContextOrder: () => 0,
  });
  const scope = registerLongGoalContext(ctx, list, { now: () => state.time });
  await new Promise(resolve => setImmediate(resolve));
  const assemble = (contexts = entries) => {
    const assembly = { sections: [], contexts, tools: [] };
    return ctx.waterfall('system-prompt/assemble', assembly, { agent }, () => Promise.resolve(assembly));
  };
  const event = (type, data = {}) => ctx.emit('session/event', agent.session, { type, data });
  const start = () => { agent.status = 'running'; ctx.emit('agent/status', { agent, status: 'running' }); event('step/start'); };
  return { ctx, scope, agent, state, entries, agents, goals, assemble, event, start, tick: ms => { state.time += ms; } };
}

test('native optional injection tolerates missing goals, context, agents or context API', async () => {
  for (const flags of [{ withGoals: false }, { withContext: false }, { withAgents: false },
    { withGoals: false, withContext: false }, { incompleteContext: true }]) {
    const f = await fixture(flags);
    try { f.start(); f.tick(6 * HOUR); assert.equal(f.entries.length, 0); assert.deepEqual((await f.assemble()).contexts, []); }
    finally { await f.scope.dispose(); }
  }
});

test('assembly uses active execution, refreshes one snapshot and respects suppression', async () => {
  let current = plans, reads = 0;
  const f = await fixture({ list: async () => { reads++; return current; } });
  try {
    assert.equal(f.entries.length, 1); assert.equal(f.entries[0].name, LONG_GOAL_CONTEXT);
    assert.equal((await f.assemble()).contexts[0].text, '', 'old goal age alone does not trigger');
    f.start(); f.tick(5 * HOUR);
    assert.match((await f.assemble()).contexts[0].text, /execution: 5h 0m.*Open tasks.*: 4\.$/);
    current = []; assert.match((await f.assemble()).contexts[0].text, /Open tasks.*: 0\.$/);
    assert.deepEqual((await f.assemble([])).contexts, []); assert.equal(reads, 2);
    assert.equal(f.entries[0].text, '', 'does not mutate the registered context');
  } finally { await f.scope.dispose(); }
});

test('transparent assembly middleware preserves downstream transforms', async () => {
  const f = await fixture();
  f.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    return { ...assembly, sections: [{ name: 'other-plugin', text: 'retained' }] };
  });
  try { f.start(); f.tick(5 * HOUR); assert.equal((await f.assemble()).sections[0].text, 'retained'); }
  finally { await f.scope.dispose(); }
});

test('disarm activation event resets time without a durable goal mutation', async () => {
  const f = await fixture();
  try {
    f.start(); f.tick(6 * HOUR); f.state.goal.activation = 'disarmed';
    f.ctx.emit('goal/activation-changed', { sessionId: f.agent.id });
    f.tick(20 * HOUR); f.state.goal.activation = 'armed';
    f.ctx.emit('goal/activation-changed', { sessionId: f.agent.id });
    assert.equal((await f.assemble()).contexts[0].text, '');
    f.tick(5 * HOUR); assert.match((await f.assemble()).contexts[0].text, /execution: 5h 0m/);
  } finally { await f.scope.dispose(); }
});

test('service-only questions exclude human wait, reset sequence and preserve answers', async () => {
  const f = await fixture(); let answer;
  const reply = new Promise(resolve => { answer = resolve; });
  // Short-circuiting native answerers must still be wrapped.
  f.ctx.on('user-questions/request', () => reply);
  try {
    f.start(); f.tick(4 * HOUR);
    const asked = f.ctx.waterfall('user-questions/request', { agent: f.agent }, () => Promise.reject(new Error('no provider')));
    f.tick(6 * HOUR); assert.equal((await f.assemble()).contexts[0].text, '');
    const expected = { answers: [{ id: 'a', text: 'yes' }] }; answer(expected);
    assert.equal(await asked, expected);
    f.tick(5 * HOUR); assert.match((await f.assemble()).contexts[0].text, /execution: 5h 0m/);
  } finally { await f.scope.dispose(); }
});

test('service-only question errors remain unchanged and release the wait token', async () => {
  const f = await fixture(); const error = new Error('no answerer');
  try {
    f.start(); f.tick(4 * HOUR);
    await assert.rejects(f.ctx.waterfall('user-questions/request', { agent: f.agent }, () => Promise.reject(error)), received => received === error);
    f.tick(5 * HOUR); assert.match((await f.assemble()).contexts[0].text, /execution: 5h 0m/);
  } finally { await f.scope.dispose(); }
});

test('timed no-provider fallback stays suspended until the audited tool result', async () => {
  const f = await fixture();
  try {
    f.start(); f.tick(4 * HOUR);
    f.event('tool/call', { name: 'ask_user_question', callId: 'timed-q' });
    await assert.rejects(f.ctx.waterfall('user-questions/request', { agent: f.agent }, () => Promise.reject(new Error('NO_PROVIDER'))));
    f.tick(6 * HOUR);
    assert.equal((await f.assemble()).contexts[0].text, '');
    f.event('tool/result', { message: { toolCallId: 'timed-q', content: [{ type: 'text', text: '{"pending":true}' }] } });
    f.tick(5 * HOUR); f.event('step/end');
    assert.match((await f.assemble()).contexts[0].text, /execution: 5h 0m/);
  } finally { await f.scope.dispose(); }
});

test('failed optional goal/catalog reads do not break prompt assembly or normal events', async () => {
  const f = await fixture({ list: async () => { throw new Error('catalog unavailable'); } });
  try {
    f.start(); f.tick(5 * HOUR); assert.equal((await f.assemble()).contexts[0].text, '');
    f.goals.get = () => { throw new Error('goal unavailable'); };
    f.start(); assert.equal((await f.assemble()).contexts[0].text, '');
  } finally { await f.scope.dispose(); }
});

test('capability arrival activates the optional feature; disposal removes observers', async () => {
  const f = await fixture({ withGoals: false });
  try {
    f.ctx.provide('goals', f.goals); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.entries.length, 1);
    f.start(); f.tick(5 * HOUR); assert.match((await f.assemble()).contexts[0].text, /execution: 5h 0m/);
    await f.scope.dispose();
    assert.equal((await f.assemble()).contexts[0].text, '');
  } finally { await f.scope.dispose(); }
});

test('native ordering renders settled time before the NEXT step starts, excluding gaps', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.assemble()).contexts[0].text, '');
    f.start(); f.tick(5 * HOUR); f.event('step/end');
    // In the native loop, preStep assembles the prompt before appending step/start.
    f.tick(20 * HOUR);
    assert.match((await f.assemble()).contexts[0].text, /execution: 5h 0m/);
    f.event('turn/end', { reason: { kind: 'completed' } });
    f.agent.status = 'idle'; f.ctx.emit('agent/status', { agent: f.agent, status: 'idle' });
    f.tick(10 * HOUR);
    f.agent.status = 'running'; f.ctx.emit('agent/status', { agent: f.agent, status: 'running' });
    f.ctx.emit('agent/inbox/claimed', { agent: f.agent, message: { source: { kind: 'goal', goalId: 'goal', round: 1 } } });
    assert.match((await f.assemble()).contexts[0].text, /execution: 5h 0m/);
    f.event('step/start'); f.tick(HOUR); f.event('step/end');
    assert.match((await f.assemble()).contexts[0].text, /execution: 6h 0m/);
  } finally { await f.scope.dispose(); }
});
