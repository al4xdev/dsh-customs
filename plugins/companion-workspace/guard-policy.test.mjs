import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertMount, bashDecision, denialCode, ESCALATION_DENIED, guardReason, GUARDED_TOOLS, MAX_COMMAND_BYTES, WORKSPACE_ROOT } from './guard-policy.mjs';

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
    assert.equal(guardReason({ ...call, arguments: { sandbox_permissions: 'workspace-write' } }, policy()), ESCALATION_DENIED);
  }
  for (const name of ['write', 'edit', 'bash']) {
    const call = exec(name); call.agent.session.header.cwd = '/synthetic/legacy-repo';
    assert.equal(guardReason(call, { mode: 'workspace-write', workspaceRoot: '/synthetic/legacy-repo' }), 'workspace-session-scope-denied');
  }
});

test('own privileged fields are rejected even if unadvertised, null, false or same mode', () => {
  for (const name of GUARDED_TOOLS) {
    for (const value of ['workspace-write', 'danger-full-access', null, false, undefined]) {
      assert.equal(guardReason(exec(name, { sandbox_permissions: value }), policy()), ESCALATION_DENIED);
    }
    assert.equal(guardReason(exec(name, { justification: 'Do not promote' }), policy()), ESCALATION_DENIED);
    assert.equal(guardReason(exec(name, { sandboxPolicy: policy() }), policy()), ESCALATION_DENIED);
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
    assert.ok(decision.reason.endsWith(`Comando (literal completo):\n${command}`));
    assert.ok(decision.reason.includes(`Comando: ${Buffer.byteLength(command)} bytes UTF-8, sha256 ${createHash('sha256').update(command).digest('hex')}`));
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
    const { reason } = bashDecision(exec('bash', { workdir }), policy());
    assert.equal(denialCode(reason), 'workspace-cwd-denied');
    assert.ok(reason.includes(WORKSPACE_ROOT) && /Omit workdir/.test(reason) && /cd <subdirectory>/.test(reason));
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

test('A5: escalation denial is actionable text, never a bare code inviting another retry', () => {
  assert.equal(denialCode(ESCALATION_DENIED), 'workspace-escalation-denied');
  for (const phrase of [/never widens/, /Do not retry/, /owner \(human\)/, /sandbox_permissions/]) assert.match(ESCALATION_DENIED, phrase);
  assert.equal(bashDecision(exec('bash', { sandbox_permissions: 'danger-full-access', justification: 'needs it' }), policy()).reason, ESCALATION_DENIED);
});

test('A4: Bash refuses smuggling characters and shows rare invisible ones escaped with size and digest', () => {
  for (const command of ['echo ok\u202E', 'echo \u{E0041}', 'echo a\rb', 'echo \u001b[2J', 'echo \u2066x']) {
    const decision = bashDecision(exec('bash', { command }), policy());
    assert.equal(decision.kind, 'deny'); assert.equal(denialCode(decision.reason), 'workspace-command-invisible-character');
    assert.match(decision.reason, /U\+[0-9A-F]{4}/);
  }
  const command = 'echo "zero\u200bwidth"\nls\t-la';
  const decision = bashDecision(exec('bash', { command }), policy());
  assert.equal(decision.kind, 'ask'); assert.ok(!decision.reason.includes('\u200b'));
  assert.match(decision.reason, /ATENÇÃO: 1 caractere/);
  assert.equal(JSON.parse(decision.reason.slice(decision.reason.lastIndexOf('\n') + 1)), command);
});

test('portable dedicated root follows HOME instead of a fixed user directory', () => {
  assert.equal(WORKSPACE_ROOT, join(homedir(), 'git/my/dsh-companion-workspace'));
});
