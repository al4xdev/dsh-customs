import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, load } from './native-fixture.mjs';
import { MockSink } from './mock-sink.mjs';
import * as notifications from './index.mjs';
const ref = goal => ({ id: goal.id, revision: goal.revision });

test('actual SDK delegated Agent completion and seeded replay never notify the root Companion', async () => {
  const f = await fixture();
  try {
    const root = (await f.create()).agent;
    const child = (await f.create('companion', { parentAgent: root, meta: { origin: 'subagent', delegationDepth: 1 } })).agent;
    const delegated = f.app.goals.create(child, { objective: 'owned delegated service fixture; not delegated tool authority' });
    f.app.goals.complete(child, ref(delegated));
    const sink = new MockSink(f.profileDirectory);
    assert.equal(sink.read().events.length, 0);
    let goal = f.app.goals.create(root, { objective: 'owned completed source for replay' });
    goal = f.app.goals.complete(root, ref(goal));
    assert.equal(sink.read().events.length, 1);
    const seed = root.session.snapshotEvents();
    const { SessionLogOffset } = await load('dsh-session');
    const fork = (await f.create('companion', { seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: root.id, isSeeded: true } })).agent;
    assert.equal(f.app.goals.get(fork).id, goal.id);
    assert.equal(f.app.goals.get(fork).activation, 'disarmed');
    assert.equal(sink.read().events.length, 1, 'replay itself has no completion edge');
    const { agentEvents } = await load('dsh-agent');
    agentEvents(f.app, fork).emit('goal/changed', { agent: fork, change: { operation: 'complete', ref: ref(goal), goal: f.app.goals.get(fork) } });
    assert.equal(sink.read().events.length, 1);
    assert.equal(f.modelCalls, 0);
  } finally { await f.close(); }
});

test('non-Companion runtime rejects a companion string even with an actual SDK scope', async () => {
  const [{ Context }, { createScope }] = await Promise.all([load('cordis'), load('dsh-scope')]);
  const ctx = new Context();
  const f = await fixture({ installed: false });
  try {
    ctx.provide('profileContext', { name: 'dsh-tui', dir: f.profileDirectory });
    const owned = createScope(ctx, {});
    await assert.rejects(notifications.apply(owned.ctx, { profile: 'companion' }), /companion profile/);
    await assert.rejects(access(join(f.profileDirectory, 'companion-notifications')), { code: 'ENOENT' });
  } finally { await ctx.fiber.dispose(); await f.close(); }
});
