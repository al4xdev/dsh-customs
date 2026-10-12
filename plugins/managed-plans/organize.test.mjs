import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlanStore } from './store.mjs';

const scratch = fileURLToPath(new URL('../../.dumps/', import.meta.url));
let command = 0;
async function fixture(t, beforeInitialize) {
  fs.mkdirSync(scratch, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(scratch, 'managed-organize-'));
  const stores = [];
  const open = async () => {
    const store = new PlanStore(cwd);
    stores.push(store);
    await store.initialize();
    return store;
  };
  t.after(() => {
    for (const store of stores) store.dispose();
    // Only delete this test's freshly allocated directory, never the project .plan.
    const target = path.resolve(cwd);
    assert.equal(path.dirname(target), path.resolve(scratch));
    assert.ok(path.basename(target).startsWith('managed-organize-'));
    assert.ok(!fs.lstatSync(target).isSymbolicLink());
    fs.rmSync(target, { recursive: true });
  });
  beforeInitialize?.(cwd);
  return { cwd, open, store: await open() };
}
const origin = () => ({ session_id: 'human-session', call_id: `command-${++command}` });
const input = (plan, category, extra = {}) => ({ plan_id: plan.plan_id, expected_revision: plan.revision,
  hash: plan.hash, category, owner_session_id: 'human-session', origin: origin(), ...extra });
async function stage(store, category = 'tasks') {
  return store.stage({ title: 'Own fixture', plan: '# Own fixture\n\nExact body.\n', category, origin: origin() });
}
async function approve(store, category = 'tasks') {
  const plan = await stage(store, category);
  return store.decide({ plan_id: plan.plan_id, revision: plan.revision, hash: plan.hash,
    decision: 'approve', owner_session_id: 'human-session', notify: false });
}
const registry = store => JSON.parse(store.db.prepare('SELECT value FROM registry WHERE id=1').get().value);
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('approved task -> blocked -> task and backlog -> tasks retain the reviewed revision', async t => {
  const { store, cwd } = await fixture(t);
  const plan = await approve(store);
  const decisions = (await store.read(plan.plan_id)).decisions;
  const blocked = await store.organize(input(plan, 'blocked'));
  assert.equal(blocked.category, 'blocked');
  assert.equal(blocked.execution_authorized, false);
  assert.equal(blocked.status, 'approved');
  assert.equal(blocked.revision, plan.revision);
  assert.equal(blocked.reopened, false);
  assert.equal(blocked.archived, false);
  assert.ok(fs.existsSync(path.join(cwd, '.plan', blocked.path)));
  assert.ok(!fs.existsSync(path.join(cwd, '.plan', plan.path)));
  const tasks = await store.organize(input(blocked, 'tasks'));
  assert.equal(tasks.execution_authorized, true);
  assert.deepEqual((await store.read(plan.plan_id)).decisions, decisions);
  const backlog = await approve(store, 'backlog');
  assert.equal((await store.organize(input(backlog, 'tasks'))).execution_authorized, true);
  assert.equal(registry(store).notifications.length, 0);
  assert.equal(registry(store).plans[plan.plan_id].organization_requests.length, 2);
});

test('staged and rejected change proposed category without review or path changes', async t => {
  const { store } = await fixture(t);
  const plan = await stage(store);
  const changed = await store.organize(input(plan, 'blocked'));
  assert.equal(changed.path, plan.path);
  assert.equal(changed.status, 'staged');
  assert.equal(changed.category, 'blocked');
  assert.equal(changed.execution_authorized, false);
  const rejected = await store.decide({ plan_id: plan.plan_id, revision: plan.revision, hash: plan.hash,
    decision: 'reject', owner_session_id: 'human-session', notify: false });
  const changedAgain = await store.organize(input(rejected, 'para-o-dono'));
  assert.equal(changedAgain.status, 'rejected');
  assert.equal(changedAgain.path, plan.path);
  assert.equal(changedAgain.revision, 1);
  assert.equal(changedAgain.execution_authorized, false);
});

