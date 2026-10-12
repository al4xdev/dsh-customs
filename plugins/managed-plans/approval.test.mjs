import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagedPlans } from './index.mjs';
import { PlanStore } from './store.mjs';
import { resolveHost } from '../common.mjs';

const { Context } = await import(resolveHost('@deepseek-ai/cordis'));
const { ToolRuntime } = await import(resolveHost('@deepseek-ai/dsh-tools'));
const { CommandRuntime } = await import(resolveHost('@deepseek-ai/dsh-commands'));
const { GoalService } = await import(resolveHost('@deepseek-ai/dsh-goal'));
const scratch = fileURLToPath(new URL('../../.dumps/', import.meta.url));

// Only the ephemeral session/projection/persistence adapters are fixtures. The
// registered plugin, tool/command runtimes, and project store are production code.
async function fixture(t, { phase = 'paused', goalsAvailable = true, autonomousByDefault = false, nativeGoals = false } = {}) {
  await mkdir(scratch, { recursive: true });
  const workspace = await mkdtemp(join(scratch, 'managed-plan-approval-'));
  assert.equal(await realpath(workspace), workspace);
  assert.equal(await realpath(join(workspace, '..')), await realpath(scratch));
  const state = { trace: [], sends: [], resumes: [], reads: [], flushes: 0, hook: null,
    goal: { id: 'current-approval-goal', revision: 6, phase, roundsStarted: 2,
      maxGoalRounds: 12, activation: 'disarmed', objective: 'Current approving session request' } };
  const definitions = new Map(), projections = new WeakMap(), live = new Map();
  function projection(session, key) {
    let values = projections.get(session);
    if (!values) { values = new Map(); projections.set(session, values); }
    if (!values.has(key) && definitions.has(key)) values.set(key, definitions.get(key).init());
    return values.get(key);
  }
  function makeAgent(id, header) {
    const agent = { id, status: 'idle', session: { id, header, events: [],
      get seq() { return this.events.length; },
      append(type, data) {
        const event = { type, data, seq: this.events.length };
        this.events.push(event);
        for (const [key, definition] of definitions) {
          const before = projection(this, key);
          projections.get(this).set(key, definition.apply(before, event));
        }
        ctx.emit('session/event', this, event);
        return event;
      } },
      send(message, target, wake) {
        state.trace.push('send'); state.sends.push({ agent: this, message, target, wake });
        this.session.append('agent/inbox/spliced', { inserted: [message] });
      } };
    live.set(id, agent);
    return agent;
  }
  const agent = makeAgent('approval-owner', { origin: 'cli', cwd: workspace });
  const creator = makeAgent('historical-creator', { origin: 'cli', cwd: workspace });
  const child = makeAgent('approval-child', { origin: 'subagent', parentSession: agent.id, cwd: workspace });
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() {}, section() {}, getSectionOrder() { return 0; } });
  const tools = new ToolRuntime(ctx), commands = new CommandRuntime(ctx);
  ctx.provide('agents', { get: id => live.get(id), roots: () => [agent, creator] });
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) });
  ctx.provide('sessionProjections', {
    register(definition) { definitions.set(definition.key, definition); },
    stateOf: projection,
  });
  ctx.provide('sessionPersistence', { async flush() {
    state.trace.push('flush'); state.flushes++;
    if (state.hook) await state.hook();
  } });
  if (goalsAvailable && !nativeGoals) ctx.provide('goals', {
    get(target) { state.reads.push(target); return target === agent ? state.goal : { ...state.goal, id: 'unrelated-creator-goal' }; },
    resume(target, ref) {
      state.trace.push('resume'); state.resumes.push({ agent: target, ref });
      assert.equal(target, agent);
      assert.equal(ref.id, state.goal.id); assert.equal(ref.revision, state.goal.revision);
      state.goal = { ...state.goal, phase: 'active', activation: 'armed', revision: ref.revision + 1 };
      return { ...state.goal };
    },
  });
  if (nativeGoals) new GoalService(ctx);
  const plugin = new ManagedPlans(ctx, { wakeAgent: true, autonomousByDefault });
  // Retain fixture directories as local evidence. No deletion or production state.
  t.after(() => { for (const writer of plugin.writers.values()) writer.dispose(); });
  let call = 0;
  async function store(operation, write = false) {
    const handle = new PlanStore(workspace);
    try { await handle.initialize({ readOnly: !write }); return await operation(handle); }
    finally { handle.dispose(); }
  }
  async function stage(category = 'tasks') {
    return store(s => s.stage({ title: `Approval ${category}`, plan: '# Approval fixture\n\nExact proposal.\n', category,
      origin: { session_id: creator.id, call_id: `origin-${++call}` } }), true);
  }
  async function ui(plan, decision = 'approve', target = agent, extra = {}) {
    const execution = await commands.execute(target, '/plan ui ' + JSON.stringify({ action: 'decide',
      plan_id: plan.plan_id, revision: plan.revision, hash: plan.hash, decision, ...extra }), [], new AbortController().signal);
    return { ...execution, data: execution.result.kind === 'success' ? JSON.parse(execution.result.text).data : null };
  }
  return { workspace, state, ctx, agent, creator, child, live, plugin, tools, commands, store, stage, ui, projection };
}

