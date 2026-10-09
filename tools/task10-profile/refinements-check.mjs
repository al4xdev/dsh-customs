/** Focused real-store regression; no model calls or production profile writes.
 * Run from the repository: node tools/task10-profile/refinements-check.mjs
 * Leaves its inspected test workspace under .dumps/ for recovery/evidence.
 */
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PlanStore } from '../../plugins/managed-plans/store.mjs';
import { ManagedPlans } from '../../plugins/managed-plans/index.mjs';
import { resolveHost, stringOutput } from '../../plugins/common.mjs';
import { managedPlanCallView, managedPlanResultView } from '../../plugins/managed-plans/presentation.mjs';

const scratch = fileURLToPath(new URL('../../.dumps/', import.meta.url));
const workspace = mkdtempSync(join(scratch, 'task10-refinements-'));
const store = new PlanStore(workspace);
const origin = call_id => ({ session_id: 'test-owner', call_id });
const source = '# Review test\n\n- First item\n- Second item\n';
const view = (name, args, data) => managedPlanResultView(name, args, { content: [{ type: 'text', text: JSON.stringify(data) }] });
const historical = ({ revision, hash, title, category, status, origin, content, comments, deleted_comments, decisions, closure, reopening }) =>
  ({ revision, hash, title, category, status, origin, content, comments, deleted_comments, decisions, closure, reopening });
