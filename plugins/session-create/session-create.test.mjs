import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, symlink, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, MAX_TEXT_BYTES, hash } from './contracts.mjs';
import { fixture } from './fixtures.mjs';
import { publicResult, OperationStore } from './operation-store.mjs';
import { callerKey } from './preflight.mjs';
import { createHash } from 'node:crypto';

const absent = path => assert.rejects(access(path), { code: 'ENOENT' });
test('closed parser/default empty; literal bounds; no fake grants/escalation/unknown keys', () => {
  const input = { operation: 'create', request: { version: 1, owner_intent: 'owner' } };
  assert.equal(parseArgs(input).request.delivery.mode, 'empty');
  assert.equal(parseArgs(input).request.target.kind, 'current');
  for (const extra of ['confirmed', 'grant', 'sandbox_permissions', 'workspaceRoot']) {
    assert.throws(() => parseArgs({ ...input, [extra]: true }));
    assert.throws(() => parseArgs({ ...input, request: { ...input.request, [extra]: true } }));
  }
  assert.throws(() => parseArgs({ ...input, request: { ...input.request, delivery: { mode: 'empty', text: 'not a draft' } } }));
  assert.throws(() => parseArgs({ ...input, request: { ...input.request, delivery: { mode: 'submit', text: ' ' } } }));
  assert.throws(() => parseArgs({ ...input, request: { ...input.request, delivery: { mode: 'submit', text: 'é'.repeat(MAX_TEXT_BYTES) } } }));
  for (const name of ['..', 'bad/name', ' leading', 'x\u202e']) assert.throws(() => parseArgs({ ...input, request: { ...input.request, target: { kind: 'new_project', name } } }));
});
for (const outcome of ['rejected', 'cancelled', 'unavailable', 'allowed-always', undefined]) test(`native ${String(outcome)} has zero business effects and no ledger`, async () => {
  const f = await fixture(); f.ctx.answer = async req => {
    assert.equal(f.effects.create + f.effects.project + f.effects.submit, 0);
    await absent(join(f.root, 'projects')); await absent(f.store.root);
    assert.match(req.reason, /CRIAR E ENVIAR AGORA/); assert.ok(req.reason.includes('literal\\nlinha2'));
    return outcome;
  };
  const result = await f.run({ target: { kind: 'new_project', name: 'Novo' }, delivery: { mode: 'submit', text: 'literal\nlinha2' } });
  assert.match(result.code, /^approval_/);
  assert.equal(f.effects.create + f.effects.project + f.effects.submit, 0); await absent(join(f.root, 'projects')); await absent(f.store.root);
});
test('A4: tags, bidi, CR and controls are refused before approval in every text field', async () => {
  const f = await fixture();
  for (const bad of ['tag\u{E0041}', 'bidi\u202e', 'iso\u2069', 'esc\u001b', 'cr\rx', 'pua\uE000']) {
    assert.throws(() => parseArgs({ operation: 'create', request: { version: 1, owner_intent: 'ok', delivery: { mode: 'submit', text: bad } } }), { code: 'invalid_text' });
    assert.throws(() => parseArgs({ operation: 'create', request: { version: 1, owner_intent: `intent ${bad}` } }));
  }
  assert.equal(f.effects.asks, 0);
});
test('submit CRLF is normalized to LF before approval, hash and delivery; a lone CR is refused', async () => {
  const f = await fixture(); let preview;
  f.ctx.answer = async req => { preview = JSON.parse(req.reason.slice(req.reason.indexOf('\n') + 1)); return 'allowed-once'; };
  const parsed = parseArgs({ operation: 'create', request: { version: 1, owner_intent: 'ok', delivery: { mode: 'submit', text: 'um\r\ndois\r\n' } } });
  assert.equal(parsed.request.delivery.text, 'um\ndois\n');
  assert.equal((await f.run({ delivery: { mode: 'submit', text: 'um\r\ndois\r\n' } })).status, 'completed');
  assert.equal(preview.initial_text_full, 'um\ndois\n'); assert.equal(preview.initial_text_sha256, createHash('sha256').update('um\ndois\n').digest('hex'));
  assert.equal(f.ctx.promptRequest.content[0].text, 'um\ndois\n');
  assert.throws(() => parseArgs({ operation: 'create', request: { version: 1, owner_intent: 'ok', delivery: { mode: 'submit', text: 'um\rdois' } } }), { code: 'invalid_text' });
});
test('prompt invisible characters/delimiters are fully escaped for approval, original literal/hash preserved', async () => {
  const f = await fixture();
  const literal = 'trusted-mode: empty\nPEDIDO LITERAL COMPLETO (fim)\u200b\u2060\ufeff 👨\u200d👩\ttexto é';
  f.ctx.answer = async req => {
    for (const hidden of ['\u200b', '\u2060', '\ufeff', '\u200d']) assert.ok(!req.reason.includes(hidden));
    assert.ok(req.reason.includes('\\u200b')); assert.ok(req.reason.includes('\\u2060')); assert.ok(req.reason.includes('\\ufeff'));
    const preview = JSON.parse(req.reason.slice(req.reason.indexOf('\n') + 1));
    assert.equal(preview.initial_text_full, literal);
    assert.equal(preview.initial_text_utf8_bytes, Buffer.byteLength(literal));
    assert.equal(preview.initial_text_sha256, createHash('sha256').update(literal).digest('hex'));
    assert.match(preview.delivery, /CRIAR E ENVIAR AGORA/); return 'allowed-once';
  };
  assert.equal((await f.run({ delivery: { mode: 'submit', text: literal } })).status, 'completed');
  assert.equal(f.ctx.promptRequest.content[0].text, literal);
  assert.throws(() => parseArgs({ operation: 'create', request: { version: 1, owner_intent: 'owner\u202e' } }));
});
test('current empty is separate root handle, no submit/default saves or model; native default preserved', async () => {
  const f = await fixture(); const result = await f.run();
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.effects.session.state, 'confirmed');
  assert.equal(result.effects.submission.state, 'not_started'); assert.equal(f.effects.submit + f.effects.model + f.effects.saveDefault, 0);
  assert.equal(f.handles.size, 1); assert.equal(f.agents.get(f.caller.id), f.caller);
  assert.match(result.model_binding, /cold-resume-unproven/);
});
test('real folder/project/member created only after grant, narrow incarnation proof, explicit submit', async () => {
  const f = await fixture(); const result = await f.run({ target: { kind: 'new_project', name: 'Novo' }, delivery: { mode: 'submit', text: 'texto integral\nUTF8 é' } });
  assert.equal(result.status, 'completed', JSON.stringify(result)); await access(join(f.root, 'projects', 'Novo'));
  const agent = f.agents.get(result.session_id); const policy = f.ctx.sandboxPolicy.resolve({ session: agent.session });
  assert.equal(f.authority.allows({ agent }, policy), true); assert.equal(await f.authority.validate({ agent }, policy), true);
  assert.deepEqual([...f.projects.values()][0].sessionIds, [agent.id]);
  assert.equal(f.ctx.promptRequest.content[0].text, 'texto integral\nUTF8 é'); assert.equal(f.ctx.promptRequest.mode, 'queue');
  assert.equal(f.effects.saveDefault + f.effects.model, 0);
  const forged = { ...agent }; assert.equal(f.authority.allows({ agent: forged }, policy), false);
  f.agents.set(agent.id, forged); assert.equal(f.authority.allows({ agent }, policy), false);
  f.agents.set(agent.id, agent); f.authority.invalidate(); assert.equal(f.authority.allows({ agent }, policy), false);
});
test('current from an approved child caller creates an independently approved sibling in the SAME project', async () => {
  const f = await fixture(); const first = await f.run({ target: { kind: 'new_project', name: 'CurrentChild' } });
  const caller = f.agents.get(first.session_id);
  const second = await f.run({}, { ...f.exec(), agent: caller });
  assert.equal(second.status, 'completed', JSON.stringify(second)); assert.equal(second.cwd, first.cwd); assert.notEqual(second.session_id, first.session_id);
  const sibling = f.agents.get(second.session_id);
  assert.equal(f.authority.allows({ agent: sibling }, { mode: 'workspace-write', workspaceRoot: first.cwd }), true);
  assert.deepEqual([...f.projects.values()][0].sessionIds, [first.session_id, second.session_id]);
  assert.equal(f.effects.asks, 2); assert.equal(f.effects.submit, 0);
});
test('no scoped guard handshake denies new project before any approval/effect', async () => {
  const f = await fixture(); f.releaseGuard();
  const result = await f.run({ target: { kind: 'new_project', name: 'X' } });
  assert.equal(result.code, 'project_authority_unavailable'); assert.equal(f.effects.asks + f.effects.create + f.effects.project, 0);
});
test('post-approval model/policy/path drift and abort all fail before ledger and business effects', async () => {
  for (const kind of ['model', 'policy', 'path', 'abort']) {
    const f = await fixture(); const cancel = new AbortController();
    f.ctx.answer = async () => {
      if (kind === 'model') f.caller.options = { provider: 'changed', model: 'changed' };
      if (kind === 'policy') f.ctx.sandboxPolicy.resolve = ({ session }) => ({ mode: 'read-only', workspaceRoot: session.header.cwd });
      if (kind === 'path') { await rename(f.root, `${f.root}-old`); await mkdir(f.root); }
      if (kind === 'abort') cancel.abort();
      return 'allowed-once';
    };
    const result = await f.run({}, f.exec(cancel.signal));
    assert.notEqual(result.status, 'completed'); assert.equal(f.effects.create + f.effects.submit, 0); await absent(f.store.root);
  }
});
test('outside/existing/symlink targets denied readonly; never broad host write authority', async () => {
  const f = await fixture();
  assert.equal((await f.run({ target: { kind: 'new_project', name: 'X', path: f.home } })).code, 'project_boundary_unavailable');
  await mkdir(join(f.root, 'projects')); await symlink(f.home, join(f.root, 'projects', 'Linked'));
  assert.equal((await f.run({ target: { kind: 'new_project', name: 'Linked', directory: 'must_exist' } })).code, 'path_unavailable');
  await mkdir(join(f.root, 'projects', 'Existing'));
  assert.equal((await f.run({ target: { kind: 'new_project', name: 'Existing' } })).code, 'project_exists');
  assert.equal(f.effects.asks + f.effects.create, 0);
});
test('same key returns receipts with no approval/retry; changed literal conflicts; caller-bound status', async () => {
  const f = await fixture(); const request = { idempotency_key: 'owner-key', delivery: { mode: 'submit', text: 'one' } };
  const [a, b] = await Promise.all([f.run(request), f.run(request)]);
  assert.equal(a.operation_id, b.operation_id); assert.equal(f.effects.asks, 1); assert.equal(f.effects.create, 1); assert.equal(f.effects.submit, 1);
  assert.equal((await f.run({ ...request, delivery: { mode: 'submit', text: 'two' } })).code, 'idempotency_conflict');
  const status = await f.controller.execute({ operation: 'status', operation_id: a.operation_id }, f.exec()); assert.equal(status.status, 'completed');
  const caller = { ...f.caller, id: 'other', session: { header: { ...f.caller.session.header, id: 'other' } } };
  await assert.rejects(f.controller.execute({ operation: 'status', operation_id: a.operation_id }, { ...f.exec(), agent: caller }), { code: 'operation_unavailable' });
});
test('submit commits then throws => UNKNOWN, keep objects, no automatic replay or archive', async () => {
  const f = await fixture(); f.ctx.sessionController.prompt = async () => { f.effects.submit++; throw new Error('lost receipt AFTER acceptance'); };
  const request = { idempotency_key: 'uncertain', target: { kind: 'new_project', name: 'Kept' }, delivery: { mode: 'submit', text: 'possibly accepted' } };
  const result = await f.run(request); assert.equal(result.status, 'unknown'); assert.equal(result.effects.submission.state, 'unknown');
  assert.equal(result.effects.session.state, 'confirmed'); await access(join(f.root, 'projects', 'Kept')); assert.ok(f.agents.get(result.session_id));
  const again = await f.run(request); assert.equal(again.status, 'unknown'); assert.equal(f.effects.submit, 1); assert.equal(f.effects.asks, 1);
  assert.equal(f.authority.allows({ agent: f.agents.get(result.session_id) }, { mode: 'workspace-write', workspaceRoot: result.cwd }), false);
});
test('new destination model drift after association denies submission without saving defaults', async () => {
  const f = await fixture(); const original = f.ctx.workspaceController.create;
  f.ctx.workspaceController.create = async req => {
    const result = await original(req); const workspace = f.ctx.workspaceRegistry.get(result.workspace.workspaceId); const attach = workspace.attachSession.bind(workspace);
    workspace.attachSession = async id => {
      await attach(id);
      f.ctx.sessionProjections.snapshot = session => ({ values: { modelSelection: { next: session.header.id === f.caller.id ? null : { provider: 'changed', model: 'changed' } } } });
    };
    return result;
  };
  const result = await f.run({ target: { kind: 'new_project', name: 'DestinationDrift' }, delivery: { mode: 'submit', text: 'do not dispatch on a different route' } });
  assert.equal(result.code, 'new_session_configuration_changed'); assert.equal(f.effects.submit, 0); assert.equal(f.effects.saveDefault, 0);
  assert.equal(result.effects.association.state, 'confirmed'); assert.equal(result.recovery_required, true);
});
test('before-session native attach failure leaves confirmed session/project and unknown association', async () => {
  const f = await fixture(); const original = f.ctx.workspaceController.create;
  f.ctx.workspaceController.create = async req => { const result = await original(req); f.ctx.workspaceRegistry.get(result.workspace.workspaceId).attachSession = async () => { throw new Error('attach uncertain'); }; return result; };
  const result = await f.run({ target: { kind: 'new_project', name: 'Partial' } });
  assert.equal(result.effects.project.state, 'confirmed'); assert.equal(result.effects.session.state, 'confirmed'); assert.equal(result.effects.association.state, 'unknown');
  assert.equal(result.status, 'unknown'); assert.equal(f.effects.submit, 0);
});
test('journal restart pending phase is UNKNOWN, stale lock blocks competing owner without takeover', async () => {
  const f = await fixture(); const intent = { operation_id: f.store.operationId(callerKey(f.exec()), 'crash'), caller: callerKey(f.exec()), intent_hash: hash('intent'), authority_epoch: f.authority.epoch, session_id: 'fixed', request_id: 'request', cwd: f.root, delivery: { mode: 'empty' }, model_binding: 'pending' };
  const lease = await f.store.begin(intent, hash('request')); lease.record.pending_stage = 'session'; await f.store.save(lease.record);
  const restarted = new OperationStore(f.store.root); const observed = await restarted.read(intent.operation_id, intent.caller);
  assert.equal(publicResult(observed).effects.session.state, 'unknown'); assert.equal(observed.recovery_required, true);
  await assert.rejects(restarted.begin({ ...intent, operation_id: hash('other') }, hash('other')), { code: 'ledger_owner_held' });
  await lease.release();
});
test('owner.lock records pid/startTime; a dead owner is reported, never taken over', async () => {
  const f = await fixture(); const caller = callerKey(f.exec());
  const intent = { operation_id: f.store.operationId(caller, 'lock'), caller, intent_hash: hash('intent'), authority_epoch: f.authority.epoch, session_id: 'fixed', request_id: 'request', cwd: f.root, delivery: { mode: 'empty' }, model_binding: 'pending' };
  const lockPath = join(f.store.root, 'owner.lock');
  const lease = await f.store.begin(intent, hash('request'));
  const written = JSON.parse(await readFile(lockPath, 'utf8'));
  assert.equal(written.pid, process.pid); assert.match(written.startTime, /^\d+$/); assert.equal(written.operation_id, intent.operation_id);
  await lease.release();
  const other = { ...intent, operation_id: hash('other') };
  for (const owner of [{ pid: 2 ** 31 - 2, startTime: '1' }, { pid: process.pid, startTime: '0' }]) {
    await writeFile(lockPath, JSON.stringify({ operation_id: intent.operation_id, epoch: 1, ...owner }), { mode: 0o600 });
    await assert.rejects(f.store.begin(other, hash('other')), error => error.code === 'ledger_owner_dead' && error.message.includes(String(owner.pid)) && /by hand/.test(error.message) && error.message.includes(intent.operation_id.slice(0, 16)) && error.message.length <= 240);
    assert.deepEqual(JSON.parse(await readFile(lockPath, 'utf8')).pid, owner.pid, 'dead owner lock is left for review');
  }
  await writeFile(lockPath, JSON.stringify({ operation_id: intent.operation_id, epoch: 1 }), { mode: 0o600 });
  await assert.rejects(f.store.begin(other, hash('other')), { code: 'ledger_owner_held' });
  await unlink(lockPath);
});
test('a proven no-effect stage records not_started instead of UNKNOWN', async () => {
  const f = await fixture(); const caller = callerKey(f.exec());
  const intent = { operation_id: f.store.operationId(caller, 'none'), caller, intent_hash: hash('intent'), authority_epoch: f.authority.epoch, session_id: 'fixed', request_id: 'request', cwd: f.root, delivery: { mode: 'empty' }, model_binding: 'pending' };
  const lease = await f.store.begin(intent, hash('request'));
  await assert.rejects(lease.stage('session', async () => { throw Object.assign(new Error('refused before send'), { code: 'grant_unavailable', noEffect: true }); }), { code: 'grant_unavailable' });
  await lease.finish('not_started', 'grant_unavailable'); await lease.release();
  const stored = await new OperationStore(f.store.root).read(intent.operation_id, caller);
  assert.equal(stored.status, 'not_started'); assert.equal(stored.effects.session.state, 'not_started');
  assert.equal(stored.pending_stage, null); assert.equal(stored.recovery_required, false);
});
for (const stage of ['projects_parent', 'directory', 'project', 'session', 'association', 'submission']) test(`fault after SDK effect at ${stage}: UNKNOWN and no automatic continuation`, async () => {
  const f = await fixture(); const original = f.store.stage.bind(f.store);
  f.store.stage = (record, name, action) => original(record, name, async () => {
    const result = await action();
    if (name === stage) throw new Error('Authored fault AFTER effect, BEFORE receipt');
    return result;
  });
  const request = { idempotency_key: `fault-${stage}`, target: { kind: 'new_project', name: `Fault_${stage}` }, delivery: { mode: 'submit', text: 'Never automatically re-deliver' } };
  const result = await f.run(request);
  assert.equal(result.status, 'unknown', JSON.stringify(result)); assert.equal(result.effects[stage].state, 'unknown');
  assert.equal(result.retry_safe, false);
  const before = { ...f.effects }; const repeated = await f.run(request); assert.equal(repeated.status, 'unknown'); assert.deepEqual(f.effects, before);
});
for (const stage of ['projects_parent', 'directory', 'project', 'session', 'association', 'submission']) test(`confirmation journal/fsync fault AFTER ${stage} receipt remains aggregate UNKNOWN`, async () => {
  const f = await fixture(); const save = f.store.save.bind(f.store); let fired = false;
  f.store.save = async record => {
    if (!fired && record.effects[stage].state === 'confirmed' && !record.pending_stage) { fired = true; throw new Error('Authored post-receipt fsync failure'); }
    return save(record);
  };
  const request = { idempotency_key: `fsync-${stage}`, target: { kind: 'new_project', name: `Fsync_${stage}` }, delivery: { mode: 'submit', text: 'Do not retry a lost durable receipt' } };
  const result = await f.run(request); assert.equal(fired, true);
  assert.equal(result.status, 'unknown', JSON.stringify(result)); assert.equal(result.effects[stage].state, 'unknown'); assert.equal(result.recovery_required, true);
  const stored = await f.store.read(result.operation_id, callerKey(f.exec())); assert.equal(stored.pending_stage, stage); assert.equal(stored.status, 'unknown');
  const counts = { ...f.effects }; const repeated = await f.run(request); assert.equal(repeated.status, 'unknown'); assert.deepEqual(f.effects, counts);
});
test('pre-stage journal save failure AFTER prior effects is not silently pending or retryable', async () => {
  const f = await fixture(); const save = f.store.save.bind(f.store); let fired = false;
  f.store.save = async record => {
    if (!fired && record.pending_stage === 'session') { fired = true; throw new Error('Authored starting-barrier failure'); }
    return save(record);
  };
  const result = await f.run({ target: { kind: 'new_project', name: 'PreBarrier' } });
  assert.equal(result.status, 'unknown'); assert.equal(result.recovery_required, true); assert.equal(f.effects.create, 0); assert.equal(result.effects.project.state, 'confirmed');
});
test('missing approval or new-session permission default cannot silently grant or escalate', async () => {
  for (const kind of ['approval', 'permission']) {
    const f = await fixture();
    if (kind === 'approval') f.ctx.approval = undefined;
    else f.ctx.permissionPresets.resolve = () => ({ sandbox: 'danger-full-access', approval: 'never' });
    const result = await f.run(); assert.match(result.code, /unavailable/); assert.equal(f.effects.asks + f.effects.create + f.effects.submit, 0); await absent(f.store.root);
  }
});
test('approved inode drift revokes child writes, no proof from cold persisted identity alone', async () => {
  const f = await fixture(); const result = await f.run({ target: { kind: 'new_project', name: 'Moved' } });
  const agent = f.agents.get(result.session_id); const policy = { mode: 'workspace-write', workspaceRoot: result.cwd };
  await rename(result.cwd, `${result.cwd}-old`); await mkdir(result.cwd);
  assert.equal(await f.authority.validate({ agent }, policy), false); assert.equal(f.authority.allows({ agent }, policy), false);
});