for (const phase of ['paused', 'blocked']) {
  test(`human tasks approval resumes current ${phase} goal only after durable delivery`, async t => {
    const f = await fixture(t, { phase });
    const plan = await f.stage();
    // Approval must be able to deliver a non-waking notice even to a running root.
    f.agent.status = 'running';
    const approved = await f.ui(plan);
    assert.equal(approved.result.kind, 'success', approved.result.text);
    assert.equal(approved.data.goal_resume.status, 'resumed');
    assert.equal(approved.data.execution_authorized, true);
    assert.deepEqual(f.state.resumes, [{ agent: f.agent, ref: { id: 'current-approval-goal', revision: 6 } }]);
    assert.ok(f.state.reads.every(agent => agent === f.agent), 'historical creator goal is never read');
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.state.sends[0].agent, f.agent);
    assert.equal(f.state.sends[0].wake, false);
    assert.equal(f.state.sends[0].message.source.kind, 'managed-plan');
    const send = f.state.trace.indexOf('send'), resume = f.state.trace.indexOf('resume');
    assert.ok(send >= 0 && resume > send);
    assert.ok(f.state.trace.slice(send + 1, resume).includes('flush'));
    assert.equal((await f.store(s => s.read(plan.plan_id))).status, 'approved');
    assert.deepEqual(await f.store(s => s.pendingNotifications(f.agent.id)), []);
    const command = f.agent.session.events.find(event => event.type === 'command/run');
    assert.deepEqual(command.data.source, { kind: 'user' });
    assert.equal(command.data.commandId, approved.commandId);
  });
}

test('approval captures the newest session goal, independent of creation-time identity', async t => {
  const f = await fixture(t);
  const plan = await f.stage();
  f.state.goal = { ...f.state.goal, id: 'latest-human-goal', revision: 1 };
  assert.equal((await f.ui(plan)).data.goal_resume.status, 'resumed');
  assert.deepEqual(f.state.resumes[0].ref, { id: 'latest-human-goal', revision: 1 });
});

for (const [category, decision] of [['tasks', 'reject'], ['backlog', 'approve'], ['blocked', 'approve'], ['para-o-dono', 'approve']]) {
  test(`${decision} of ${category} never resumes a stopped session goal`, async t => {
    const f = await fixture(t);
    const plan = await f.stage(category);
    const reviewed = await f.ui(plan, decision);
    assert.equal(reviewed.result.kind, 'success', reviewed.result.text);
    assert.equal(reviewed.data.goal_resume.status, 'not-needed');
    assert.equal(f.state.resumes.length, 0);
    assert.equal(f.state.goal.phase, 'paused');
  });
}

