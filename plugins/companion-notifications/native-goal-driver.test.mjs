import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, load } from './native-fixture.mjs';
import { MockSink } from './mock-sink.mjs';

const ref = goal => ({ id: goal.id, revision: goal.revision });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function deadline(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('own SDK fixture deadline')), 3000); })]); }
  finally { clearTimeout(timer); }
}

test('actual native driver queues exact source on human rearm; complete-vs-await race rejects stale round without model', { timeout: 15000 }, async () => {
  const f = await fixture({ driver: true });
  const entered = deferred(), release = deferred();
  try {
    const { agent } = await f.create();
    const scope = await load('dsh-scope');
    agent.ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.messages.some(m => m.source.kind === 'goal')) { entered.resolve(payload); await release.promise; }
      return next();
    });
    let goal = f.app.goals.create(agent, { objective: 'own no-model continuation race', maxGoalRounds: 4 });
    // This is a native disarm edge, not a shadow state. No model can run while the gate is held.
    f.app.goals.disarm(agent);
    assert.equal(f.app.goals.get(agent).activation, 'disarmed');
    goal = f.app.goals.resume(agent, ref(goal));
    assert.equal(goal.activation, 'armed'); assert.equal(goal.revision, 2);
    const payload = await deadline(entered.promise);
    const message = payload.messages.find(m => m.source.kind === 'goal');
    assert.deepEqual(message.source, { kind: 'goal', goalId: goal.id, revision: goal.revision, round: 1 });
    assert.ok(message.content[0].text.includes('<goal_round>'));
    assert.equal(f.app.goals.get(agent).roundsStarted, 0, 'queued is NOT admitted continuation proof');
    const complete = f.app.goals.complete(agent, ref(goal));
    release.resolve(); await deadline(agent.whenIdle());
    assert.equal(f.app.goals.get(agent).phase, 'complete');
    assert.equal(f.app.goals.get(agent).revision, complete.revision);
    assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'goal').length, 0);
    assert.equal(new MockSink(f.profileDirectory).read().events.length, 1);
    assert.equal(f.modelCalls, 0);
    const tools = f.app.tools.schemas(agent).map(t => t.name);
    assert.ok(['get_goal', 'create_goal', 'update_goal'].every(name => tools.includes(name)));
    const { ToolCallId } = await load('dsh-llm');
    const rejected = await f.app.tools.execute({ name: 'create_goal', callId: ToolCallId('own-outside-driver'), arguments: { objective: 'must reject' }, agent, signal: new AbortController().signal });
    assert.equal(rejected.isError, true); assert.match(JSON.stringify(rejected), /GOAL_TOOL_DRIVER_REQUIRED/);
    assert.equal(scope.scopeOf(agent.ctx), agent);
  } finally { release.resolve(); await f.close(); }
});

test('actual instructions plugin loads proposal from immutable session cwd before model; scoped source is agent-instructions', { timeout: 10000 }, async () => {
  const f = await fixture({ installed: false, instructions: true });
  try {
    const proposal = await readFile('.dumps/tasks/task99-AGENTS.proposal.md', 'utf8');
    await writeFile(join(f.cwd, 'AGENTS.md'), proposal);
    const { agent } = await f.create();
    const { createUserMessage } = await load('dsh-llm');
    const { agentEvents } = await load('dsh-agent');
    const message = createUserMessage({ content: [{ type: 'text', text: 'owned loading fixture' }], source: { kind: 'user' } });
    const decision = await agentEvents(f.app, agent).waterfall('agent/pre-step', { messages: [message], turn: 1, step: 1, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter', messages: [message] }));
    const instruction = decision.messages.find(m => m.source.kind === 'agent-instructions');
    assert.ok(instruction); assert.equal(instruction.source.baseline, true);
    assert.ok(instruction.content[0].text.includes('Instructions from: AGENTS.md'));
    assert.ok(instruction.content[0].text.includes(proposal));
    assert.ok(instruction.source.changes.some(change => change.path === 'AGENTS.md' && change.action === 'set'));
    assert.equal(f.modelCalls, 0);
    // The PUBLIC discovery function evaluates the real future Companion cwd without reading global content.
    const instructions = await load('dsh-agent-instructions');
    const discovered = await instructions.discoverBaselineInstructionFiles({ cwd: '/home/alex/git/my/dsh-companion-workspace', dshHome: join(f.root, 'empty-home') });
    assert.equal(discovered.some(row => row.absolutePath === '/home/alex/git/my/dsh-companion-workspace/AGENTS.md'), false, 'absent today; executor must install reviewed proposal before claiming live loading');
  } finally { await f.close(); }
});
