import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveHost } from '../../../plugins/common.mjs';

// Public package imports only: no Context, App boot, host socket, Agent, GoalService instance or model.
const goal = await import(resolveHost('@deepseek-ai/dsh-goal'));
const todo = await import(resolveHost('@deepseek-ai/dsh-tool-todo'));

test('PUBLIC rc2 goal fold has exactly ONE current goal; projection does not grant activation', () => {
  const definition = goal.goalProjectionDefinition;
  assert.equal(definition.key, 'goal');
  let state = definition.init();
  const snapshot = { id: 'fixture-goal', revision: 1, objective: 'Authored SDK fixture', phase: 'active', maxGoalRounds: 4 };
  state = definition.apply(state, { type: 'goal/change', seq: 0, time: 1, data: {
    kind: 'goal/change', version: 1, operation: 'create', goal: snapshot, roundsStarted: 0, createdAt: 1, updatedAt: 1,
  } });
  const view = definition.wire.view(state);
  assert.deepEqual(view, { goal: snapshot, roundsStarted: 0, createdAt: 1, updatedAt: 1 });
  assert.equal(Object.hasOwn(view, 'activation'), false);
  assert.equal(Array.isArray(view), false);
});
test('PUBLIC rc2 native TODO actual implementation clears standing list on turn/start, not turn/end', () => {
  let projection;
  const tools = [];
  todo.apply({ sessionProjections: { register: value => { projection = value; } }, tools: { register: value => tools.push(value) } }, { allowParallelInProgress: true });
  assert.equal(projection.key, 'todos'); assert.equal(projection.stateVersion, 2);
  const list = [{ content: 'Authored fixture step', status: 'in_progress' }];
  let state = projection.apply(projection.init(), { type: 'todo/write', data: { todos: list } });
  assert.equal(state, list);
  assert.equal(projection.apply(state, { type: 'turn/end' }), list);
  assert.equal(projection.apply(state, { type: 'turn/start' }), null);
  assert.equal(tools.length, 1);
});
test('PUBLIC rc2 model goal tool cannot resume paused goal even with a direct human message in its fake driver cut', async () => {
  const toolGoal = await import(resolveHost('@deepseek-ai/dsh-tool-goal'));
  const tools = [];
  let mutations = 0;
  const agent = { id: 'fixture-agent', status: 'running', session: { snapshotEvents: () => [
    { type: 'turn/start' }, { type: 'user/message', data: { source: { kind: 'user' } } },
  ] } };
  toolGoal.apply({ systemPrompt: { section() {}, getSectionOrder: () => 1 }, tools: { register: value => tools.push(value) },
    agents: { get: id => id === agent.id ? agent : undefined, roots: () => [agent], currentInitiator: () => agent },
    sessionProjections: { stateOf: () => ({ openTurnStartSeq: 0 }) }, goals: {
      get: () => ({ id: 'fixture-goal', revision: 2, phase: 'paused' }), resume: () => { mutations++; assert.fail('Model resume bypass forbidden'); },
    } }, { blockedAfterConsecutiveRounds: 3 });
  assert.deepEqual(tools.map(tool => tool.name), ['get_goal', 'create_goal', 'update_goal']);
  await assert.rejects(() => tools.find(tool => tool.name === 'update_goal').execute({ goal_id: 'fixture-goal', revision: 2, action: 'resume' }, { agent }),
    error => error.code === 'GOAL_TOOL_RESUME_PAUSED');
  assert.equal(mutations, 0);
});
test('proposal uses public Gateway contribution only; no second shared interceptor or model tool', async () => {
  const entry = await readFile(new URL('./index.mjs', import.meta.url), 'utf8');
  assert.match(entry, /extends TypertRemoteService/);
  assert.match(entry, /ctx\.typert\.register\(contribution\(\)\)/);
  assert.match(entry, /this\.ctx\.invocation/);
  assert.doesNotMatch(entry, /\.rpc\.(?:intercept|handle)\s*\(/);
  assert.doesNotMatch(entry, /\.tools\.register\s*\(|\.prompt\s*\(|\.followup\s*\(/);
});
