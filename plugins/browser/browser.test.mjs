import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { hostRequire } from './host.mjs';
import { install } from './index.mjs';
import { BrowserError } from './errors.mjs';

const require = hostRequire();
const load = name => import(require.resolve(`@deepseek-ai/${name}`));
const [{ Context }, llm, sessions, scope, tools, policy] = await Promise.all([load('cordis'), load('dsh-llm'), load('dsh-session'), load('dsh-scope'), load('dsh-tools'), load('dsh-sandbox-policy')]);
const base = fileURLToPath(new URL('../../.dumps/tasks/task05-browser-tests/', import.meta.url));
await mkdir(base, { recursive: true });

async function fixture(mode = 'danger-full-access', profile = {}) {
  const cwd = await mkdtemp(join(base, 'host-'));
  const ctx = new Context();
  await ctx.plugin(llm.default);
  await ctx.plugin(sessions.default);
  await ctx.plugin((await load('dsh-session-projection')).default);
  await ctx.plugin(policy.default, { mode, workspaceRoot: cwd });
  await ctx.plugin((await load('dsh-fs-local')).default, { cwd });
  await ctx.plugin((await load('dsh-subprocess-local')).default);
  await ctx.plugin((await load('dsh-sandbox-local')).default, { probeTimeoutMs: 1000 });
  await ctx.plugin((await load('dsh-system-prompt')).default);
  await ctx.plugin(tools.ToolRuntime, { mode: 'native' });
  await ctx.plugin((await load('dsh-attachment-local')).default, { dshHome: join(cwd, 'attachment-home') });
  class FixtureAdapter extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text', 'image'] }; }
    async *stream() { throw new Error('Offline browser suite must not call an LLM'); }
  }
  ctx.llm.registerAdapter(['browser-fixture'], new FixtureAdapter());
  const installed = install(ctx, { browserCache: join(process.env.HOME, '.cache', 'dsh-browser', 'task05-stable'), ...profile });
  ctx.tools.register({ name: 'safe_fixture', description: 'Safe test-only tool', parameters: { type: 'object', properties: {}, additionalProperties: false }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'safe' });
  let count = 0;
  function agent(parent = ctx) {
    const session = ctx.sessions.create(sessions.SessionId(`browser-${Math.random()}`), { meta: { cwd } });
    session.append('request/header', { reason: 'fixture', header: { config: { provider: 'browser-fixture', model: 'image' } } });
    const agent = { session, options: { provider: 'browser-fixture', model: 'image' } };
    const owned = scope.createScope(parent, agent); agent.ctx = owned.ctx;
    return agent;
  }
  const owner = agent();
  const call = (operation, args = {}, refs = {}, current = owner, signal = AbortSignal.timeout(55000)) => ctx.tools.execute({ name: 'browser', callId: llm.ToolCallId(`browser-call-${++count}`), arguments: { operation, args, ...refs }, agent: current, signal });
  return { ctx, cwd, owner, agent, call, ...installed, async close() { await installed.broker.close(); await ctx.fiber.dispose(); } };
}

function ok(result) {
  assert.equal(result.isError, false, JSON.stringify(result.error));
  return result.value;
}

test('one native inherited root; discovery bounded; child filter and invalid leaf cannot launch', async () => {
  const f = await fixture();
  try {
    assert.equal(f.ctx.tools.schemas(f.owner).filter(row => row.name === 'browser').length, 1);
    const help = ok(await f.call('help'));
    assert.ok(help.data.items.length <= 12); assert.equal(help.imageRefs.length, 0);
    assert.equal(f.broker.owner(f.owner).slot, null);
    const describe = ok(await f.call('describe', {}, { path: 'media.screenshot' }));
    assert.equal(describe.data.operation, 'media.screenshot');
    const child = f.agent(f.owner.ctx); child.ctx.get('tools').restrict({ allow: ['safe_fixture'] });
    assert.equal(f.ctx.tools.schemas(child).some(row => row.name === 'browser'), false);
    const hidden = await f.call('session.open', {}, {}, child);
    assert.equal(hidden.isError, true); assert.equal(hidden.error.info.code, 'UNKNOWN_TOOL');
    assert.equal(f.broker.records.size, 1);
    const invalid = await f.call('session.open', { code: 'unsafe' });
    assert.equal(invalid.isError, true); assert.equal(invalid.error.info.code, 'INVALID_ARGS');
    assert.equal(f.broker.owner(f.owner).slot, null);
  } finally { await f.close(); }
});

