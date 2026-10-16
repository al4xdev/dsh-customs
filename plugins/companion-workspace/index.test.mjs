import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkspaceGuard } from './index.mjs';
import { WORKSPACE_ROOT } from './guard-policy.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture({ enforcement = 'full', unavailable = false } = {}) {
  let policy = { mode: 'workspace-write', workspaceRoot: WORKSPACE_ROOT };
  const stages = [], guards = [], handlers = new Map(), disposers = [];
  let serviceReads = 0, registrations = 0, bodies = 0, asks = 0;
  const services = {
    sandboxPolicy: { resolve: () => policy },
    sandbox: { async confine(argv, resolved, signal) {
      stages.push({ stage: 'confine', argv: [...argv], policy: { ...resolved }, signal });
      if (unavailable) throw new Error('opaque private diagnostic must not leak');
      return { argv: ['synthetic-runner', '--', ...argv], enforcement };
    } },
    shell: { sandboxMode: 'workspace-write' },
  };
  const ctx = {
    get(name) { serviceReads++; return services[name]; },
    tools: {
      register() { registrations++; },
      guard(fn) { guards.push(fn); const dispose = () => guards.splice(guards.indexOf(fn), 1); disposers.push(dispose); return dispose; },
    },
    on(name, fn) { handlers.set(name, fn); const dispose = () => handlers.delete(name); disposers.push(dispose); return dispose; },
  };
  const exec = (command = 'pwd') => ({ name: 'bash', arguments: Object.freeze({ command, description: 'Show working directory' }),
    agent: { session: { header: Object.freeze({ agentPreset: 'companion', cwd: WORKSPACE_ROOT }) } }, signal: new AbortController().signal });
  const mount = () => installWorkspaceGuard(ctx, { profile: 'companion' }, Symbol('preset-scope'));
  // Emulates only the documented native ask->guard->body contract. No SDK
  // runtime, shell, filesystem, network or backend instance is constructed.
  const run = async (call, answer) => {
    const decision = await handlers.get('tools/pre-execute')(call, async () => ({ kind: 'allow' }));
    if (decision.kind !== 'ask') return decision;
    asks++; stages.push({ stage: 'ask', decision });
    const outcome = await answer(decision);
    if (outcome !== 'allowed-once' || call.signal.aborted) return { kind: 'deny' };
    const denied = guards.map(fn => fn(call)).find(reason => reason !== undefined);
    if (denied) return { kind: 'deny', reason: denied };
    bodies++; stages.push({ stage: 'body' });
    return { kind: 'body' };
  };
  return { ctx, services, stages, guards, handlers, mount, exec, run,
    setPolicy(value) { policy = value; }, dispose() { disposers.splice(0).reverse().forEach(fn => fn()); },
    counts: () => ({ serviceReads, registrations, bodies, asks }) };
}

test('root/wrong-profile mount fails before services or effects and registers no tools', () => {
  const value = fixture();
  assert.throws(() => installWorkspaceGuard(value.ctx, { profile: 'companion' }, undefined));
  assert.throws(() => installWorkspaceGuard(value.ctx, { profile: 'ordinary' }, Symbol('scope')));
  assert.deepEqual(value.counts(), { serviceReads: 0, registrations: 0, bodies: 0, asks: 0 });
  value.mount();
  assert.equal(value.counts().registrations, 0);
  assert.equal(value.handlers.size, 1);
  value.dispose();
  assert.equal(value.handlers.size, 0);
  assert.equal(value.guards.length, 0);
});

test('Bash preflight and full native ask precede any body; allowed-once never promotes mode', async () => {
  const value = fixture(); value.mount();
  const entered = deferred(), answer = deferred();
  const command = 'pwd\nprintf "trailing literal\\n"';
  const call = value.exec(command);
  const running = value.run(call, async decision => { entered.resolve(decision); return answer.promise; });
  const question = await entered.promise;
  assert.equal(question.kind, 'ask');
  assert.ok(question.reason.endsWith(command));
  assert.deepEqual(value.stages[0].argv, ['bash', '-c', command]);
  assert.equal(value.stages[0].policy.mode, 'workspace-write');
  assert.equal(value.counts().bodies, 0);
  answer.resolve('allowed-once');
  assert.equal((await running).kind, 'body');
  assert.equal(value.counts().bodies, 1);
  assert.equal(value.guards[0](call), undefined);
  assert.equal(value.services.sandboxPolicy.resolve().mode, 'workspace-write');
});