for (const phase of ['active', 'complete', null]) {
  test(`tasks approval does not resume ${phase ?? 'absent'} current goal`, async t => {
    const f = await fixture(t, { phase });
    if (phase === null) f.state.goal = undefined;
    const reviewed = await f.ui(await f.stage());
    assert.equal(reviewed.result.kind, 'success', reviewed.result.text);
    assert.equal(reviewed.data.goal_resume.status, 'not-needed');
    assert.equal(f.state.resumes.length, 0);
  });
}

test('missing goal capability does not invalidate the approved plan', async t => {
  const f = await fixture(t, { goalsAvailable: false });
  const plan = await f.stage();
  const reviewed = await f.ui(plan);
  assert.equal(reviewed.result.kind, 'success', reviewed.result.text);
  assert.equal(reviewed.data.goal_resume.status, 'unavailable');
  assert.equal((await f.store(s => s.read(plan.plan_id))).status, 'approved');
  assert.equal(f.state.resumes.length, 0);
});

test('repeated approval does not resume a newly paused goal', async t => {
  const f = await fixture(t);
  const plan = await f.stage();
  assert.equal((await f.ui(plan)).data.goal_resume.status, 'resumed');
  f.state.goal = { ...f.state.goal, phase: 'paused', activation: 'disarmed', revision: 8 };
  const repeated = await f.ui(plan);
  assert.equal(repeated.result.kind, 'success', repeated.result.text);
  assert.equal(repeated.data.goal_resume.status, 'not-needed');
  assert.equal(f.state.resumes.length, 1);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.goal.phase, 'paused');
});

for (const change of [{ id: 'replaced-after-consent' }, { revision: 7, objective: 'Edited while blocked' }, { phase: 'complete' }]) {
  test(`goal change during durable flush skips CAS without undoing approval: ${JSON.stringify(change)}`, async t => {
    const f = await fixture(t, { phase: 'blocked' });
    const plan = await f.stage();
    f.state.hook = () => { f.state.hook = null; f.state.goal = { ...f.state.goal, ...change }; };
    const reviewed = await f.ui(plan);
    assert.equal(reviewed.result.kind, 'success', reviewed.result.text);
    assert.equal(reviewed.data.goal_resume.status, 'skipped');
    assert.equal(f.state.resumes.length, 0);
    assert.equal((await f.store(s => s.read(plan.plan_id))).status, 'approved');
    assert.equal(f.state.sends.length, 1);
  });
}

test('delegated command and actor-shaped payloads cannot impersonate human root approval', async t => {
  const f = await fixture(t);
  const plan = await f.stage();
  for (const [target, extra] of [[f.child, {}], [f.agent, { actor: 'owner' }],
    [f.agent, { actor: 'autonomous' }], [f.agent, { owner_session_id: f.agent.id }],
    [f.agent, { recipient_session_id: f.agent.id }], [f.agent, { origin: { session_id: f.agent.id } }]]) {
    const denied = await f.ui(plan, 'approve', target, extra);
    assert.equal(denied.result.kind, 'error');
    assert.equal((await f.store(s => s.read(plan.plan_id))).status, 'staged');
  }
  assert.equal(f.state.resumes.length, 0);
  assert.equal(f.state.sends.length, 0);
});

test('stale plan CAS never resumes or delivers a goal approval', async t => {
  const f = await fixture(t);
  const plan = await f.stage();
  const denied = await f.ui({ ...plan, hash: 'wrong-exact-hash' });
  assert.equal(denied.result.kind, 'error');
  assert.equal((await f.store(s => s.read(plan.plan_id))).status, 'staged');
  assert.equal(f.state.resumes.length, 0);
  assert.equal(f.state.sends.length, 0);
});

test('autonomous tool approval and notification-only delivery never resume', async t => {
  const f = await fixture(t, { autonomousByDefault: true });
  const execution = await f.tools.execute({ name: 'plan_stage', arguments: { title: 'Autonomous fixture',
    plan: '# Autonomous fixture\n\nNot human approval.', category: 'tasks' }, agent: f.agent,
    callId: 'autonomous-stage', signal: new AbortController().signal });
  assert.equal(execution.isError, false, JSON.stringify(execution));
  const approved = JSON.parse(execution.value);
  assert.equal(approved.execution_authorized, true);
  assert.equal(f.state.resumes.length, 0);
  const plan = await f.stage();
  await f.store(s => s.decide({ plan_id: plan.plan_id, revision: plan.revision, hash: plan.hash,
    decision: 'approve', owner_session_id: f.agent.id, recipient_session_id: f.agent.id }), true);
  await f.plugin.deliver(f.agent);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.resumes.length, 0);
  assert.equal(f.state.goal.phase, 'paused');
});