test('read-only is metadata-only, approval missing denies sensitive operation before a worker', async () => {
  const f = await fixture('read-only');
  try {
    const caps = ok(await f.call('capabilities')); assert.equal(caps.data.policy.statefulAllowed, false);
    const denied = await f.call('session.open'); assert.equal(denied.isError, true); assert.equal(denied.error.info.code, 'POLICY_DENIED');
    assert.equal(f.broker.records.size, 0);
    policy.setSandboxMode(f.owner.session, 'danger-full-access');
    const trace = await f.call('media.trace.start', {}, { sessionId: 'bs_fixture' });
    assert.equal(trace.isError, true); assert.equal('value' in trace, false);
    assert.equal(f.broker.records.size, 0);
  } finally { await f.close(); }
});

test('real native managed SDK worker targets owned Pages and delivers native screenshot image', { timeout: 90000 }, async () => {
  const f = await fixture();
  const html = '<!doctype html><title>Same fixture</title><h1>Owned fixture</h1><button onclick="window.count++;document.querySelector(\'output\').textContent=window.count">Increment</button><output>0</output><script>window.count=0</script>';
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const opened = ok(await f.call('session.open'));
    const sessionId = opened.refs.sessionId;
    const pages = ok(await f.call('page.list', {}, { sessionId })).data.pages;
    assert.equal(pages.length, 1);
    const pageId = pages[0].pageId;
    ok(await f.call('page.navigate', { url }, { sessionId, pageId }));
    const another = ok(await f.call('page.create', { url }, { sessionId }));
    const secondId = another.data.pageId;
    const ambiguous = await f.call('interact.click', { target: { kind: 'role', role: 'button', name: 'Increment', exact: true } }, { sessionId });
    assert.equal(ambiguous.isError, true);
    ok(await f.call('interact.click', { target: { kind: 'role', role: 'button', name: 'Increment', exact: true } }, { sessionId, pageId }));
    const snapshot = ok(await f.call('observe.snapshot', {}, { sessionId, pageId }));
    assert.ok(snapshot.data.snapshot.includes('Increment'));
    const second = ok(await f.call('observe.snapshot', {}, { sessionId, pageId: secondId }));
    assert.ok(second.data.snapshot.includes('0'));
    const deliveryStarted = Date.now();
    const shot = ok(await f.call('media.screenshot', { mode: 'viewport', format: 'png', scale: 'css' }, { sessionId, pageId }));
    assert.equal(shot.imageRefs.length, 1);
    assert.ok(shot.artifacts[0].bytes > 0);
    const retentionMs = f.broker.owner(f.owner).config.deliveryRetentionMs;
    assert.ok(Date.parse(shot.artifacts[0].retentionUntil) >= deliveryStarted + retentionMs);
    assert.ok(Date.parse(shot.artifacts[0].retentionUntil) <= Date.now() + retentionMs);
    const persisted = await f.broker.files.findArtifact(f.broker.owner(f.owner), shot.artifacts[0].artifactId);
    assert.equal(persisted.retentionUntil, shot.artifacts[0].retentionUntil);
    assert.equal(persisted.sha256, shot.artifacts[0].sha256);
    assert.equal(JSON.stringify(shot).includes('iVBOR'), false);
    const image = await f.ctx.attachments.readImage(shot.imageRefs[0]); assert.ok(image.data.byteLength > 0);
    ok(await f.call('page.close', {}, { sessionId, pageId }));
    const stale = await f.call('interact.click', { target: { kind: 'role', role: 'button', name: 'Increment', exact: true } }, { sessionId, pageId });
    assert.equal(stale.isError, true);
    const after = ok(await f.call('observe.snapshot', {}, { sessionId, pageId: secondId })); assert.ok(after.data.snapshot.includes('0'));
    const destination = join(f.cwd, 'export.png');
    const exported = ok(await f.call('artifacts.export', { artifactId: shot.artifacts[0].artifactId, destination }));
    assert.equal(exported.data.path, destination); assert.ok((await readFile(destination)).length > 0);
    const overwrite = await f.call('artifacts.export', { artifactId: shot.artifacts[0].artifactId, destination }); assert.equal(overwrite.isError, true);
    const slot = f.broker.owner(f.owner).slot;
    await f.broker.close();
    assert.equal(slot.transport.cleanup.ownedRangeEmpty, true);
    assert.equal(ok(await f.call('session.status', {}, { sessionId })).data.state, 'closed');
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test('workspace-write confines the real Chromium worker and joins its process range', { timeout: 60000 }, async () => {
  const f = await fixture('workspace-write');
  try {
    const opened = ok(await f.call('session.open'));
    const record = f.broker.owner(f.owner);
    assert.ok(record.artifactRoot.startsWith(f.cwd));
    assert.equal(record.slot.transport.policy.mode, 'workspace-write');
    const slot = record.slot;
    ok(await f.call('media.screenshot', {}, { sessionId: opened.refs.sessionId, pageId: opened.refs.pageId }));
    await f.broker.close();
    assert.equal(slot.transport.cleanup.ownedRangeEmpty, true);
  } finally { await f.close(); }
});

test('cancelled real page action joins Chromium range and invalidates owned handles', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const opened = ok(await f.call('session.open'));
    const record = f.broker.owner(f.owner);
    const slot = record.slot;
    const controller = new AbortController();
    const pending = f.call('page.wait', { text: 'Never exists', timeoutMs: 5000 }, { sessionId: opened.refs.sessionId, pageId: opened.refs.pageId }, f.owner, controller.signal);
    const timer = setTimeout(() => controller.abort(new Error('Fixture caller cancellation')), 150);
    let result;
    try { result = await pending; } finally { clearTimeout(timer); }
    assert.equal(result.isError, true);
    await record.queue;
    assert.equal(slot.transport.cleanup.ownedRangeEmpty, true);
    assert.equal(record.slot, null);
    assert.equal(ok(await f.call('session.status', {}, { sessionId: opened.refs.sessionId })).data.state, 'closed');
  } finally { await f.close(); }
});

