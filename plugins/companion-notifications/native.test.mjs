import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, load } from './native-fixture.mjs';
import { MockSink } from './mock-sink.mjs';
import * as plugin from './index.mjs';

const ref = goal => ({ id: goal.id, revision: goal.revision });

test('actual SDK GoalService completion event, native CAS races, replay/reload dedup and cross-preset/session fences; no model', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const h = await f.create(); const agent = h.agent;
    const { agentEvents } = await load('dsh-agent');
    let event;
    f.app.on('goal/changed', payload => { event = payload; });
    let goal = f.app.goals.create(agent, { objective: 'OWN SENSITIVE OBJECTIVE MUST NEVER ENTER MOCK', maxGoalRounds: 4 });
    assert.equal(goal.activation, 'armed');
    goal = f.app.goals.pause(agent, ref(goal));
    assert.equal(goal.phase, 'paused');
    goal = f.app.goals.resume(agent, ref(goal));
    goal = f.app.goals.edit(agent, ref(goal), { maxGoalRounds: 5 });
    goal = f.app.goals.block(agent, ref(goal), { code: 'own-fixture', message: 'own synthetic blocker' });
    const sink = new MockSink(f.profileDirectory);
    assert.equal(sink.read().events.length, 0);
    goal = f.app.goals.resume(agent, ref(goal));
    const stale = ref(goal);
    goal = f.app.goals.complete(agent, stale);
    assert.equal(goal.phase, 'complete'); assert.equal(goal.activation, 'disarmed');
    assert.equal(event.change.operation, 'complete'); assert.equal(event.agent, agent);
    const completed = event;
    assert.throws(() => f.app.goals.complete(agent, stale), e => e.code === 'GOAL_STALE_REVISION');
    for (let i = 0; i < 10; i++) agentEvents(f.app, agent).emit('goal/changed', completed);
    // Repeated preset join plus a fresh actual observer cannot duplicate the mock.
    // This is an isolated observer-remount test, not an authenticated live reconnect claim.
    await f.app.agentPresets.mount(agent.ctx, 'companion');
    await plugin.apply(agent.ctx, { profile: 'companion' });
    agentEvents(f.app, agent).emit('goal/changed', completed);
    assert.equal(sink.read().events.length, 1);
    assert.deepEqual(Object.keys(sink.read().events[0]).sort(), ['eventId', 'goalId', 'phase', 'revision', 'sessionId', 'timestamp', 'version']);
    assert.equal(sink.read().events[0].goalId, goal.id);
    assert.equal(sink.read().events[0].revision, goal.revision);
    assert.equal(sink.read().events[0].sessionId, agent.id);
    assert.equal((await readFile(sink.path, 'utf8')).includes('SENSITIVE'), false);
    goal = f.app.goals.edit(agent, ref(goal), { objective: 'own terminal edit is not another completion' });
    assert.equal(goal.phase, 'complete');
    assert.equal(sink.read().events.length, 1);
    agentEvents(f.app, agent).emit('goal/changed', completed);
    assert.equal(sink.read().events.length, 1);
    const other = (await f.create('other')).agent;
    let foreign = f.app.goals.create(other, { objective: 'own foreign' });
    f.app.goals.complete(other, ref(foreign));
    // Even forged re-routing to the matching listener fails exact Agent/source checks.
    agentEvents(f.app, agent).emit('goal/changed', { ...completed, agent: other });
    agentEvents(f.app, agent).emit('goal/changed', { ...completed, agent: { ...agent } });
    let next = f.app.goals.create(agent, { objective: 'next native goal' });
    agentEvents(f.app, agent).emit('goal/changed', completed);
    assert.equal(sink.read().events.length, 1);
    next = f.app.goals.complete(agent, ref(next));
    assert.equal(sink.read().events.length, 2);
    const { foldGoal } = await load('dsh-goal');
    assert.equal(foldGoal(agent.session.snapshotEvents()).goal.id, next.id);
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('plugin absent: native goal works, zero notification state created', async () => {
  const f = await fixture({ installed: false });
  try {
    const { agent } = await f.create();
    const goal = f.app.goals.create(agent, { objective: 'own no-plugin' });
    assert.equal(f.app.goals.complete(agent, ref(goal)).phase, 'complete');
    await assert.rejects(access(join(f.profileDirectory, 'companion-notifications')), { code: 'ENOENT' });
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('reject global/non-Companion mount before sink creation; delivery errors cannot revert native goal', async () => {
  const f = await fixture({ installed: false });
  try {
    await assert.rejects(plugin.apply(f.app, { profile: 'companion' }), /preset scope/);
    const { createScope } = await load('dsh-scope');
    const scope = createScope(f.app, {});
    await assert.rejects(plugin.apply(scope.ctx, { profile: 'web' }), /preset scope/);
    await assert.rejects(access(join(f.profileDirectory, 'companion-notifications')), { code: 'ENOENT' });
    await plugin.apply(scope.ctx, { profile: 'companion' });
    const { agent } = await f.create();
    // Use a second agent-local listener to exercise failure containment at the actual event boundary.
    await plugin.apply(agent.ctx, { profile: 'companion' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(f.profileDirectory, 'companion-notifications/mock-v1.json.lock'), 'own held lock');
    const goal = f.app.goals.create(agent, { objective: 'own sink failure' });
    assert.equal(f.app.goals.complete(agent, ref(goal)).phase, 'complete');
    assert.equal(f.app.goals.get(agent).phase, 'complete');
    assert.equal(new MockSink(f.profileDirectory).read().events.length, 0);
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});