test('onlyPlan delivers the newly approved revision without consuming unrelated pending work', async t => {
  const f = await fixture(t);
  const unrelated = await f.stage();
  await f.store(s => s.decide({ plan_id: unrelated.plan_id, revision: unrelated.revision, hash: unrelated.hash,
    decision: 'approve', owner_session_id: f.agent.id, recipient_session_id: f.agent.id }), true);
  const target = await f.stage();
  const approved = await f.ui(target);
  assert.equal(approved.result.kind, 'success', approved.result.text);
  assert.equal(approved.data.goal_resume.status, 'resumed');
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.sends[0].message.source.notification_id, approved.data.notification_id);
  const remaining = await f.store(s => s.pendingNotifications(f.agent.id));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].plan_id, unrelated.plan_id);
});

for (const method of ['move', 'organize']) {
  for (const category of ['backlog', 'blocked', 'para-o-dono']) {
    test(`pending tasks approval cannot execute after ${method} to ${category}`, async t => {
      const f = await fixture(t);
      const plan = await f.stage();
      await f.store(s => s.decide({ ...plan, decision: 'approve', owner_session_id: f.agent.id,
        recipient_session_id: f.agent.id }), true);
      await f.store(s => s[method]({ plan_id: plan.plan_id, expected_revision: plan.revision,
        hash: plan.hash, category, owner_session_id: f.agent.id,
        origin: { session_id: f.agent.id, call_id: `move-${category}` } }), true);
      const pending = await f.store(s => s.pendingNotifications(f.agent.id));
      assert.equal(pending[0].action, 'superseded');
      assert.equal(pending[0].execution_authorized, false);
      assert.equal(await f.plugin.deliver(f.agent), false);
      assert.equal(f.state.sends.length, 0, 'obsolete approval must not instruct implementation or wake the agent');
      assert.equal(f.state.resumes.length, 0);
      assert.deepEqual(await f.store(s => s.pendingNotifications(f.agent.id)), []);
    });
  }
}

test('ack failure after durable delivery recovers without duplicate message or goal resume', async t => {
  const f = await fixture(t);
  const plan = await f.stage();
  const ack = PlanStore.prototype.ackNotification;
  let attempts = 0;
  PlanStore.prototype.ackNotification = async function () {
    attempts++;
    throw new Error('Injected acknowledgment interruption');
  };
  try {
    const interrupted = await f.ui(plan);
    assert.equal(interrupted.result.kind, 'error');
    assert.equal(attempts, 1);
  } finally { PlanStore.prototype.ackNotification = ack; }
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.resumes.length, 0);
  const pending = await f.store(s => s.pendingNotifications(f.agent.id));
  assert.equal(pending.length, 1);
  assert.ok(f.projection(f.agent.session, 'managedPlanDelivery').ids.includes(pending[0].notification_id));
  for (const writer of f.plugin.writers.values()) writer.dispose();
  f.plugin.writers.clear();
  assert.equal(await f.plugin.deliver(f.agent), true);
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.resumes.length, 0);
  assert.equal(f.state.goal.phase, 'paused');
  assert.deepEqual(await f.store(s => s.pendingNotifications(f.agent.id)), []);
});

for (const operation of ['get', 'resume']) {
  test(`native goal ${operation} failure cannot roll back human tasks approval`, async t => {
    const f = await fixture(t);
    const plan = await f.stage();
    let attempts = 0;
    f.ctx.get('goals')[operation] = () => { attempts++; throw new Error('PRIVATE_NATIVE_DETAILS'); };
    const approved = await f.ui(plan);
    assert.equal(approved.result.kind, 'success', approved.result.text);
    assert.equal(approved.data.goal_resume.status, 'failed');
    assert.doesNotMatch(approved.data.goal_resume.message, /PRIVATE_NATIVE_DETAILS/);
    assert.equal(attempts, 1, 'native failures must not trigger recapture or retry');
    assert.equal((await f.store(s => s.read(plan.plan_id))).status, 'approved');
    assert.equal(f.state.resumes.length, 0);
  });
}