test('policy narrowing joins old range, uses writable namespace and preserves owned artifact metadata', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const opened = ok(await f.call('session.open'));
    const shot = ok(await f.call('media.screenshot', {}, { sessionId: opened.refs.sessionId }));
    const record = f.broker.owner(f.owner);
    const old = record.slot, oldRoot = record.artifactRoot;
    policy.setSandboxMode(f.owner.session, 'workspace-write');
    await Promise.all(f.broker.cleanupTasks);
    assert.equal(old.transport.cleanup.ownedRangeEmpty, true);
    const next = ok(await f.call('session.open'));
    assert.ok(record.artifactRoot.startsWith(f.cwd)); assert.notEqual(record.artifactRoot, oldRoot);
    assert.equal(record.artifactRoots.size, 2);
    ok(await f.call('artifacts.inspect', { artifactId: shot.artifacts[0].artifactId }));
    const destination = join(f.cwd, 'prior-generation.png');
    ok(await f.call('artifacts.export', { artifactId: shot.artifacts[0].artifactId, destination }));
    assert.ok((await readFile(destination)).length > 0);
    const stale = await f.call('page.list', {}, { sessionId: opened.refs.sessionId }); assert.equal(stale.isError, true);
    ok(await f.call('page.list', {}, { sessionId: next.refs.sessionId }));
  } finally { await f.close(); }
});

test('SIGKILL of the owned worker joins orphaned Chromium range and permits a fresh session', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const opened = ok(await f.call('session.open'));
    const record = f.broker.owner(f.owner), old = record.slot;
    assert.ok(old.workerPid > 1 && old.workerPid !== process.pid);
    const before = await readFile(`/proc/${old.workerPid}/stat`, 'utf8');
    const startTicks = before.slice(before.lastIndexOf(')') + 2).split(' ')[19];
    assert.ok(startTicks);
    // Identity is authenticated by this private worker's handshake, immediately rechecked before SIGKILL.
    const current = await readFile(`/proc/${old.workerPid}/stat`, 'utf8');
    assert.equal(current.slice(current.lastIndexOf(')') + 2).split(' ')[19], startTicks);
    process.kill(old.workerPid, 'SIGKILL');
    await old.transport.handle.done;
    await old.transport.close();
    await Promise.all(f.broker.cleanupTasks);
    assert.equal(old.transport.cleanup.ownedRangeEmpty, true);
    const fresh = ok(await f.call('session.open'));
    assert.notEqual(fresh.refs.sessionId, opened.refs.sessionId);
    assert.notEqual(record.slot, old);
    assert.equal(ok(await f.call('session.status', {}, { sessionId: opened.refs.sessionId })).data.state, 'closed');
  } finally { await f.close(); }
});

