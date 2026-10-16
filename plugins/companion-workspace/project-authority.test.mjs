import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkspaceGuard } from './index.mjs';
import { fixture } from '../session-create/fixtures.mjs';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

async function guardedFixture() {
  const value = await fixture();
  const result = await value.run({ target: { kind: 'new_project', name: 'Scoped' } });
  assert.equal(result.status, 'completed');
  const agent = value.agents.get(result.session_id);
  const policy = { mode: 'workspace-write', workspaceRoot: agent.session.header.cwd };
  const guards = [], handlers = new Map(), disposers = [];
  const ctx = {
    get: name => ({ sandboxPolicy: { resolve: () => policy }, sandbox: { confine: async () => ({ enforcement: 'full' }) }, shell: { sandboxMode: 'workspace-write' }, sessionCreateAuthority: value.authority.public })[name],
    effect(callback) { disposers.push(callback()); },
    tools: { guard(callback) { guards.push(callback); } },
    on(name, callback) { handlers.set(name, callback); },
  };
  installWorkspaceGuard(ctx, { profile: 'companion' }, Symbol('native preset'));
  const exec = (name = 'write', arguments_ = { file_path: join(policy.workspaceRoot, 'own.txt'), content: 'owned' }) => ({ name, arguments: arguments_, agent, signal: new AbortController().signal });
  return { ...value, result, agent, policy, ctx, guards, handlers, disposers, exec };
}
test('child authority requires per-execution async path preflight and rejects skipped hook, forged arguments, legacy incarnation', async () => {
  const f = await guardedFixture();
  const call = f.exec(); assert.equal(f.guards[0](call), 'workspace-session-scope-denied');
  assert.equal((await f.handlers.get('tools/pre-execute')(call, async () => ({ kind: 'allow' }))).kind, 'allow');
  assert.equal(f.guards[0](call), undefined);
  const forged = f.exec('write', { content: 'own', confirmed: true, sandbox_permissions: 'workspace-write' });
  assert.equal((await f.handlers.get('tools/pre-execute')(forged, async () => ({ kind: 'allow' }))).kind, 'deny');
  const legacy = { ...f.exec(), agent: { ...f.agent } };
  assert.equal((await f.handlers.get('tools/pre-execute')(legacy, async () => ({ kind: 'allow' }))).kind, 'deny');
});
test('inode drift WHILE Bash approval is pending is denied by final synchronous guard, with zero payloads', async () => {
  const f = await guardedFixture();
  const call = f.exec('bash', { command: 'printf never-dispatched', description: 'Never executed', workdir: f.policy.workspaceRoot });
  assert.equal((await f.handlers.get('tools/pre-execute')(call, async () => ({ kind: 'allow' }))).kind, 'ask');
  // Emulate the long native approval wait after BOTH asynchronous validations.
  await rename(f.policy.workspaceRoot, `${f.policy.workspaceRoot}-old`); await mkdir(f.policy.workspaceRoot);
  const outcome = 'allowed-once'; let payloads = 0;
  const denied = f.guards.map(guard => guard(call)).find(reason => reason !== undefined);
  if (outcome === 'allowed-once' && !denied) payloads++;
  assert.equal(denied, 'workspace-session-scope-denied'); assert.equal(payloads, 0);
});
test('approved child Bash still always asks with exact scoped cwd/literal, rejects foreign workdir and inode drift', async () => {
  const f = await guardedFixture();
  const literal = 'printf "authored literal"\n# full trailing text';
  for (let index = 0; index < 2; index++) {
    const call = f.exec('bash', { command: literal, description: 'Synthetic never-dispatched Bash', workdir: f.policy.workspaceRoot });
    const decision = await f.handlers.get('tools/pre-execute')(call, async () => assert.fail('Bash must not delegate to allow'));
    assert.equal(decision.kind, 'ask'); assert.ok(decision.reason.includes(f.policy.workspaceRoot)); assert.ok(decision.reason.endsWith(literal));
  }
  const foreign = f.exec('bash', { command: 'pwd', description: 'no', workdir: f.root });
  assert.match((await f.handlers.get('tools/pre-execute')(foreign, async () => ({ kind: 'allow' }))).reason, /^workspace-cwd-denied: /);
  await rename(f.policy.workspaceRoot, `${f.policy.workspaceRoot}-old`); await mkdir(f.policy.workspaceRoot);
  const drift = await f.handlers.get('tools/pre-execute')(f.exec(), async () => ({ kind: 'allow' }));
  assert.match(drift.reason, /^workspace-(project-authority-changed|session-scope-denied)$/);
});
