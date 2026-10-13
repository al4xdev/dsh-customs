import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserRuntime } from './runtime.mjs';
import { ArtifactStore } from './artifacts.mjs';
import { imageDimensions } from './capture.mjs';
import { catalogRevision, CATALOG_REVISION } from '../manifest.mjs';
import { normalizeConfig } from '../config.mjs';

const base = resolve('.dumps/tasks/task05-worker-tests');
async function scratch() { await mkdir(base, { recursive: true }); return mkdtemp(join(base, 'case-')); }
const live = process.env.DSH_BROWSER_LIVE === '1';
const role = (role, name) => ({ kind: 'role', role, name });
const fixture = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Identical fixture</title><style>body{margin:0;font:18px sans-serif;color:#123;background:white}header{padding:24px;min-height:240px}button{padding:16px;background:#168;color:white;font-size:20px}output{display:block;font-size:30px}main{height:2300px;background:linear-gradient(white,#8bd)}input{margin:8px}#drop{margin:10px;width:120px;height:70px;background:#cec}</style><header><h1>Browser runtime fixture</h1><button aria-label="Increment" onclick="document.querySelector('output').textContent=String(++window.count)">Increment</button><output role="status">0</output><label>Name<input aria-label="Name"></label><label>Upload<input type="file" aria-label="Upload" multiple></label><button aria-label="Confirm" onclick="document.querySelector('output').textContent=confirm('Confirm fixture?')?'accepted':'dismissed'">Confirm</button><a href="/download" download="fixture.txt">Download</a></header><main><div draggable="true" aria-label="Drag source" role="button">Source</div><div id="drop" aria-label="Drop target" role="button">Destination</div></main><iframe title="child" src="/child"></iframe><script>window.count=0;window.touch=[];for(const type of ['touchstart','touchmove','touchend'])document.addEventListener(type,e=>window.touch.push({type:e.type,trusted:e.isTrusted}),{passive:true});document.querySelector('main').addEventListener('dragover',e=>e.preventDefault());document.querySelector('#drop').addEventListener('drop',e=>{e.preventDefault();e.currentTarget.textContent='Dropped'});console.log('fixture-ready');</script>`;
async function setup(t, config = {}) {
  const root = await scratch();
  const { openArgs = {}, ...runtimeConfig } = config;
  const server = createServer((req, res) => {
    if (req.url === '/download') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="fixture.txt"' }); res.end('fixture download'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(req.url === '/child' ? '<button aria-label="Child button">Child</button>' : fixture);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = new BrowserRuntime({ ownerId: randomUUID(), artifactRoot: root, config: { ...runtimeConfig, limits: { freeDiskBytes: 1, actionMs: 3000, navigationMs: 10000, finalizeMs: 15000, videoDurationMs: 10000, ...runtimeConfig.limits } }, toolPaths: { ffprobe: '/usr/bin/ffprobe', ffmpeg: '/usr/bin/ffmpeg' } });
  t.after(async () => { await runtime.close(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const call = (operation, args = {}, refs = {}, context = {}) => runtime.execute({ operation, args, ...refs }, { callId: randomUUID(), ...context });
  const opened = await call('session.open', openArgs);
  const refs = { sessionId: opened.refs.sessionId, pageId: opened.refs.pageId };
  await call('page.navigate', { url, waitUntil: 'load' }, refs);
  return { runtime, call, refs, root, url };
}

test('artifact store creates owned exclusive names, final hashes and exact metadata', async () => {
  const root = await scratch();
  const store = new ArtifactStore({ root, ownerId: 'store-owner', limits: { freeDiskBytes: 1, ownerBytes: 10000, sessionBytes: 10000 } });
  const bytes = Buffer.from('binary\u0000bytes');
  const a = await store.write({ data: bytes, kind: 'text', mime: 'text/plain', extension: 'txt', sessionId: 'bs_test' });
  const b = await store.write({ data: bytes, kind: 'text', mime: 'text/plain', extension: 'txt', sessionId: 'bs_test' });
  assert.notEqual(a.path, b.path);
  assert.equal(a.bytes, bytes.length);
  assert.equal(a.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(a.path), bytes);
  assert.equal(store.list().length, 2);
  assert.throws(() => store.inspect('ba_foreign'), { code: 'ARTIFACT_NOT_FOUND' });
  await assert.rejects(store.reserve({ kind: 'text', mime: 'text/plain', extension: '../../escape' }), { code: 'INVALID_ARGS' });
});

test('delivery promotion replaces only retentionUntil and persists across recovery', async () => {
  const root = await scratch();
  const options = { root, ownerId: 'delivery-owner', limits: { freeDiskBytes: 1, retentionMs: 86400_000, deliveryRetentionMs: 7 * 86400_000 } };
  const store = new ArtifactStore(options);
  const spec = { data: Buffer.from('immutable delivery'), kind: 'text', mime: 'text/plain', extension: 'txt' };
  const first = await store.write(spec);
  const raw = await store.write(spec);
  const names = await readdir(root);
  const before = Date.now();
  const [promoted] = await store.confirmDelivery([first.artifactId]);
  assert.ok(Date.parse(promoted.retentionUntil) >= before + 7 * 86400_000);
  assert.ok(Date.parse(promoted.retentionUntil) <= Date.now() + 7 * 86400_000);
  assert.deepEqual({ ...promoted, retentionUntil: first.retentionUntil }, first);
  assert.deepEqual(store.inspect(raw.artifactId), raw);
  assert.deepEqual(await readdir(root), names);
  assert.deepEqual(await readFile(first.path), spec.data);
  assert.equal(JSON.parse(await readFile(join(root, `${first.artifactId}.json`))).retentionUntil, promoted.retentionUntil);
  const recovered = new ArtifactStore(options);
  await recovered.initialize();
  assert.deepEqual(recovered.inspect(first.artifactId), promoted);
  assert.deepEqual(recovered.inspect(raw.artifactId), raw);
});

test('runtime delivery honours delivery1000 below raw24h and remains private', async t => {
  const runtime = new BrowserRuntime({ ownerId: 'narrow-owner', artifactRoot: await scratch(), config: { deliveryRetentionMs: 1000, limits: { freeDiskBytes: 1 } } });
  t.after(() => runtime.close());
  const artifact = await runtime.artifacts.write({ data: Buffer.from('delivery'), kind: 'text', mime: 'text/plain', extension: 'txt' });
  const before = Date.now();
  const ack = await runtime.confirmDelivery({ artifactIds: [artifact.artifactId] }, { deadlineMs: before + 10000 });
  assert.deepEqual(Object.keys(ack), ['artifacts']);
  assert.ok(Date.parse(ack.artifacts[0].retentionUntil) >= before + 1000);
  assert.ok(Date.parse(ack.artifacts[0].retentionUntil) <= Date.now() + 1000);
  assert.ok(Date.parse(ack.artifacts[0].retentionUntil) < Date.parse(artifact.retentionUntil));
  await assert.rejects(runtime.execute({ operation: '__delivered', args: { artifactIds: [artifact.artifactId] } }), { code: 'UNKNOWN_OPERATION' });
  const ttl = runtime.artifacts.inspect(artifact.artifactId).retentionUntil;
  await runtime.execute({ operation: 'artifacts.inspect', args: { artifactId: artifact.artifactId } });
  await runtime.execute({ operation: 'artifacts.list', args: {} });
  assert.equal(runtime.artifacts.inspect(artifact.artifactId).retentionUntil, ttl);
  assert.equal(runtime.sessions.browser, null);
});

test('private delivery rejects malformed IDs, getters, deep args, duplicates, unknown and unfinalized sources', async t => {
  const runtime = new BrowserRuntime({ ownerId: 'validation-owner', artifactRoot: await scratch(), config: { limits: { freeDiskBytes: 1 } } });
  t.after(() => runtime.close());
  const artifact = await runtime.artifacts.write({ data: Buffer.from('source'), kind: 'text', mime: 'text/plain', extension: 'txt' });
  const pending = await runtime.artifacts.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' });
  let getters = 0;
  const getterArgs = Object.defineProperty({}, 'artifactIds', { enumerable: true, get() { getters++; return [artifact.artifactId]; } });
  const getterIDs = Object.defineProperty([artifact.artifactId], '0', { get() { getters++; return artifact.artifactId; } });
  for (const args of [getterArgs, { artifactIds: getterIDs }, {}, { artifactIds: [], extra: true }, { artifactIds: [] }, { artifactIds: [artifact.artifactId, artifact.artifactId] }, { artifactIds: Array.from({ length: 9 }, () => `ba_${randomUUID()}`) }, { artifactIds: ['../../outside'] }, { artifactIds: [[[[artifact.artifactId]]]] }, { artifactIds: new Array(1) }]) {
    await assert.rejects(runtime.confirmDelivery(args), { code: 'INVALID_ARGS' });
  }
  assert.equal(getters, 0);
  await assert.rejects(runtime.confirmDelivery({ artifactIds: [`ba_${randomUUID()}`] }), { code: 'ARTIFACT_NOT_FOUND' });
  await assert.rejects(runtime.confirmDelivery({ artifactIds: [pending.artifactId] }), { code: 'ARTIFACT_NOT_FINALIZED' });
  for (const state of ['partial', 'failed', 'expired']) {
    await runtime.artifacts.mark(pending.artifactId, state);
    await assert.rejects(runtime.confirmDelivery({ artifactIds: [pending.artifactId] }), { code: 'ARTIFACT_NOT_FINALIZED' });
  }
  const sidecarPath = join(runtime.artifacts.root, `${artifact.artifactId}.json`);
  await writeFile(sidecarPath, JSON.stringify({ ...artifact, retentionUntil: new Date(0).toISOString() }));
  await assert.rejects(runtime.confirmDelivery({ artifactIds: [artifact.artifactId] }), { code: 'ARTIFACT_PATH_DENIED' });
  await writeFile(sidecarPath, JSON.stringify(artifact));
  const markerPath = join(runtime.artifacts.root, '.owner.json');
  const marker = await readFile(markerPath);
  await writeFile(markerPath, JSON.stringify({ ownerId: 'foreign-owner' }));
  await assert.rejects(runtime.confirmDelivery({ artifactIds: [artifact.artifactId] }), { code: 'ARTIFACT_PATH_DENIED' });
  await writeFile(markerPath, marker);
  await writeFile(artifact.path, 'tamper');
  await assert.rejects(runtime.confirmDelivery({ artifactIds: [artifact.artifactId] }), { code: 'ARTIFACT_NOT_FINALIZED' });
  assert.equal(runtime.artifacts.inspect(artifact.artifactId).retentionUntil, artifact.retentionUntil);
});

test('delivery cancellation, deadlines, foreign IDs and mid-list failure never return success', async () => {
  const options = { root: await scratch(), ownerId: 'cancel-owner', limits: { freeDiskBytes: 1, retentionMs: 86400_000 } };
  const store = new ArtifactStore(options);
  const artifact = await store.write({ data: Buffer.from('source'), kind: 'text', mime: 'text/plain', extension: 'txt' });
  const foreign = new ArtifactStore({ ...options, root: await scratch(), ownerId: 'foreign' });
  const other = await foreign.write({ data: Buffer.from('foreign'), kind: 'text', mime: 'text/plain', extension: 'txt' });
  await assert.rejects(store.confirmDelivery([other.artifactId]), { code: 'ARTIFACT_NOT_FOUND' });
  await assert.rejects(store.confirmDelivery([artifact.artifactId], { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
  await assert.rejects(store.confirmDelivery([artifact.artifactId], { deadlineMs: Date.now() - 1 }), { code: 'DEADLINE_EXCEEDED' });
  assert.equal(store.inspect(artifact.artifactId).retentionUntil, artifact.retentionUntil);
  await assert.rejects(store.confirmDelivery([artifact.artifactId, other.artifactId]), { code: 'ARTIFACT_NOT_FOUND' });
  assert.ok(Date.parse(store.inspect(artifact.artifactId).retentionUntil) > Date.parse(artifact.retentionUntil));
  const controller = new AbortController();
  const persist = store.persist.bind(store);
  store.persist = async record => { await persist(record); controller.abort(); };
  await assert.rejects(store.confirmDelivery([artifact.artifactId], { signal: controller.signal }), { code: 'CANCELLED' });
  const recovered = new ArtifactStore(options);
  await recovered.initialize();
  assert.equal(recovered.inspect(artifact.artifactId).retentionUntil, store.inspect(artifact.artifactId).retentionUntil);
});

test('artifact quota overshoot is partial, never a completed delivery', async () => {
  const store = new ArtifactStore({ root: await scratch(), ownerId: 'store-owner', limits: { freeDiskBytes: 1, ownerBytes: 10000, sessionBytes: 3 } });
  await assert.rejects(store.write({ data: Buffer.from('12345'), kind: 'text', mime: 'text/plain', extension: 'txt', sessionId: 's' }), { code: 'LIMIT_EXCEEDED' });
  assert.equal(store.list()[0].state, 'partial');
  assert.equal(store.list()[0].bytes, 5);
});

test('invalid calls are rejected before any browser startup and cursors are query-bound', async () => {
  const runtime = new BrowserRuntime({ ownerId: 'test-owner', artifactRoot: await scratch(), config: { limits: { freeDiskBytes: 1 } } });
  await assert.rejects(runtime.execute({ operation: 'run_code_unsafe', args: {} }, { callId: 'test' }), { code: 'UNKNOWN_OPERATION' });
  await assert.rejects(runtime.execute({ operation: 'session.open', args: { launchOptions: { args: ['--no-sandbox'] } } }, { callId: 'test' }), { code: 'INVALID_ARGS' });
  assert.equal(runtime.sessions.browser, null);
  const cursor = runtime.encodeCursor('one', 12);
  assert.equal(runtime.decodeCursor(cursor, 'one'), 12);
  assert.throws(() => runtime.decodeCursor(cursor, 'two'), { code: 'INVALID_CURSOR' });
  assert.throws(() => runtime.decodeCursor(cursor + 'x', 'one'), { code: 'INVALID_CURSOR' });
  await runtime.close();
});

test('encoded image header dimensions are verified, malformed data is rejected', () => {
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(393, 16); png.writeUInt32BE(852, 20);
  assert.deepEqual(imageDimensions(png, 'png'), { width: 393, height: 852 });
  assert.throws(() => imageDimensions(Buffer.from('not image'), 'png'), { code: 'BACKEND_INVALID_OUTPUT' });
});

test('live stable runtime: Page-bound refs, duplicates, frames, stale docs, session replacement', { skip: !live }, async t => {
  const { runtime, call, refs, url } = await setup(t);
  const snapshot = await call('observe.snapshot', {}, refs);
  assert.equal(snapshot.data.format, 'aria-yaml');
  const button = snapshot.data.targets.find(item => item.role === 'button' && item.name === 'Increment');
  assert.ok(button);
  const target = { kind: 'ref', snapshotId: button.snapshotId, ref: button.ref };
  await call('interact.click', { target }, refs);
  assert.equal((await call('observe.text', { target: role('status', '') }, refs)).data.text, '1');
  const second = await call('page.create', { url }, { sessionId: refs.sessionId });
  await assert.rejects(call('interact.click', { target }, { sessionId: refs.sessionId, pageId: second.data.pageId }), { code: 'STALE_SNAPSHOT' });
  await assert.rejects(call('interact.click', { target: role('button', 'Increment') }, { sessionId: refs.sessionId }), { code: 'INVALID_ARGS' });
  await call('page.close', {}, refs);
  await assert.rejects(call('interact.click', { target }, refs), { code: 'PAGE_NOT_FOUND' });
  const survivor = { sessionId: refs.sessionId, pageId: second.data.pageId };
  assert.equal((await call('observe.text', { target: role('status', '') }, survivor)).data.text, '0');
  await call('interact.click', { target: role('button', 'Increment') }, survivor);
  assert.equal((await call('observe.text', { target: role('status', '') }, survivor)).data.text, '1');
  const frames = await call('page.frames', {}, survivor);
  const child = frames.data.frames.find(item => !item.isMain);
  assert.ok(child);
  const childSnapshot = await call('observe.snapshot', { frameId: child.frameId }, survivor);
  assert.ok(childSnapshot.data.targets.some(item => item.name === 'Child button'));
  await call('page.navigate', { url, waitUntil: 'load' }, survivor);
  await assert.rejects(call('observe.snapshot', { frameId: child.frameId }, survivor), { code: 'STALE_HANDLE' });
  await assert.rejects(call('page.navigate', { url: 'javascript:alert(1)' }, survivor), { code: 'INVALID_ARGS' });
  const fresh = await call('observe.snapshot', {}, survivor);
  const freshButton = fresh.data.targets.find(item => item.name === 'Increment');
  await runtime.sessions.get(refs.sessionId).pages.get(second.data.pageId).page.getByRole('button', { name: 'Increment', exact: true }).evaluate(element => element.parentNode.appendChild(element.cloneNode(true)));
  await assert.rejects(call('interact.click', { target: role('button', 'Increment') }, survivor), { code: 'AMBIGUOUS_TARGET' });
  const duplicateSnapshot = await call('observe.snapshot', {}, survivor);
  assert.ok(!duplicateSnapshot.data.targets.some(item => item.name === 'Increment'));
  await call('page.navigate', { url, waitUntil: 'load' }, survivor);
  await assert.rejects(call('interact.click', { target: { kind: 'ref', snapshotId: freshButton.snapshotId, ref: freshButton.ref } }, survivor), { code: 'STALE_SNAPSHOT' });
  const replaced = await call('session.replace', {}, { sessionId: refs.sessionId });
  assert.equal(replaced.refs.sessionId, refs.sessionId);
  assert.equal(replaced.refs.generation, 2);
  await assert.rejects(call('page.close', {}, survivor), { code: 'PAGE_NOT_FOUND' });
});

test('live dialogs return an owned pending continuation; explicit response joins action', { skip: !live }, async t => {
  const { runtime, call, refs } = await setup(t);
  const pending = await call('interact.click', { target: role('button', 'Confirm') }, refs);
  assert.equal(pending.status, 'partial');
  assert.equal(pending.data.actionPending, true);
  assert.equal(pending.data.pendingDialog.type, 'confirm');
  assert.ok(runtime.sessions.get(refs.sessionId).pendingActions.size > 0);
  await assert.rejects(call('interact.click', { target: role('button', 'Increment') }, refs), { code: 'DIALOG_PENDING' });
  await call('page.dialog.respond', { action: 'dismiss' }, refs);
  assert.equal((await call('observe.text', { target: role('status', '') }, refs)).data.text, 'dismissed');
  assert.equal(runtime.sessions.get(refs.sessionId).pendingActions.size, 0);
});

test('live cancellation closes and joins the affected owned scope', { skip: !live }, async t => {
  const { runtime, call, refs } = await setup(t);
  const controller = new AbortController();
  const pending = call('page.wait', { text: 'never appears', timeoutMs: 3000 }, refs, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(pending, { code: 'CANCELLED' }); } finally { clearTimeout(timer); }
  assert.equal(runtime.sessions.get(refs.sessionId, { allowClosed: true }).state, 'closed');
  assert.equal(runtime.sessions.get(refs.sessionId, { allowClosed: true }).context.pages().length, 0);
});

test('live mobile, screenshots, verified WebM frames, trace, upload and downloads', { skip: !live }, async t => {
  const emulation = { viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/156.0.0.0 Mobile Safari/537.36' };
  // openArgs are test inputs, not browser configuration fields.
  const { runtime, call, refs, root, url } = await setup(t, { allowDownloads: true, openArgs: { emulation, downloads: true } });
  await call('mobile.tap', { target: role('button', 'Increment') }, refs);
  assert.equal((await call('observe.text', { target: role('status', '') }, refs)).data.text, '1');
  await call('mobile.swipe', { from: { x: 180, y: 700 }, to: { x: 180, y: 250 }, durationMs: 300, steps: 12 }, refs);
  const browserPage = runtime.sessions.get(refs.sessionId).pages.get(refs.pageId).page;
  const touched = await browserPage.evaluate(() => ({ events: window.touch, scrollY, dpr: devicePixelRatio, touchPoints: navigator.maxTouchPoints }));
  assert.ok(touched.events.some(item => item.type === 'touchmove' && item.trusted));
  assert.ok(touched.scrollY > 0); assert.equal(touched.dpr, 2); assert.ok(touched.touchPoints > 0);
  await call('page.navigate', { url, waitUntil: 'load' }, refs);
  const screenshots = [];
  for (const format of ['png', 'jpeg', 'webp']) {
    const result = await call('media.screenshot', { format, readiness: { fonts: true } }, refs);
    assert.equal(result.artifacts[0].width, 393); assert.equal(result.artifacts[0].height, 852);
    screenshots.push(result.artifacts[0]);
  }
  const masked = await call('media.screenshot', { maskTargets: [role('textbox', 'Name')] }, refs);
  assert.equal(masked.artifacts[0].state, 'finalized');
  const element = await call('media.screenshot', { mode: 'element', target: role('button', 'Increment') }, refs);
  assert.ok(element.artifacts[0].width < 393);
  const video = await call('media.video.start', { fps: 12, maxDurationMs: 5000 }, refs);
  await assert.rejects(call('media.trace.start', {}, { sessionId: refs.sessionId }), { code: 'INVALID_STATE' });
  await delay(400); await call('interact.click', { target: role('button', 'Increment') }, refs);
  await delay(1000); await call('interact.click', { target: role('button', 'Increment') }, refs); await delay(500);
  const stopped = await call('media.video.stop', { captureId: video.refs.captureId }, { sessionId: refs.sessionId });
  assert.equal(stopped.data.state, 'finalized'); assert.equal(stopped.artifacts.filter(item => item.kind === 'video-frame').length, 3);
  assert.ok(stopped.artifacts.find(item => item.kind === 'video').durationMs > 1000);
  const again = await call('media.video.stop', { captureId: video.refs.captureId }, { sessionId: refs.sessionId });
  assert.deepEqual(again.artifacts, stopped.artifacts);
  const trace = await call('media.trace.start', {}, { sessionId: refs.sessionId });
  await call('interact.fill', { target: role('textbox', 'Name'), value: 'demo' }, refs);
  const traceStopped = await call('media.trace.stop', { captureId: trace.refs.captureId }, { sessionId: refs.sessionId });
  assert.equal(traceStopped.data.state, 'finalized');
  const staged = join(root, 'staged-upload.txt'); await writeFile(staged, 'upload demo');
  const request = { operation: 'files.upload', ...refs, args: { paths: ['unread-host-input'], target: role('textbox', 'Name') } };
  await assert.rejects(runtime.execute(request, { callId: randomUUID() }), { code: 'POLICY_DENIED' });
  const uploadRequest = { operation: 'files.upload', ...refs, args: { paths: ['authorized-host-input'], target: role('button', 'Upload') } };
  // File inputs have no implicit role. Use a maintained test id, never a CSS escape hatch.
  await browserPage.getByLabel('Upload').evaluate(element => element.setAttribute('data-testid', 'fixture-upload'));
  uploadRequest.args.target = { kind: 'testId', value: 'fixture-upload' };
  const uploaded = await runtime.upload(uploadRequest, [{ path: staged, name: 'demo.txt', mime: 'text/plain', sha256: createHash('sha256').update('upload demo').digest('hex') }], { callId: randomUUID() });
  assert.equal(uploaded.data.uploaded[0].bytes, 11);
  const downloadEvent = browserPage.waitForEvent('download', { timeout: 3000 });
  await call('interact.click', { target: role('link', 'Download') }, refs);
  await downloadEvent;
  await Promise.allSettled([...runtime.sessions.get(refs.sessionId).pendingActions]);
  const downloads = await call('files.downloads.list', {}, { sessionId: refs.sessionId });
  assert.equal(downloads.data.downloads[0].state, 'finalized');
  const consoleLog = await call('diagnostics.console', {}, refs); assert.ok(consoleLog.data.entries.some(item => item.text === 'fixture-ready'));
  await assert.rejects(call('diagnostics.console', { cursor: consoleLog.data.cursor, query: 'another' }, refs), { code: 'INVALID_CURSOR' });
  await writeFile(join(base, 'latest-report.json'), JSON.stringify({ root, screenshots, masked: masked.artifacts, video: stopped.artifacts, trace: traceStopped.artifacts, touched, downloads: downloads.data.downloads }, null, 2));
});

test('live complete semantic interactions, geometry, readiness and emulation', { skip: !live }, async t => {
  const { runtime, call, refs } = await setup(t);
  const page = runtime.sessions.get(refs.sessionId).pages.get(refs.pageId).page;
  await page.locator('header').evaluate(header => {
    const form = document.createElement('div');
    form.innerHTML = '<label>Consent<input type="checkbox" aria-label="Consent"></label><label>Choice<select aria-label="Choice"><option value="a">A</option><option value="b">B</option></select></label>';
    header.appendChild(form);
  });
  await call('interact.fill', { target: role('textbox', 'Name'), value: 'first value' }, refs);
  assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'first value');
  await call('interact.press', { target: role('textbox', 'Name'), key: 'Control+A' }, refs);
  await call('interact.press', { target: role('textbox', 'Name'), key: 'Backspace' }, refs);
  assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), '');
  await call('interact.select', { target: role('combobox', 'Choice'), values: ['b'] }, refs);
  assert.equal(await page.getByRole('combobox', { name: 'Choice', exact: true }).inputValue(), 'b');
  await call('interact.check', { target: role('checkbox', 'Consent'), checked: true }, refs);
  assert.equal(await page.getByRole('checkbox', { name: 'Consent', exact: true }).isChecked(), true);
  await call('interact.hover', { target: role('button', 'Increment') }, refs);
  await call('interact.fill', { target: role('textbox', 'Name'), value: 'button "Increment"' }, refs);
  const scoped = await call('observe.snapshot', { target: role('textbox', 'Name') }, refs);
  assert.ok(scoped.data.snapshot.includes('textbox "Name"'));
  assert.ok(!scoped.data.targets.some(item => item.name === 'Increment'), 'plain input text must not mint an unrelated ARIA role reference');
  const geometry = await call('observe.geometry', { target: role('button', 'Increment') }, refs);
  assert.ok(geometry.data.bounds.width > 0); assert.equal(geometry.data.coordinateSpace, 'css-viewport');
  const attributes = await call('observe.attributes', { target: role('button', 'Increment'), names: ['aria-label'] }, refs);
  assert.equal(attributes.data.attributes['aria-label'], 'Increment');
  await call('page.wait', { target: role('button', 'Increment'), state: 'visible', fonts: true }, refs);
  await call('interact.drag', { source: role('button', 'Drag source'), destination: role('button', 'Drop target') }, refs);
  assert.equal((await call('observe.text', { target: role('button', 'Drop target') }, refs)).data.text, 'Dropped');
  await call('emulate.viewport', { width: 640, height: 480 }, refs);
  assert.deepEqual(page.viewportSize(), { width: 640, height: 480 });
  await call('emulate.media', { colorScheme: 'dark', reducedMotion: 'reduce' }, refs);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme:dark)').matches), true);
  await call('emulate.offline', { offline: true }, { sessionId: refs.sessionId });
  assert.equal(runtime.sessions.get(refs.sessionId).settings.offline, true);
  await call('emulate.offline', { offline: false }, { sessionId: refs.sessionId });
  await call('interact.scroll', { deltaY: 250 }, refs);
  await page.waitForFunction(() => scrollY > 0);
  await assert.rejects(call('mobile.tap', { point: { x: 10, y: 10 } }, refs), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('effective non-default policy revision validates boot and canonical output', async () => {
  const root = await scratch();
  const config = { allowCss: true, sensitiveOps: 'disabled', limits: { tabs: 1, freeDiskBytes: 1 } };
  const revision = catalogRevision(normalizeConfig(config));
  assert.notEqual(revision, CATALOG_REVISION);
  assert.throws(() => new BrowserRuntime({ ownerId: 'policy-owner', artifactRoot: root, config, catalogRevision: CATALOG_REVISION }), { code: 'CATALOG_CHANGED' });
  const runtime = new BrowserRuntime({ ownerId: 'policy-owner', artifactRoot: root, config, catalogRevision: revision });
  const result = await runtime.execute({ operation: 'session.list', args: {}, catalogRevision: revision }, { callId: 'policy-call' });
  assert.equal(result.catalogRevision, revision);
  assert.deepEqual(result.data.sessions, []);
  assert.equal(runtime.sessions.browser, null);
  await assert.rejects(runtime.execute({ operation: 'session.list', args: {}, catalogRevision: CATALOG_REVISION }, { callId: 'old-policy' }), { code: 'CATALOG_CHANGED' });
  await runtime.close();
});

test('live non-default policy: CSS allowed, tabs1 enforced, sensitive traces disabled', { skip: !live }, async t => {
  const { runtime, call, refs } = await setup(t, { allowCss: true, sensitiveOps: 'disabled', limits: { tabs: 1 } });
  assert.equal(runtime.catalogRevision, catalogRevision(runtime.config));
  assert.notEqual(runtime.catalogRevision, CATALOG_REVISION);
  const clicked = await call('interact.click', { target: { kind: 'css', value: 'button[aria-label="Increment"]' } }, refs);
  assert.equal(clicked.catalogRevision, runtime.catalogRevision);
  assert.equal((await call('observe.text', { target: role('status', '') }, refs)).data.text, '1');
  await assert.rejects(call('page.create', {}, { sessionId: refs.sessionId }), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(call('media.trace.start', {}, { sessionId: refs.sessionId }), { code: 'POLICY_DENIED' });
  assert.equal(runtime.capture.captures.size, 0);
});

test('persistent recovery restores bytes, frozen hashes and failed/pending quota before reserve', async () => {
  const root = await scratch();
  const options = { root, ownerId: 'persist-owner', limits: { freeDiskBytes: 1, ownerBytes: 10000, sessionBytes: 10000 } };
  const first = new ArtifactStore(options);
  const artifact = await first.write({ data: Buffer.from('approved'), kind: 'text', mime: 'text/plain', extension: 'txt', sessionId: 'session' });
  const pending = await first.reserve({ kind: 'video', mime: 'video/webm', extension: 'webm', sessionId: 'session' });
  await writeFile(pending.path, 'unfinished bytes');
  const failed = await first.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' });
  await first.mark(failed.artifactId, 'failed');
  const restarted = new ArtifactStore(options);
  await restarted.initialize();
  assert.equal(restarted.inspect(artifact.artifactId).state, 'finalized');
  assert.equal(restarted.inspect(artifact.artifactId).sha256, artifact.sha256);
  assert.equal(restarted.inspect(pending.artifactId).state, 'partial');
  assert.equal(restarted.inspect(pending.artifactId).bytes, 16);
  assert.equal(restarted.inspect(failed.artifactId).state, 'failed');
  assert.equal(restarted.totalCount(), 3);
  assert.ok(restarted.totalBytes() > 24, 'sidecars/marker consume quota too');
  const exhausted = new ArtifactStore({ ...options, limits: { ...options.limits, ownerBytes: restarted.totalBytes() } });
  await assert.rejects(exhausted.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' }), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(exhausted.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' }), { code: 'LIMIT_EXCEEDED' });
  assert.equal(exhausted.totalCount(), 3);
});

test('external private owner budgets and persisted failed records preserve the total1000 cap', async () => {
  const root = await scratch();
  const options = { root, ownerId: 'count-owner', limits: { freeDiskBytes: 1, ownerBytes: 100000 } };
  const first = new ArtifactStore(options);
  const failed = await first.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' });
  await first.mark(failed.artifactId, 'failed');
  const restarted = new ArtifactStore({ ...options, resourceBudget: { count: 999, bytes: 4000 } });
  await assert.rejects(restarted.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' }), { code: 'LIMIT_EXCEEDED' });
  assert.equal(restarted.totalCount(), 1000);
  assert.ok(restarted.totalBytes() > 4000);
  const runtime = new BrowserRuntime({ ownerId: 'runtime-budget-owner', artifactRoot: await scratch(), externalArtifactBudget: { count: 1000, bytes: 123 }, config: { limits: { freeDiskBytes: 1 } } });
  assert.equal(runtime.catalogRevision, catalogRevision(runtime.config));
  assert.equal(runtime.artifacts.externalBytes, 123);
  await assert.rejects(runtime.artifacts.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' }), { code: 'LIMIT_EXCEEDED' });
  await runtime.close();
});

test('recovery rejects foreign owner, outside paths, unknown sidecars and symlinks', async () => {
  const root = await scratch();
  const options = { root, ownerId: 'original-owner', limits: { freeDiskBytes: 1 } };
  const store = new ArtifactStore(options);
  const artifact = await store.write({ data: Buffer.from('owned'), kind: 'text', mime: 'text/plain', extension: 'txt' });
  await assert.rejects(new ArtifactStore({ ...options, ownerId: 'foreign-owner' }).initialize(), { code: 'ARTIFACT_PATH_DENIED' });
  const sidecar = join(root, `${artifact.artifactId}.json`);
  await writeFile(sidecar, JSON.stringify({ ...artifact, path: join(await scratch(), 'foreign.txt') }));
  await assert.rejects(new ArtifactStore(options).initialize(), { code: 'ARTIFACT_PATH_DENIED' });
  const unknownRoot = await scratch();
  await writeFile(join(unknownRoot, '.owner.json'), JSON.stringify({ ownerId: 'original-owner' }));
  await writeFile(join(unknownRoot, 'foreign.json'), '{}');
  await assert.rejects(new ArtifactStore({ ...options, root: unknownRoot }).initialize(), { code: 'ARTIFACT_PATH_DENIED' });
  const linkRoot = await scratch();
  await writeFile(join(linkRoot, '.owner.json'), JSON.stringify({ ownerId: 'original-owner' }));
  await symlink(sidecar, join(linkRoot, `${artifact.artifactId}.json`));
  await assert.rejects(new ArtifactStore({ ...options, root: linkRoot }).initialize(), { code: 'ARTIFACT_PATH_DENIED' });
});

test('changed finalized bytes are not reapproved; large metadata never enters recovery', async () => {
  const root = await scratch();
  const options = { root, ownerId: 'changed-owner', limits: { freeDiskBytes: 1 } };
  const store = new ArtifactStore(options);
  const artifact = await store.write({ data: Buffer.from('original'), kind: 'text', mime: 'text/plain', extension: 'txt' });
  await writeFile(artifact.path, 'tampered');
  const recovered = new ArtifactStore(options);
  await recovered.initialize();
  assert.equal(recovered.inspect(artifact.artifactId).state, 'partial');
  assert.equal(recovered.inspect(artifact.artifactId).sha256, undefined);
  await writeFile(join(root, `${artifact.artifactId}.json`), ' '.repeat(16385));
  await assert.rejects(new ArtifactStore(options).initialize(), { code: 'ARTIFACT_PATH_DENIED' });
});

test('concurrent reservations at999 admit one file+sidecar, never1001', async () => {
  const root = await scratch();
  const options = { root, ownerId: 'concurrent-owner', limits: { freeDiskBytes: 1 } };
  const previous = new ArtifactStore(options);
  const old = await previous.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' });
  await previous.mark(old.artifactId, 'failed');
  const store = new ArtifactStore({ ...options, resourceBudget: { count: 998 } });
  const results = await Promise.allSettled([
    store.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' }),
    store.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'LIMIT_EXCEEDED');
  assert.equal(store.totalCount(), 1000);
  assert.equal(store.records.size, 2);
  const names = await readdir(root);
  assert.equal(names.filter(name => /^ba_.*\.json$/.test(name)).length, 2);
  assert.equal(names.filter(name => /^ba_.*\.txt$/.test(name)).length, 2);
});

test('failed sidecar persistence retains admission charge and orphan recovery cap', async () => {
  const root = await scratch();
  const options = { root, ownerId: 'persist-failure-owner', resourceBudget: { count: 999 }, limits: { freeDiskBytes: 1 } };
  const store = new ArtifactStore(options);
  store.persist = async () => { throw new Error('fixture persistence failure'); };
  const results = await Promise.allSettled([
    store.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' }),
    store.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' }),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].reason.code, 'LIMIT_EXCEEDED');
  assert.equal(store.totalCount(), 1000);
  assert.equal(store.records.size, 1);
  assert.ok(store.sidecarBytes.values().next().value > 0);
  assert.equal((await readdir(root)).filter(name => /^ba_.*\.txt$/.test(name)).length, 1);
  const restarted = new ArtifactStore(options);
  await assert.rejects(restarted.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' }), { code: 'LIMIT_EXCEEDED' });
  assert.equal(restarted.totalCount(), 1000);
});

test('pending metadata bytes are admitted before any artifact file commit', async () => {
  const root = await scratch();
  const store = new ArtifactStore({ root, ownerId: 'metadata-budget-owner', limits: { freeDiskBytes: 1, ownerBytes: 10000 } });
  await store.initialize();
  store.limits.ownerBytes = store.totalBytes() + 10;
  await assert.rejects(store.reserve({ kind: 'text', mime: 'text/plain', extension: 'txt' }), { code: 'LIMIT_EXCEEDED' });
  assert.equal(store.records.size, 0);
  assert.equal((await readdir(root)).filter(name => name.startsWith('ba_')).length, 0);
});