test('live session metadata refreshes actual idle closure without restarting the worker', { timeout: 90000 }, async () => {
  const f = await fixture('danger-full-access', { limits: { idleMs: 150 } });
  try {
    const opened = ok(await f.call('session.open'));
    const record = f.broker.owner(f.owner), slot = record.slot;
    // This timer is the tested session idle period, not polling a background job.
    await new Promise(resolve => setTimeout(resolve, 350));
    const status = ok(await f.call('session.status', {}, { sessionId: opened.refs.sessionId }));
    assert.equal(status.data.state, 'closed'); assert.equal(status.data.pages.length, 0);
    const list = ok(await f.call('session.list'));
    assert.equal(list.data.sessions.find(item => item.sessionId === opened.refs.sessionId).state, 'closed');
    assert.equal(record.slot, slot); assert.equal(status.imageRefs.length, 0);
    await f.broker.discard(record);
    const cached = ok(await f.call('session.status', {}, { sessionId: opened.refs.sessionId }));
    assert.ok(cached.warnings.some(item => item.code === 'LAST_KNOWN_STATUS'));
    assert.equal(record.slot, null);
  } finally { await f.close(); }
});

test('read-only capture status reads owned finalization metadata without launching or admitting images', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const opened = ok(await f.call('session.open'));
    const refs = { sessionId: opened.refs.sessionId, pageId: opened.refs.pageId };
    const started = ok(await f.call('media.video.start', { maxDurationMs: 10000, fps: 10 }, refs));
    const captureId = started.data.captureId;
    const live = ok(await f.call('media.video.status', { captureId }, { sessionId: refs.sessionId }));
    assert.equal(live.data.state, 'recording'); assert.equal(live.imageRefs.length, 0);
    const record = f.broker.owner(f.owner), old = record.slot;
    policy.setSandboxMode(f.owner.session, 'read-only');
    const metadata = ok(await f.call('media.video.status', { captureId }, { sessionId: refs.sessionId }));
    assert.equal(record.slot, null); assert.equal(old.transport.cleanup.ownedRangeEmpty, true);
    assert.ok(['finalized', 'partial', 'failed'].includes(metadata.data.state));
    assert.equal(metadata.imageRefs.length, 0); assert.equal(metadata.artifacts.length, 0);
    assert.ok(metadata.warnings.some(item => item.code === 'LAST_KNOWN_STATUS'));
    const unknown = await f.call('media.video.status', { captureId: 'bc_unknown' }, { sessionId: refs.sessionId });
    assert.equal(unknown.isError, true); assert.equal(record.slot, null);
  } finally { await f.close(); }
});

test('two real Agents sharing a cwd cannot use each other’s sessions, pages or artifact identifiers', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const parent = ok(await f.call('session.open'));
    const image = ok(await f.call('media.screenshot', {}, { sessionId: parent.refs.sessionId, pageId: parent.refs.pageId }));
    const child = f.agent(f.owner.ctx);
    const childSession = ok(await f.call('session.open', {}, {}, child));
    assert.notEqual(childSession.refs.sessionId, parent.refs.sessionId);
    assert.notEqual(f.broker.owner(child).ownerId, f.broker.owner(f.owner).ownerId);
    const foreign = await f.call('session.status', {}, { sessionId: parent.refs.sessionId }, child);
    assert.equal(foreign.isError, true); assert.equal(foreign.error.info.code, 'SESSION_NOT_FOUND');
    const artifact = await f.call('artifacts.inspect', { artifactId: image.artifacts[0].artifactId }, {}, child);
    assert.equal(artifact.isError, true); assert.equal(artifact.error.info.code, 'ARTIFACT_NOT_FOUND');
    const foreignPage = await f.call('page.close', {}, { sessionId: childSession.refs.sessionId, pageId: parent.refs.pageId }, child);
    assert.equal(foreignPage.isError, true);
    assert.equal(ok(await f.call('page.list', {}, { sessionId: parent.refs.sessionId })).data.pages.length, 1);
    assert.equal(ok(await f.call('page.list', {}, { sessionId: childSession.refs.sessionId }, child)).data.pages.length, 1);
  } finally { await f.close(); }
});