test('closed -> each nonclosed category creates exact fresh staged revision and preserves history', async t => {
  const { store } = await fixture(t);
  for (const category of ['tasks', 'backlog', 'blocked', 'para-o-dono']) {
    const plan = await approve(store);
    const closed = await store.close({ plan_id: plan.plan_id, expected_revision: plan.revision,
      outcome: 'completed', reason: 'Fixture done', evidence: 'Fixture proof' });
    const before = registry(store).plans[plan.plan_id].revisions[0];
    const next = await store.organize(input(closed, category));
    assert.equal(next.plan_id, plan.plan_id);
    assert.equal(next.revision, 2);
    assert.equal(next.hash, plan.hash);
    assert.equal(next.category, category);
    assert.equal(next.status, 'staged');
    assert.equal(next.reopened, true);
    assert.equal(next.execution_authorized, false);
    assert.match(next.path, /^staging\/.*\.r2\.md$/);
    assert.deepEqual(registry(store).plans[plan.plan_id].revisions[0], before);
    const fresh = await store.read(plan.plan_id);
    assert.equal(fresh.content, (await store.read(plan.plan_id, { revision: 1 })).content);
    assert.deepEqual(fresh.decisions, []);
    assert.equal(fresh.closure, null);
    assert.equal((await store.history(plan.plan_id)).length, 2);
  }
});