try {
  await store.initialize();
  const first = await store.stage({ title: 'Review test', plan: source, category: 'tasks', origin: origin('r1') });
  assert.equal(first.execution_authorized, false);
  const args = { plan_id: first.plan_id, revision: first.revision, hash: first.hash, line_start: 3, line_end: 3, owner_session_id: 'test-owner' };
  const comment = await store.saveComment({ ...args, text: 'Original comment' });
  const edited = await store.saveComment({ ...args, text: 'Edited without repeating the id' });
  assert.equal(edited.comment_id, comment.comment_id);
  assert.equal((await store.read(first.plan_id)).comments.length, 1);
  await assert.rejects(store.saveComment({ ...args, text: '   ' }), { code: 'INVALID_INPUT' });
  await assert.rejects(store.saveComment({ ...args, comment_id: comment.comment_id, owner_session_id: 'another-owner', text: 'Forbidden' }), { code: 'COMMENT_OWNER_MISMATCH' });
  await store.decide({ ...args, decision: 'reject' });
  assert.equal((await store.read(first.plan_id)).comments[0].status, 'sent');
  await assert.rejects(store.deleteComment({ ...args, comment_id: comment.comment_id }), { code: 'INVALID_STATE' });
  const second = await store.stage({ plan_id: first.plan_id, expected_revision: 1, title: 'Review test', plan: source + '\nRevised.\n', category: 'tasks', origin: origin('r2') });
  const revisions = await store.history(first.plan_id);
  assert.deepEqual(revisions.map(r => [r.revision, r.is_current, r.comment_count]), [[2, true, 0], [1, false, 1]]);
  assert.equal(revisions[1].execution_authorized, false);
  const old = await store.read(first.plan_id, { revision: 1 });
  assert.equal(old.current_revision, 2);
  assert.equal(old.comments[0].text, 'Edited without repeating the id');
  assert.equal(old.comments[0].quoted_context, '- First item');
  await assert.rejects(store.decide({ ...args, decision: 'approve' }), { code: 'STALE_REVIEW' });
  await assert.rejects(store.saveComment({ ...args, text: 'Old revision edit' }), { code: 'STALE_REVIEW' });
  await assert.rejects(store.deleteComment({ ...args, comment_id: comment.comment_id }), { code: 'STALE_REVIEW' });
  const secondComment = await store.saveComment({ ...args, revision: 2, hash: second.hash, text: 'Current revision comment' });
  assert.notEqual(secondComment.comment_id, comment.comment_id);
  const approved = await store.decide({ plan_id: second.plan_id, revision: 2, hash: second.hash, decision: 'approve', owner_session_id: 'test-owner' });
  assert.equal(approved.execution_authorized, true);
  const read = await store.read(second.plan_id);
  const readView = view('plan_read', {}, read);
  assert.equal(readView.card, 'generic');
  assert.equal(readView.content[1].text, read.content);
  assert.ok(readView.content[0].text.includes('Execution authorized: Yes'));
  assert.ok(view('plan_stage', {}, { ...second, waiting_for_owner: true, next_action: 'Wait for owner review.' }).title.includes('Execution not authorized'));
  const closure = { plan_id: second.plan_id, expected_revision: 2, outcome: 'completed', reason: 'Regression completed.', evidence: 'Real store and presentation assertions passed.' };
  const closed = await store.close(closure);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.execution_authorized, false);
  assert.ok(existsSync(join(workspace, '.plan', closed.path)));
  assert.equal(readFileSync(join(workspace, '.plan', closed.path), 'utf8'), read.content);
  assert.ok(view('plan_close', closure, closed).content.some(block => block.text === closure.evidence));
  const closedSource = await store.read(closed.plan_id);
  const reopenArgs = { plan_id: closed.plan_id, expected_revision: 2, hash: closed.hash, reason: 'Review the completed plan again.',
    owner_session_id: 'test-owner', origin: { ...origin('human-O'), request_id: 'stable-O' } };
  await assert.rejects(store.reopen({ ...reopenArgs, expected_revision: undefined }), { code: 'INVALID_INPUT' });
  await assert.rejects(store.reopen({ ...reopenArgs, expected_revision: 1 }), { code: 'STALE_REVISION' });
  await assert.rejects(store.reopen({ ...reopenArgs, hash: undefined }), { code: 'INVALID_INPUT' });
  await assert.rejects(store.reopen({ ...reopenArgs, hash: 'stale-hash' }), { code: 'STALE_REVIEW' });
  await assert.rejects(store.reopen({ ...reopenArgs, reason: '' }), { code: 'INVALID_INPUT' });
  // A mirror publication failure happens after the durable registry commit.
  // Recovery must replay that intent, not allocate another reopened revision.
  const link = fs.linkSync;
  fs.linkSync = () => { throw new Error('Injected reopen publication interruption'); };
  try { await assert.rejects(store.reopen(reopenArgs), error => error.committed === true); }
  finally { fs.linkSync = link; }
  store.dispose();
  await store.initialize();
  const reopened = await store.reopen({ ...reopenArgs, origin: { ...reopenArgs.origin, call_id: 'human-O-retry' } });
  assert.equal(reopened.plan_id, closed.plan_id);
  assert.equal(reopened.revision, 3);
  assert.equal(reopened.reopened, true);
  assert.equal(reopened.status, 'staged');
  assert.equal(reopened.execution_authorized, false);
  const fresh = await store.read(closed.plan_id);
  for (const key of ['title', 'content', 'category', 'hash']) assert.equal(fresh[key], closedSource[key]);
  assert.deepEqual(fresh.comments, []);
  assert.deepEqual(fresh.deleted_comments, []);
  assert.deepEqual(fresh.decisions, []);
  assert.equal(fresh.closure, null);
  assert.equal(fresh.reopening.source_revision, 2);
  assert.equal(fresh.reopening.source_status, 'closed');
  assert.equal(fresh.reopening.reason, reopenArgs.reason);
  assert.equal(fresh.reopening.origin.call_id, 'human-O');
  assert.equal(fresh.reopening.origin.request_id, 'stable-O');
  assert.deepEqual(historical(await store.read(closed.plan_id, { revision: 2 })), historical(closedSource));
  assert.equal(readFileSync(join(workspace, '.plan', fresh.path), 'utf8'), closedSource.content);
  await assert.rejects(store.reopen({ ...reopenArgs, reason: 'Conflicting retry' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(store.close({ ...closure, expected_revision: 3 }), { code: 'INVALID_STATE' });
  assert.ok((await store.pendingNotifications('test-owner')).every(notice => !notice.execution_authorized));
  const unchanged = await store.reopen({ plan_id: fresh.plan_id, expected_revision: 3, hash: fresh.hash, reason: 'Open an already staged plan.',
    owner_session_id: 'test-owner', origin: origin('open-staged') });
  assert.equal(unchanged.reopened, false);
  assert.equal(unchanged.revision, 3);
  assert.deepEqual(historical(await store.read(closed.plan_id)), historical(fresh));
  assert.deepEqual((await store.history(closed.plan_id))[0].reopening, fresh.reopening);
  // Reopened proposals can be revised through the normal stage path after feedback.
  const afterFeedback = await store.stage({ plan_id: fresh.plan_id, expected_revision: 3, title: fresh.title,
    plan: fresh.content + '\nRevised after owner feedback.\n', category: fresh.category, origin: origin('after-feedback') });
  assert.equal(afterFeedback.revision, 4);
  assert.equal(afterFeedback.execution_authorized, false);
  assert.deepEqual(historical(await store.read(fresh.plan_id, { revision: 3 })), historical(fresh));

  const deletionPlan = await store.stage({ title: 'Deletion audit', plan: source, category: 'tasks', origin: origin('deletion') });
  const deleteBinding = { plan_id: deletionPlan.plan_id, revision: 1, hash: deletionPlan.hash, owner_session_id: 'test-owner' };
  const draft = await store.saveComment({ ...deleteBinding, line_start: 3, line_end: 3, text: 'Never display or send this deleted comment.' });
  const deleteArgs = { ...deleteBinding, comment_id: draft.comment_id };
  await assert.rejects(store.deleteComment({ ...deleteArgs, owner_session_id: 'another-owner' }), { code: 'COMMENT_OWNER_MISMATCH' });
  await assert.rejects(store.deleteComment({ ...deleteArgs, hash: 'stale' }), { code: 'STALE_REVIEW' });
  await assert.rejects(store.deleteComment({ ...deleteArgs, revision: undefined }), { code: 'STALE_REVIEW' });
  await assert.rejects(store.deleteComment({ ...deleteArgs, comment_id: 'missing' }), { code: 'NOT_FOUND' });
  const tombstone = await store.deleteComment(deleteArgs);
  assert.equal(tombstone.status, 'deleted');
  assert.equal(tombstone.text, draft.text);
  assert.equal(tombstone.quoted_context, draft.quoted_context);
  assert.equal(tombstone.deleted_by_session_id, 'test-owner');
  assert.ok(tombstone.deleted_at);
  assert.deepEqual(await store.deleteComment(deleteArgs), tombstone);
  assert.deepEqual((await store.read(deletionPlan.plan_id)).comments, []);
  assert.deepEqual((await store.read(deletionPlan.plan_id)).deleted_comments, [tombstone]);
  await assert.rejects(store.saveComment({ ...deleteArgs, line_start: 3, line_end: 3, text: 'Resurrect deleted id' }), { code: 'INVALID_STATE' });
  const cleanRead = await store.read(deletionPlan.plan_id);
  assert.ok(!view('plan_read', {}, cleanRead).content.some(block => block.text.includes(draft.text)));
  assert.ok(!view('plan_read', {}, { ...cleanRead, comments: [tombstone] }).content.some(block => block.text.includes(draft.text)));
  await store.decide({ ...deleteBinding, decision: 'reject' });
  const deleteNotice = (await store.pendingNotifications('test-owner')).find(notice => notice.plan_id === deletionPlan.plan_id);
  assert.equal(deleteNotice.action, 'wait');
  assert.deepEqual(deleteNotice.comments, []);
  assert.equal((await store.read(deletionPlan.plan_id)).deleted_comments[0].status, 'deleted');
  assert.equal((await store.history(deletionPlan.plan_id))[0].comment_count, 0);
  assert.equal((await store.history(deletionPlan.plan_id))[0].deleted_comment_count, 1);
  const rejectedSource = await store.read(deletionPlan.plan_id);
  const rejectedReopen = await store.reopen({ plan_id: deletionPlan.plan_id, expected_revision: 1, reason: 'Propose another review.', origin: origin('model-reopen-rejected') });
  assert.equal(rejectedReopen.revision, 2);
  assert.equal(rejectedReopen.execution_authorized, false);
  assert.deepEqual(historical(await store.read(deletionPlan.plan_id, { revision: 1 })), historical(rejectedSource));
  const replacement = await store.saveComment({ plan_id: deletionPlan.plan_id, revision: 2, hash: rejectedReopen.hash,
    owner_session_id: 'test-owner', line_start: 3, line_end: 3, text: 'Fresh comment on reopened proposal.' });
  assert.notEqual(replacement.comment_id, draft.comment_id);
  const deletedAgain = await store.saveComment({ plan_id: deletionPlan.plan_id, revision: 2, hash: rejectedReopen.hash,
    owner_session_id: 'test-owner', line_start: 4, line_end: 4, text: 'Deleted before rejection.' });
  await store.deleteComment({ plan_id: deletionPlan.plan_id, revision: 2, hash: rejectedReopen.hash, comment_id: deletedAgain.comment_id, owner_session_id: 'test-owner' });
  const sameRange = await store.saveComment({ plan_id: deletionPlan.plan_id, revision: 2, hash: rejectedReopen.hash,
    owner_session_id: 'test-owner', line_start: 4, line_end: 4, text: 'New active comment, not resurrected.' });
  assert.notEqual(sameRange.comment_id, deletedAgain.comment_id);
  await store.decide({ plan_id: deletionPlan.plan_id, revision: 2, hash: rejectedReopen.hash, decision: 'reject', owner_session_id: 'test-owner' });
  const activeNotice = (await store.pendingNotifications('test-owner')).find(notice => notice.plan_id === deletionPlan.plan_id && notice.revision === 2);
  assert.equal(activeNotice.action, 'revise');
  assert.deepEqual(activeNotice.comments.map(comment => comment.comment_id), [replacement.comment_id, sameRange.comment_id]);
  assert.ok(activeNotice.comments.every(comment => comment.status === 'sent'));
  await assert.rejects(store.deleteComment({ plan_id: deletionPlan.plan_id, revision: 2, hash: rejectedReopen.hash, comment_id: replacement.comment_id, owner_session_id: 'test-owner' }), { code: 'INVALID_STATE' });
  for (const category of ['backlog', 'para-o-dono']) {
    const staged = await store.stage({ title: `Save-only ${category}`, plan: source, category, origin: origin(category) });
    const saved = await store.decide({ plan_id: staged.plan_id, revision: 1, hash: staged.hash, decision: 'approve', owner_session_id: 'test-owner' });
    assert.equal(saved.execution_authorized, false);
    await assert.rejects(store.close({ ...closure, plan_id: saved.plan_id, expected_revision: 1 }), { code: 'INVALID_INPUT' });
    const savedSource = await store.read(saved.plan_id);
    const reopenedSaved = await store.reopen({ plan_id: saved.plan_id, expected_revision: 1, reason: 'Review saved work again.', origin: origin(`reopen-${category}`) });
    assert.equal(reopenedSaved.category, category);
    assert.equal(reopenedSaved.status, 'staged');
    assert.equal(reopenedSaved.execution_authorized, false);
    assert.deepEqual(historical(await store.read(saved.plan_id, { revision: 1 })), historical(savedSource));
    assert.equal((await store.decide({ plan_id: saved.plan_id, revision: 2, hash: reopenedSaved.hash, decision: 'approve', owner_session_id: 'test-owner' })).execution_authorized, false);
  }
  assert.equal(view('plan_read', {}, { broken: true }), undefined);
  assert.equal(managedPlanResultView('plan_read', {}, { isError: true, content: [{ type: 'text', text: 'Failure' }] }), undefined);
  const readOnly = new PlanStore(workspace);
  try {
    await readOnly.initialize({ readOnly: true });
    await assert.rejects(readOnly.deleteComment(deleteArgs), { code: 'READ_ONLY' });
    await assert.rejects(readOnly.reopen(reopenArgs), { code: 'READ_ONLY' });
  } finally { readOnly.dispose(); }
  console.log('PASS: real store draft deletion/audit/no-resurrection, active-only rejection, immutable reopen history, same-id exact copy, stale guards, save-only categories, durable retry and interrupted-publication recovery.');
  console.log(`Test workspace: ${workspace}`);
} finally { store.dispose(); }

// Exercise genuine native tool/command registries and the actual plugin/store
// boundary. Only session/mode/policy adapters are small local test fixtures.
const { Context } = await import(resolveHost('@deepseek-ai/cordis'));
const { ToolRuntime } = await import(resolveHost('@deepseek-ai/dsh-tools'));
const { CommandRuntime } = await import(resolveHost('@deepseek-ai/dsh-commands'));
const nativeWorkspace = mkdtempSync(join(scratch, 'task10-native-refinements-'));
const deniedWorkspace = mkdtempSync(join(scratch, 'task10-native-readonly-'));
const ctx = new Context();
ctx.provide('systemPrompt', { tools() {} });
const tools = new ToolRuntime(ctx);
const commands = new CommandRuntime(ctx);
let flushes = 0, calls = 0, sends = 0;
const modeEvents = [], live = new Map();
const agent = { status: 'running', session: { id: 'native-owner', header: { origin: 'cli', cwd: nativeWorkspace },
  events: [], append(type, data) { this.events.push({ type, data }); return this.events.length; } }, send() { sends++; } };
const child = { status: 'running', session: { id: 'native-child', header: { origin: 'subagent', parentSession: agent.session.id, cwd: deniedWorkspace },
  events: [], append(type, data) { this.events.push({ type, data }); return this.events.length; } }, send() { sends++; } };
live.set(agent.session.id, agent); live.set(child.session.id, child);
const deniedAgent = { ...agent, session: { ...agent.session, id: 'native-denied', header: { origin: 'cli', cwd: deniedWorkspace }, events: [] } };
let policy = { mode: 'workspace-write', workspaceRoot: nativeWorkspace };
ctx.provide('planMode', { commit(target, active) { modeEvents.push({ session_id: target.session.id, active }); } });
ctx.provide('sessionProjections', { register() {}, stateOf() { return { ids: [] }; } });
ctx.provide('sessionPersistence', { async flush() { flushes++; } });
ctx.provide('agents', { get(id) { return live.get(id); } });
ctx.provide('sandboxPolicy', { resolve() { return policy; } });
const plugin = new ManagedPlans(ctx, { wakeAgent: false });
const signal = new AbortController().signal;
async function tool(name, args, success = true, target = agent, callId = `native-call-${++calls}`) {
  const result = await tools.execute({ name, arguments: args, signal, agent: target, callId });
  assert.equal(result.isError, !success, JSON.stringify(result));
  if (success) {
    assert.equal(typeof result.value, 'string');
    assert.deepEqual(result.content, stringOutput.render(args, result.value));
    assert.deepEqual(tools.get(name).output.schema, { type: 'string' });
    assert.ok(tools.get(name).presentResult(args, result));
  }
  return result;
}
async function ui(payload, success = true, target = agent) {
  const execution = await commands.execute(target, '/plan ui ' + JSON.stringify(payload), [], signal);
  assert.equal(execution.result.kind, success ? 'success' : 'error', JSON.stringify(execution));
  return success ? { ...execution, data: JSON.parse(execution.result.text).data } : execution;
}
try {
  policy = { mode: 'read-only', workspaceRoot: deniedWorkspace };
  await tool('plan_stage', { title: 'Denied', plan: source, category: 'tasks' }, false, deniedAgent);
  await tool('plan_reopen', { plan_id: 1, expected_revision: 1, reason: 'Denied reopening' }, false, deniedAgent);
  assert.ok(!existsSync(join(deniedWorkspace, '.plan')), 'denied writes must not bootstrap .plan');
  assert.deepEqual(JSON.parse((await tool('plan_list', {}, true, deniedAgent)).value), []);
  assert.ok(!existsSync(join(deniedWorkspace, '.plan')), 'empty readonly browsing must not bootstrap .plan');
  policy = { mode: 'workspace-write', workspaceRoot: deniedWorkspace };
  await tool('plan_stage', { title: 'Outside writable root', plan: source, category: 'tasks' }, false);
  policy = { mode: 'workspace-write', workspaceRoot: nativeWorkspace };
  const initialResult = await tool('plan_stage', { title: 'Native proposal', plan: source, category: 'tasks' });
  assert.equal(initialResult.concludesTurn, true);
  const first = JSON.parse(initialResult.value);
  const draft = (await ui({ action: 'comment', plan_id: first.plan_id, revision: 1, hash: first.hash, line_start: 3, line_end: 3, text: 'Native draft' })).data;
  await ui({ action: 'delete_comment', plan_id: first.plan_id, revision: 1, hash: first.hash, comment_id: draft.comment_id }, false, child);
  await ui({ action: 'delete_comment', plan_id: first.plan_id, revision: 1, hash: first.hash, comment_id: draft.comment_id, actor: 'human' }, false);
  await ui({ action: 'delete_comment', plan_id: first.plan_id, revision: 1, hash: first.hash, comment_id: draft.comment_id, owner_session_id: 'native-owner' }, false);
  assert.equal((await ui({ action: 'delete_comment', plan_id: first.plan_id, revision: 1, hash: first.hash, comment_id: draft.comment_id })).data.status, 'deleted');
  assert.equal(tools.get('delete_comment'), undefined);
  assert.equal(tools.get('plan_delete_comment'), undefined);
  const approved = (await ui({ action: 'decide', plan_id: first.plan_id, revision: 1, hash: first.hash, decision: 'approve' })).data;
  assert.equal(approved.execution_authorized, true);
  const oldSource = JSON.parse((await tool('plan_read', { plan_id: first.plan_id })).value);
  const proposalArgs = { plan_id: first.plan_id, expected_revision: 1, reason: 'Propose a safe new review.' };
  await tool('plan_reopen', { ...proposalArgs, expected_revision: undefined }, false);
  await tool('plan_reopen', { ...proposalArgs, actor: 'human' }, false);
  await tool('plan_close', { plan_id: first.plan_id, expected_revision: 1, outcome: 'cancelled', reason: 'Self-cancel', evidence: 'No owner permission', owner_cancel_authorized: true }, false);
  const beforeReopenFlushes = flushes, beforeReopenSends = sends;
  const proposalResult = await tool('plan_reopen', proposalArgs, true, child, 'stable-model-reopen');
  const proposal = JSON.parse(proposalResult.value);
  assert.equal(proposalResult.concludesTurn, true);
  assert.equal(proposal.waiting_for_owner, true);
  assert.equal(proposal.execution_authorized, false);
  assert.equal(proposal.revision, 2);
  assert.equal(proposal.reopening.source_revision, 1);
  assert.equal(proposal.origin.session_id, 'native-owner', 'delegated tool binding must use the root owner');
  assert.deepEqual(modeEvents.at(-1), { session_id: child.session.id, active: true });
  assert.ok(flushes > beforeReopenFlushes);
  assert.equal(sends, beforeReopenSends);
  assert.ok(managedPlanCallView('plan_reopen', proposalArgs).content[0].text.includes('never authorizes execution'));
  assert.ok(tools.get('plan_reopen').presentResult(proposalArgs, proposalResult).title.includes('Execution not authorized'));
  assert.deepEqual(JSON.parse((await tool('plan_reopen', proposalArgs, true, child, 'stable-model-reopen')).value), proposal);
  const modelOld = JSON.parse((await tool('plan_read', { plan_id: first.plan_id, revision: 1 })).value);
  assert.deepEqual(historical(modelOld), historical(oldSource));
  const closeArgs = { plan_id: first.plan_id, expected_revision: 2, outcome: 'completed', reason: 'Try inherited approval', evidence: 'Must refuse' };
  await tool('plan_close', closeArgs, false);
  const pending = JSON.parse((await tool('plan_read', { plan_id: first.plan_id })).value);
  const openArgs = { action: 'reopen', plan_id: first.plan_id, expected_revision: 2, hash: pending.hash, reason: 'Open current staged proposal.', request_id: 'human-staged-open' };
  const noOp = (await ui(openArgs)).data;
  assert.equal(noOp.reopened, false);
  assert.equal(noOp.revision, 2);
  await ui({ ...openArgs, expected_revision: 1, request_id: 'human-stale' }, false);
  await ui({ ...openArgs, hash: undefined, request_id: 'human-no-hash' }, false);
  await ui({ ...openArgs, request_id: 'child-forgery' }, false, child);
  await ui({ ...openArgs, actor: 'human', request_id: 'payload-forgery' }, false);
  await ui({ action: 'decide', plan_id: first.plan_id, revision: 2, hash: pending.hash, decision: 'approve' });
  await tool('plan_close', { ...closeArgs, reason: 'Native approved closure', evidence: 'No model calls in this test' });
  const closedBeforeO = JSON.parse((await tool('plan_read', { plan_id: first.plan_id })).value);
  const humanArgs = { action: 'reopen', plan_id: first.plan_id, expected_revision: 2, hash: closedBeforeO.hash,
    reason: 'Owner browser reopen without waking the model.', request_id: 'stable-human-O' };
  const modeCount = modeEvents.length, flushCount = flushes, sendCount = sends;
  const humanReopen = await ui(humanArgs);
  assert.equal(humanReopen.data.revision, 3);
  assert.equal(humanReopen.data.waiting_for_owner, true);
  assert.equal(humanReopen.data.execution_authorized, false);
  assert.equal(humanReopen.data.reopening.origin.call_id, humanReopen.commandId);
  assert.equal(humanReopen.data.reopening.origin.request_id, humanArgs.request_id);
  assert.equal(humanReopen.data.reopening.intent, 'owner-review');
  assert.deepEqual(modeEvents.slice(modeCount), [{ session_id: agent.session.id, active: true }]);
  assert.ok(flushes > flushCount);
  assert.equal(sends, sendCount, 'human O must never queue a message or wake an agent');
  const humanRetry = await ui(humanArgs);
  assert.notEqual(humanRetry.commandId, humanReopen.commandId);
  assert.deepEqual(humanRetry.data, humanReopen.data);
  await ui({ ...humanArgs, reason: 'Request id changed input' }, false);
  const history = (await ui({ action: 'history', plan_id: first.plan_id })).data;
  assert.deepEqual(history.map(revision => revision.revision), [3, 2, 1]);
  assert.equal(history[0].reopening.origin.call_id, humanReopen.commandId);
  assert.deepEqual(historical(JSON.parse((await tool('plan_read', { plan_id: first.plan_id, revision: 2 })).value)), historical(closedBeforeO));
  await tool('plan_close', { ...closeArgs, expected_revision: 3 }, false);
  const deniedReopenHistory = JSON.stringify(history);
  policy = { mode: 'read-only', workspaceRoot: nativeWorkspace };
  await ui({ ...humanArgs, expected_revision: 3, request_id: 'readonly-human-O' }, false);
  await tool('plan_reopen', { ...proposalArgs, expected_revision: 3 }, false);
  assert.equal(JSON.stringify((await ui({ action: 'history', plan_id: first.plan_id })).data), deniedReopenHistory);
  policy = { mode: 'workspace-write', workspaceRoot: nativeWorkspace };
  const revision = JSON.parse((await tool('plan_stage', { title: 'After feedback', plan: source + '\nOwner feedback incorporated.\n', category: 'tasks', plan_id: first.plan_id, expected_revision: 3 })).value);
  assert.equal(revision.revision, 4);
  assert.equal(revision.waiting_for_owner, true);
  assert.equal(revision.execution_authorized, false);
  // A workspace catalog can outlive its creating session. Reopening from B
  // must route future approval to B, while historical provenance stays with A.
  await ui({ action: 'decide', plan_id: first.plan_id, revision: 4, hash: revision.hash, decision: 'approve' });
  await tool('plan_close', { ...closeArgs, expected_revision: 4, reason: 'Session A closed work', evidence: 'Handoff fixture' });
  const sourceA = JSON.parse((await tool('plan_read', { plan_id: first.plan_id })).value);
  const sessionB = { ...agent, session: { ...agent.session, id: 'native-owner-B', events: [] } };
  live.set(sessionB.session.id, sessionB);
  const beforeHandoffModes = modeEvents.length, beforeHandoffSends = sends;
  const handoff = (await ui({ action: 'reopen', plan_id: first.plan_id, expected_revision: 4, hash: sourceA.hash,
    reason: 'Owner session B reopens historical work.', request_id: 'handoff-B' }, true, sessionB)).data;
  assert.equal(handoff.origin.session_id, sessionB.session.id);
  assert.equal(handoff.reopening.source_origin.session_id, agent.session.id);
  assert.deepEqual(modeEvents.slice(beforeHandoffModes), [{ session_id: sessionB.session.id, active: true }]);
  assert.equal(sends, beforeHandoffSends);
  assert.deepEqual(historical(JSON.parse((await tool('plan_read', { plan_id: first.plan_id, revision: 4 })).value)), historical(sourceA));
  await tool('plan_close', { ...closeArgs, expected_revision: 5 }, false, sessionB);
  const handoffApproved = (await ui({ action: 'decide', plan_id: first.plan_id, revision: 5, hash: handoff.hash, decision: 'approve' }, true, sessionB)).data;
  assert.equal(handoffApproved.execution_authorized, true);
  const noticeB = await plugin.withStore(sessionB, false, s => s.pendingNotifications(sessionB.session.id));
  assert.equal(noticeB.length, 1);
  assert.equal(noticeB[0].action, 'execute');
  assert.equal(noticeB[0].revision, 5);
  assert.ok((await plugin.withStore(agent, false, s => s.pendingNotifications(agent.session.id))).every(notice => !notice.is_current));
  await tool('plan_close', { ...closeArgs, expected_revision: 5, reason: 'Session B fresh approval', evidence: 'Correct approval recipient verified' }, true, sessionB);
  const closedB = JSON.parse((await tool('plan_read', { plan_id: first.plan_id })).value);
  const closedProposal = JSON.parse((await tool('plan_reopen', { plan_id: first.plan_id, expected_revision: 5, reason: 'Model proposes reopening closed B work.' }, true, sessionB)).value);
  assert.equal(closedProposal.revision, 6);
  assert.equal(closedProposal.execution_authorized, false);
  assert.equal(closedProposal.reopening.source_status, 'closed');
  assert.equal(closedProposal.origin.session_id, sessionB.session.id);
  assert.deepEqual(historical(JSON.parse((await tool('plan_read', { plan_id: first.plan_id, revision: 5 })).value)), historical(closedB));
  console.log('PASS: native tool+human command registries, stringOutput JSON/presentation, managed mode+concludeTurn, readonly/root authority and actor guards, delegated binding, quiet human O, stable retries and fresh-approval closure guard; zero model calls.');
  console.log(`Native test workspace: ${nativeWorkspace}`);
} finally { for (const writer of plugin.writers.values()) writer.dispose(); }