test('repeated identical readonly command still requires another explicit decision', async () => {
  const value = fixture(); value.mount();
  await value.run(value.exec(), async () => 'allowed-once');
  await value.run(value.exec(), async () => 'rejected');
  assert.equal(value.counts().asks, 2);
  assert.equal(value.counts().bodies, 1);
});

test('all non-grants produce no body and no approval fallback automatically allows', async () => {
  const value = fixture(); value.mount();
  for (const outcome of ['rejected', 'cancelled', 'unavailable', undefined, 'allow']) {
    assert.equal((await value.run(value.exec(), async () => outcome)).kind, 'deny');
  }
  assert.equal(value.counts().bodies, 0);
});

test('partial or unavailable native confinement denies before question or body', async () => {
  for (const options of [{ enforcement: 'partial' }, { unavailable: true }]) {
    const value = fixture(options); value.mount();
    const result = await value.run(value.exec(), async () => { assert.fail('must not ask'); });
    assert.equal(result.kind, 'deny');
    assert.ok(!result.reason.includes('private'));
    assert.equal(value.counts().asks, 0);
    assert.equal(value.counts().bodies, 0);
  }
});

test('cancel during pending question defeats even a late allowed-once', async () => {
  const value = fixture(); value.mount();
  const entered = deferred(), answer = deferred(), controller = new AbortController();
  const running = value.run({ ...value.exec(), signal: controller.signal }, async () => { entered.resolve(); return answer.promise; });
  await entered.promise;
  controller.abort(); answer.resolve('allowed-once');
  assert.equal((await running).kind, 'deny');
  assert.equal(value.counts().bodies, 0);
});

test('changed standing mode after question is denied by real native guard contract', async () => {
  const value = fixture(); value.mount();
  const result = await value.run(value.exec(), async () => {
    value.setPolicy({ mode: 'danger-full-access', workspaceRoot: WORKSPACE_ROOT });
    return 'allowed-once';
  });
  assert.equal(result.reason, 'workspace-policy-denied');
  assert.equal(value.counts().bodies, 0);
});

test('other tools preserve next while guarded FS rejects foreign scope and escalation', async () => {
  const value = fixture(); value.mount();
  let nextCalls = 0;
  const next = async () => { nextCalls++; return { kind: 'allow' }; };
  const hook = value.handlers.get('tools/pre-execute');
  assert.equal((await hook({ name: 'session' }, next)).kind, 'allow');
  assert.equal((await hook({ ...value.exec(), name: 'write', arguments: { file_path: 'report.json', content: { sandbox_permissions: 'literal data' } } }, next)).kind, 'allow');
  assert.equal((await hook({ ...value.exec(), name: 'write', arguments: { sandbox_permissions: 'workspace-write' } }, next)).kind, 'deny');
  assert.equal((await hook({ ...value.exec(), agent: undefined }, next)).kind, 'deny');
  assert.equal(nextCalls, 2);
  assert.equal(value.stages.length, 0);
});

test('a middleware skipping this Bash hook cannot bypass its final guard', () => {
  const value = fixture(); value.mount();
  assert.equal(value.guards[0](value.exec()), 'workspace-bash-approval-required');
});

test('invalid preview never reaches enforcement setup, ask or body', async () => {
  const value = fixture(); value.mount();
  const call = value.exec('x'.repeat(65537));
  assert.equal((await value.run(call, async () => { assert.fail('must not ask'); })).kind, 'deny');
  assert.equal(value.stages.length, 0);
  assert.equal(value.counts().bodies, 0);
});
