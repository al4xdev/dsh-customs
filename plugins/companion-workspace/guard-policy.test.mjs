import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMount, bashDecision, guardReason, GUARDED_TOOLS, MAX_COMMAND_BYTES, WORKSPACE_ROOT } from './guard-policy.mjs';

const policy = () => ({ mode: 'workspace-write', workspaceRoot: WORKSPACE_ROOT });
const exec = (name = 'bash', args = {}) => ({ name, arguments: { command: 'pwd', description: 'Show working directory', ...args },
  agent: { session: { header: { agentPreset: 'companion', cwd: WORKSPACE_ROOT } } }, signal: new AbortController().signal });

test('mount rejects root and wrong profiles before any registration', () => {
  assert.throws(() => assertMount('companion', undefined));
  assert.throws(() => assertMount('ordinary', Symbol('scope')));
  assert.doesNotThrow(() => assertMount('companion', Symbol('scope')));
});

test('all exact native guarded names require the same session and policy', () => {
  for (const name of GUARDED_TOOLS) {
    assert.equal(guardReason(exec(name), policy()), undefined);
    const foreign = exec(name); foreign.agent.session.header.agentPreset = 'ordinary';
    assert.equal(guardReason(foreign, policy()), 'workspace-session-scope-denied');
    assert.equal(guardReason(exec(name), { ...policy(), mode: 'danger-full-access' }), 'workspace-policy-denied');
  }
  assert.equal(guardReason({ name: 'session' }, undefined), undefined);
});

test('absent agent, foreign cwd, malformed args and missing policy fail closed', () => {
  assert.equal(guardReason({ ...exec(), agent: undefined }, policy()), 'workspace-session-scope-denied');
  const foreign = exec(); foreign.agent.session.header.cwd = '/synthetic/other';
  assert.equal(guardReason(foreign, policy()), 'workspace-session-scope-denied');
  assert.equal(guardReason(exec(), { ...policy(), workspaceRoot: '/synthetic/other' }), 'workspace-policy-denied');
  assert.equal(guardReason(exec(), undefined), 'workspace-policy-denied');
  for (const args of [null, [], 'pwd']) assert.equal(guardReason({ ...exec(), arguments: args }, policy()), 'workspace-arguments-invalid');
});

test('host reads accept legacy companion cwd without widening any mutation boundary', () => {
  for (const name of ['read', 'read_image', 'list']) {
    const call = exec(name, { file_path: '/synthetic/host/outside-project.txt' });
    call.agent.session.header.cwd = '/synthetic/legacy-repo';
    for (const mode of ['read-only', 'workspace-write']) assert.equal(guardReason(call, { mode, workspaceRoot: '/synthetic/legacy-repo' }), undefined);
    assert.equal(guardReason(call, undefined), 'workspace-policy-denied');
    assert.equal(guardReason(call, { mode: 'danger-full-access' }), 'workspace-policy-denied');
    assert.equal(guardReason({ ...call, arguments: { sandbox_permissions: 'workspace-write' } }, policy()), 'workspace-escalation-denied');
  }
  for (const name of ['write', 'edit', 'bash']) {
    const call = exec(name); call.agent.session.header.cwd = '/synthetic/legacy-repo';
    assert.equal(guardReason(call, { mode: 'workspace-write', workspaceRoot: '/synthetic/legacy-repo' }), 'workspace-session-scope-denied');
  }
});

test('own privileged fields are rejected even if unadvertised, null, false or same mode', () => {
  for (const name of GUARDED_TOOLS) {
    for (const value of ['workspace-write', 'danger-full-access', null, false, undefined]) {
      assert.equal(guardReason(exec(name, { sandbox_permissions: value }), policy()), 'workspace-escalation-denied');
    }
    assert.equal(guardReason(exec(name, { justification: 'Do not promote' }), policy()), 'workspace-escalation-denied');
    assert.equal(guardReason(exec(name, { sandboxPolicy: policy() }), policy()), 'workspace-escalation-denied');
  }
});

test('normal unicode/JSON content and unknown business fields are not capability controls', () => {
  const call = exec('write', { text: '{"sandbox_permissions":"dados"} — café', extraPaths: ['a', 'b'], content: { justification: 'literal data' } });
  assert.equal(guardReason(call, policy()), undefined);
});

test('every readonly or identical Bash call asks; model summaries are never preview authority', () => {
  for (const command of ['pwd', 'true', 'pwd']) {
    const decision = bashDecision(exec('bash', { command, description: 'MODEL SUMMARY NOT AUTHORITY' }), policy());
    assert.equal(decision.kind, 'ask');
    assert.ok(decision.reason.includes(`CWD: ${WORKSPACE_ROOT}`));
    assert.ok(decision.reason.endsWith(`Comando literal completo:\n${command}`));
    assert.ok(!decision.reason.includes('MODEL SUMMARY'));
  }
});

test('full multiline body, trailing command, substitutions and unicode survive literally', () => {
  const command = 'printf "café\\n" | sed s/a/b/\n\n# trailing line\nprintf "%s" "$(pwd)" > relatório.txt\n';
  assert.ok(bashDecision(exec('bash', { command }), policy()).reason.endsWith(command));
});

test('command bound is UTF-8 bytes, no silent truncation or empty/NUL preview', () => {
  const exact = 'á'.repeat(MAX_COMMAND_BYTES / 2);
  assert.equal(bashDecision(exec('bash', { command: exact }), policy()).kind, 'ask');
  for (const command of [exact + 'a', ' '.repeat(3), '', 'pwd\0true', undefined, 1]) {
    assert.equal(bashDecision(exec('bash', { command }), policy()).kind, 'deny');
  }
});

test('fixed omitted/exact cwd works; foreign and relative cwd never execute under false preview', () => {
  assert.equal(bashDecision(exec(), policy()).kind, 'ask');
  assert.equal(bashDecision(exec('bash', { workdir: WORKSPACE_ROOT }), policy()).kind, 'ask');
  for (const workdir of ['.', '..', '/synthetic/other', null]) {
    assert.equal(bashDecision(exec('bash', { workdir }), policy()).reason, 'workspace-cwd-denied');
  }
});

test('foreground settings and required native Bash types are checked before asking', () => {
  assert.equal(bashDecision(exec('bash', { run_in_background: false, timeoutMs: 100 }), policy()).kind, 'ask');
  for (const args of [{ run_in_background: true }, { run_in_background: 'false' }, { timeoutMs: 0 },
    { timeoutMs: Infinity }, { timeoutMs: '100' }, { description: '' }]) {
    assert.equal(bashDecision(exec('bash', args), policy()).kind, 'deny');
  }
});

test('aborted calls cannot grant and non-Bash does not invent an ask', () => {
  const controller = new AbortController(); controller.abort();
  assert.equal(guardReason({ ...exec(), signal: controller.signal }, policy()), 'workspace-call-cancelled');
  assert.equal(bashDecision(exec('write'), policy()).kind, 'deny');
});