test('imported tasks even same destination require fresh staged review', async t => {
  const { store } = await fixture(t, cwd => {
    fs.mkdirSync(path.join(cwd, '.plan', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.plan', 'tasks', '7-Imported.md'), '# Imported\nUntouched.\n');
  });
  const imported = await store.read(7);
  assert.equal(imported.status, 'approved');
  assert.equal(imported.execution_authorized, false);
  const before = registry(store).plans[7].revisions[0];
  const next = await store.organize(input(imported, 'tasks'));
  assert.equal(next.reopened, true);
  assert.equal(next.revision, 2);
  assert.equal(next.status, 'staged');
  assert.equal(next.execution_authorized, false);
  assert.deepEqual(registry(store).plans[7].revisions[0], before);
  const reviewed = await store.decide({ plan_id: 7, revision: 2, hash: next.hash,
    decision: 'approve', owner_session_id: 'human-session', notify: false });
  assert.equal(reviewed.execution_authorized, true);
});

test('revision/hash/authentication input guards and request fingerprint', async t => {
  const { store } = await fixture(t);
  const plan = await approve(store);
  await rejectsCode(store.organize(input(plan, 'blocked', { expected_revision: 2 })), 'STALE_REVISION');
  await rejectsCode(store.organize(input(plan, 'blocked', { hash: 'wrong' })), 'STALE_REVIEW');
  for (const extra of [{ owner_session_id: undefined }, { hash: undefined }, { origin: undefined },
    { origin: { session_id: 'human-session' } }, { origin: { call_id: 'x' } }, { category: 'staging' }]) {
    await rejectsCode(store.organize(input(plan, 'blocked', extra)), 'INVALID_INPUT');
  }
  const request = input(plan, 'blocked', { origin: { ...origin(), request_id: 'stable-request' } });
  const result = await store.organize(request);
  assert.deepEqual(await store.organize({ ...request, origin: { ...request.origin, call_id: 'retry-call' } }), result);
  for (const extra of [{ category: 'tasks' }, { hash: 'different' }, { expected_revision: 2 },
    { origin: { ...request.origin, session_id: 'other-session' } }]) {
    await rejectsCode(store.organize({ ...request, ...extra }), 'IDEMPOTENCY_CONFLICT');
  }
  assert.equal(registry(store).plans[plan.plan_id].organization_requests.length, 1);
});

test('fallback call id retries are idempotent after reopening and restart', async t => {
  const { store, open } = await fixture(t);
  const plan = await approve(store);
  const closed = await store.organize(input(plan, 'closed'));
  const request = input(closed, 'tasks');
  const result = await store.organize(request);
  assert.deepEqual(await store.organize(request), result);
  store.dispose();
  const restarted = await open();
  assert.deepEqual(await restarted.organize(request), result);
  assert.equal((await restarted.history(plan.plan_id)).length, 2);
  assert.equal(registry(restarted).plans[plan.plan_id].organization_requests.length, 2);
});

test('archive cancels, fabricates no completion evidence and already closed stays unchanged', async t => {
  const { store } = await fixture(t);
  const plan = await stage(store);
  const archived = await store.organize(input(plan, 'closed'));
  assert.equal(archived.archived, true);
  assert.equal(archived.status, 'closed');
  const closed = await store.read(plan.plan_id);
  assert.equal(closed.closure.outcome, 'cancelled');
  assert.equal(closed.closure.evidence, null);
  assert.match(closed.closure.reason, /organization/);
  const source = registry(store).plans[plan.plan_id].revisions[0];
  const noop = await store.organize(input(archived, 'closed'));
  assert.equal(noop.archived, false);
  assert.deepEqual(registry(store).plans[plan.plan_id].revisions[0], source);
  const completed = await approve(store);
  const completion = await store.close({ plan_id: completed.plan_id, expected_revision: 1,
    outcome: 'completed', reason: 'Real fixture completion', evidence: 'Existing proof' });
  const original = (await store.read(completed.plan_id)).closure;
  await store.organize(input(completion, 'closed'));
  assert.deepEqual((await store.read(completed.plan_id)).closure, original);
});

test('old SQLite state gains blocked additively on restart without DB/history loss', async t => {
  const { store, cwd, open } = await fixture(t);
  const plan = await approve(store);
  const before = registry(store);
  store.dispose();
  const blockedDir = path.join(cwd, '.plan', 'blocked');
  assert.equal(path.resolve(blockedDir), path.join(path.resolve(cwd), '.plan', 'blocked'));
  assert.equal(fs.readdirSync(blockedDir).length, 0);
  fs.rmdirSync(blockedDir);
  const restarted = await open();
  assert.ok(fs.statSync(blockedDir).isDirectory());
  assert.deepEqual(registry(restarted), before);
  assert.equal((await restarted.read(plan.plan_id)).execution_authorized, true);
  assert.equal((await restarted.organize(input(plan, 'blocked'))).execution_authorized, false);
});

test('committed organization recovers pending mirrors and retry exactly once after publication failure', async t => {
  const { store, open } = await fixture(t);
  const plan = await approve(store);
  const request = input(plan, 'blocked');
  const reconcile = store._reconcile.bind(store);
  let calls = 0;
  store._reconcile = state => {
    if (++calls === 2) throw new Error('Fixture publication failure');
    return reconcile(state);
  };
  await assert.rejects(store.organize(request), error => error.committed === true);
  store.dispose();
  const restarted = await open();
  const result = await restarted.organize(request);
  assert.equal(result.category, 'blocked');
  assert.equal(registry(restarted).mirrors.length, 0);
  assert.equal(registry(restarted).plans[plan.plan_id].organization_requests.length, 1);
});

test('review checks the displayed destination even when organization preserves revision and text hash', async t => {
  const { store } = await fixture(t);
  const proposal = await stage(store, 'tasks');
  await store.organize(input(proposal, 'blocked'));
  const review = { plan_id: proposal.plan_id, revision: proposal.revision, hash: proposal.hash,
    decision: 'approve', owner_session_id: 'human-session', notify: false };
  await rejectsCode(store.decide({ ...review, expected_category: 'tasks' }), 'STALE_REVIEW');
  assert.equal((await store.read(proposal.plan_id)).status, 'staged');
  const saved = await store.decide({ ...review, expected_category: 'blocked' });
  assert.equal(saved.category, 'blocked');
  assert.equal(saved.execution_authorized, false);
});