test('flush failure before notice ack never resumes; delivery receipt prevents duplicate retry', async t => {
  const f = await fixture(t);
  const plan = await f.stage();
  f.state.hook = () => { throw new Error('Injected flush interruption before acknowledgment'); };
  const interrupted = await f.ui(plan);
  assert.equal(interrupted.result.kind, 'error');
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.resumes.length, 0);
  assert.equal((await f.store(s => s.read(plan.plan_id))).status, 'approved');
  const pending = await f.store(s => s.pendingNotifications(f.agent.id));
  assert.equal(pending.length, 1);
  assert.ok(f.projection(f.agent.session, 'managedPlanDelivery').ids.includes(pending[0].notification_id));
  // Reopen the real project store while preserving the native inbox receipt cut.
  for (const writer of f.plugin.writers.values()) writer.dispose();
  f.plugin.writers.clear();
  f.state.hook = null;
  assert.equal(await f.plugin.deliver(f.agent), true);
  assert.equal(f.state.sends.length, 1, 'already-queued notice must not be duplicated');
  assert.deepEqual(await f.store(s => s.pendingNotifications(f.agent.id)), []);
  assert.equal(f.state.resumes.length, 0, 'background recovery must not acquire human resume authority');
  assert.equal(f.state.goal.phase, 'paused');
});

for (const phase of ['paused', 'blocked']) {
  test(`native GoalService smoke resumes a private ${phase} goal through human CommandRuntime`, async t => {
    const f = await fixture(t, { nativeGoals: true });
    const goals = f.ctx.get('goals');
    assert.ok(goals instanceof GoalService);
    assert.ok(f.ctx.goals instanceof GoalService, 'the native context alias exposes the goal service');
    const created = goals.create(f.agent, { objective: 'Isolated native goal smoke', maxGoalRounds: 9 });
    const stopped = phase === 'paused' ? goals.pause(f.agent, created)
      : goals.block(f.agent, created, { code: 'approval-smoke', message: 'Private test approval wait.' });
    assert.equal(stopped.phase, phase);
    assert.equal(stopped.activation, 'disarmed');
    assert.deepEqual(f.ctx.goals.get(f.agent), goals.get(f.agent), 'both Cordis proxy routes read the same state');
    assert.throws(() => goals.get({ ...f.agent }), error => error.code === 'GOAL_AGENT_NOT_LIVE');
    // The adapter drives the native service's own registered strict goal fold.
    // Only the owning private session has these events; no round driver exists.
    assert.equal(f.projection(f.agent.session, 'goal').failure, null);
    const approved = await f.ui(await f.stage());
    assert.equal(approved.result.kind, 'success', approved.result.text);
    assert.equal(approved.data.goal_resume.status, 'resumed');
    const resumed = goals.get(f.agent);
    assert.equal(resumed.id, stopped.id);
    assert.equal(resumed.revision, stopped.revision + 1);
    assert.equal(resumed.phase, 'active');
    assert.equal(resumed.activation, 'armed');
    assert.equal(resumed.blockedReason, undefined);
    assert.equal(resumed.objective, stopped.objective);
    assert.equal(resumed.roundsStarted, stopped.roundsStarted);
    assert.equal(resumed.maxGoalRounds, stopped.maxGoalRounds);
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.state.sends[0].wake, false);
    const events = f.agent.session.events;
    const receipt = events.findIndex(event => event.type === 'agent/inbox/spliced');
    const resume = events.findIndex(event => event.type === 'goal/change' && event.data.operation === 'resume');
    assert.ok(resume > receipt && receipt >= 0);
    assert.equal(f.projection(f.agent.session, 'goal').current.goal.revision, resumed.revision);
  });
}