test('project denial during native bootstrap prevents a worker and releases host capacity', { timeout: 90000 }, async () => {
  const f = await fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const bootstrapped = new Promise(resolve => { entered = resolve; });
  const original = f.broker.files.bootstrap.bind(f.broker.files);
  f.broker.files.bootstrap = async (...args) => { const root = await original(...args); entered(); await gate; return root; };
  try {
    const opening = f.call('session.open');
    await bootstrapped;
    await mkdir(join(f.cwd, '.git'));
    await mkdir(join(f.cwd, '.agents'));
    await writeFile(join(f.cwd, '.agents', 'config.json'), JSON.stringify({ dshCustoms: { browser: { enabled: false } } }));
    release();
    const result = await opening;
    assert.equal(result.isError, true);
    assert.equal(f.broker.owner(f.owner).slot, null);
    assert.deepEqual(f.broker.capacity.snapshot().reserved, { workers: 0, contexts: 0, ownerBytes: 0 });
  } finally { release(); await f.close(); }
});

test('invalid current project configuration retires a live native browser before status dispatch', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const opened = ok(await f.call('session.open'));
    const record = f.broker.owner(f.owner), old = record.slot;
    await mkdir(join(f.cwd, '.git'));
    await mkdir(join(f.cwd, '.agents'));
    await writeFile(join(f.cwd, '.agents', 'config.json'), '{broken fixture configuration');
    const result = await f.call('session.status', {}, { sessionId: opened.refs.sessionId });
    assert.equal(result.isError, true);
    assert.equal(record.slot, null); assert.equal(old.transport.cleanup.ownedRangeEmpty, true);
    assert.equal(f.broker.capacity.snapshot().reserved.workers, 0);
  } finally { await f.close(); }
});

test('small administrative root deadline preserves all metadata but denies stateful bootstrap', async () => {
  const f = await fixture('danger-full-access', { limits: { rootMs: 2000, finalizeMs: 1000 } });
  let bootstraps = 0;
  f.broker.files.bootstrap = async () => { bootstraps++; throw new Error('Small work budget must never bootstrap'); };
  try {
    assert.equal(f.definition.timeoutMs, 2000);
    ok(await f.call('help'));
    assert.deepEqual(ok(await f.call('session.list')).data.sessions, []);
    const opened = await f.call('session.open');
    assert.equal(opened.isError, true); assert.equal(opened.error.info.code, 'POLICY_DENIED');
    policy.setSandboxMode(f.owner.session, 'read-only');
    assert.deepEqual(ok(await f.call('session.list')).data.sessions, []);
    assert.equal(bootstraps, 0);
    assert.equal(f.broker.capacity.snapshot().reserved.workers, 0);
  } finally { await f.close(); }
});

test('post-screenshot delivery timeout reports completed-effect uncertainty and never repeats capture', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const opened = ok(await f.call('session.open'));
    const record = f.broker.owner(f.owner), slot = record.slot;
    let confirmations = 0;
    f.broker.confirmDelivery = async () => { confirmations++; throw new BrowserError('DEADLINE_EXCEEDED', 'Fixture delivery deadline elapsed.'); };
    const result = await f.call('media.screenshot', { mode: 'viewport', format: 'png', scale: 'css' }, { sessionId: opened.refs.sessionId, pageId: opened.refs.pageId });
    assert.equal(result.isError, true); assert.equal(result.error.info.code, 'DEADLINE_EXCEEDED');
    assert.match(JSON.stringify(result.error), /effects may already have completed/);
    assert.equal(confirmations, 1);
    const artifacts = await f.broker.files.listArtifacts(record);
    assert.equal(artifacts.length, 1); assert.equal(artifacts[0].state, 'finalized'); assert.ok(artifacts[0].bytes > 0);
    assert.equal(record.slot, null); assert.equal(slot.transport.cleanup.ownedRangeEmpty, true);
  } finally { await f.close(); }
});

test('native Agent scope disposal joins its worker without a global event and replacement cannot resume handles', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const opened = ok(await f.call('session.open'));
    const record = f.broker.owner(f.owner), slot = record.slot;
    await f.owner.ctx.fiber.dispose();
    assert.equal(record.disposed, true); assert.equal(record.slot, null);
    assert.equal(slot.transport.cleanup.ownedRangeEmpty, true);
    assert.equal(f.broker.capacity.snapshot().reserved.workers, 0);
    const replacement = f.agent();
    const stale = await f.call('session.status', {}, { sessionId: opened.refs.sessionId }, replacement);
    assert.equal(stale.isError, true); assert.equal(stale.error.info.code, 'SESSION_NOT_FOUND');
    const fresh = ok(await f.call('session.open', {}, {}, replacement));
    assert.notEqual(fresh.refs.sessionId, opened.refs.sessionId);
  } finally { await f.close(); }
});
