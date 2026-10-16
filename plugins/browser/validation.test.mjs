import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validateCall, validateOutput } from './validation.mjs';
import { CATALOG_REVISION, catalogRevision, OPERATIONS, helpCatalog, describeOperation } from './manifest.mjs';
import { DEFAULT_CONFIG, normalizeConfig } from './config.mjs';
import { response } from './protocol.mjs';

const target = () => ({ kind: 'role', role: 'button', name: 'Increment' });
const ref = () => ({ kind: 'ref', snapshotId: 'snapshot-owned', ref: 'target-owned' });
const request = (operation, args = {}, extra = {}) => ({ operation, ...(OPERATIONS.find(item => item.operation === operation)?.requiresSession ? { sessionId: 'session-owned' } : {}), args, ...extra });
const output = (operation, data = {}, extra = {}, config = DEFAULT_CONFIG) => response({ operation }, { callId: 'call-owned', catalogRevision: catalogRevision(config) }, { data, ...extra });

test('meta discovery works with missing runtime imports and has no compiler dependency', async () => {
  const base = fileURLToPath(new URL('../../.dumps/tasks/task05-contract-validation/', import.meta.url));
  await mkdir(base, { recursive: true });
  const scratch = await mkdtemp(join(base, 'no-deps-'));
  const loader = join(scratch, 'loader.mjs');
  await writeFile(loader, "export function resolve(specifier,ctx,next){if(specifier.includes('/ajv/dist/2020.js'))throw Error('fixture unavailable');return next(specifier,ctx)}\n");
  const moduleURL = new URL('./validation.mjs', import.meta.url).href;
  const protocolURL = new URL('./protocol.mjs', import.meta.url).href;
  const manifestURL = new URL('./manifest.mjs', import.meta.url).href;
  const program = `import assert from 'node:assert/strict'; import{validateCall,validateOutput}from${JSON.stringify(moduleURL)};import{response}from${JSON.stringify(protocolURL)};import{CATALOG_REVISION,helpCatalog,describeOperation}from${JSON.stringify(manifestURL)};for(const [operation,path,data]of[['help',undefined,helpCatalog()],['describe','help',describeOperation('help')],['capabilities',undefined,{}]]){const input={operation,args:{},...(path?{path}:{})};await validateCall(input);await validateOutput(operation,response(input,{callId:'meta',catalogRevision:CATALOG_REVISION},{data}));}await assert.rejects(validateCall({operation:'session.open',args:{}}),{code:'BACKEND_UNAVAILABLE'});console.log('meta-independent');`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-loader', loader, '--input-type=module', '--eval', program]);
  assert.ok(stdout.includes('meta-independent'));
});

test('wire envelope is strict, one exact decision per call, and root ids are constrained', async () => {
  for (const input of [
    { operation: 'help' }, { operation: 'help', args: [] }, { operation: 'help', args: {}, ownerId: 'forged' },
    { operation: 'help', args: {}, _meta: {} }, { operation: 'help', args: {}, sessionId: 1 },
    [{ operation: 'help', args: {} }], { operation: 'page.navigate', sessionId: '', args: { url: 'about:blank' } },
  ]) await assert.rejects(validateCall(input), { code: 'INVALID_ENVELOPE' });
  for (const operation of ['browser_click', 'interact.Click', 'help ', 'run_code_unsafe', 'constructor', '__proto__', 'new.unreviewed']) await assert.rejects(validateCall({ operation, args: {} }), { code: 'UNKNOWN_OPERATION' });
});

test('pre-AJV bounds reject huge/deep/cyclic/non-JSON/accessor input without executing it', async () => {
  await assert.rejects(validateCall(request('interact.fill', { target: target(), value: 'a'.repeat(40000) })), { code: 'INVALID_ENVELOPE' });
  let nested = {}; for (let i = 0; i < 15; i++) nested = { nested };
  await assert.rejects(validateCall({ operation: 'help', args: nested }), { code: 'INVALID_ENVELOPE' });
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(validateCall({ operation: 'help', args: cycle }), { code: 'INVALID_ENVELOPE' });
  await assert.rejects(validateCall({ operation: 'help', args: { bytes: Buffer.from('raw') } }), { code: 'INVALID_ENVELOPE' });
  let invoked = false; const args = {}; Object.defineProperty(args, 'query', { enumerable: true, get() { invoked = true; return ''; } });
  await assert.rejects(validateCall({ operation: 'help', args }), { code: 'INVALID_ENVELOPE' });
  assert.equal(invoked, false);
  await assert.rejects(validateCall({ operation: 'help', args: { query: undefined } }), { code: 'INVALID_ENVELOPE' });
  const config = normalizeConfig({ limits: { inputBytes: 100 } });
  await assert.rejects(validateCall({ operation: 'help', args: { query: 'a'.repeat(100) } }, { config }), { code: 'INVALID_ENVELOPE' });
});

test('only discovery accepts path; only declared descriptors accept session/page ids', async () => {
  await assert.rejects(validateCall({ operation: 'describe', args: {} }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall({ operation: 'describe', path: 'media', args: {} }), { code: 'UNKNOWN_OPERATION' });
  await assert.rejects(validateCall({ operation: 'help', path: 'missing', args: {} }), { code: 'UNKNOWN_OPERATION' });
  await assert.rejects(validateCall({ operation: 'capabilities', path: 'media', args: {} }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall({ operation: 'help', sessionId: 'owned', args: {} }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall({ operation: 'page.navigate', args: { url: 'about:blank' } }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall(request('page.navigate', { url: 'about:blank' }, { path: 'page.navigate' })), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall(request('session.status', {}, { pageId: 'page-owned' })), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall(request('session.list', {}, { sessionId: 'session-owned' })), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall(request('media.video.stop', { captureId: 'capture-owned' }, { pageId: 'page-owned' })), { code: 'INVALID_ARGS' });
});

test('ney misplaced metadata is safely relocated without mutation and normalization is idempotent', async () => {
  for (const input of [
    { operation: 'help', args: { path: 'session' } },
    { operation: 'describe', args: { path: 'page.navigate' } },
    { operation: 'page.navigate', args: { sessionId: 'session-owned', pageId: 'page-owned', url: 'http://127.0.0.1:8888/index.html' } },
    { operation: 'page.navigate', args: { sessionId: 'session-owned', url: 'about:blank' } },
    { operation: 'help', args: { catalogRevision: CATALOG_REVISION } },
  ]) {
    const saved = structuredClone(input);
    const { request: normalized } = await validateCall(input);
    assert.deepEqual(input, saved);
    for (const key of ['path', 'sessionId', 'pageId', 'catalogRevision']) {
      if (Object.hasOwn(saved.args, key)) {
        assert.equal(normalized[key], saved.args[key]);
        assert.equal(Object.hasOwn(normalized.args, key), false);
      }
    }
    assert.deepEqual((await validateCall(normalized)).request, normalized);
    const canonical = { ...saved, args: { ...saved.args } };
    for (const key of ['path', 'sessionId', 'pageId', 'catalogRevision']) {
      if (Object.hasOwn(canonical.args, key)) { canonical[key] = canonical.args[key]; delete canonical.args[key]; }
    }
    assert.deepEqual((await validateCall(canonical)).request, normalized);
  }
});

test('duplicate metadata coalesces only identical values; conflicts fail closed', async () => {
  for (const [operation, key, value, args] of [
    ['help', 'path', 'session', {}],
    ['page.navigate', 'sessionId', 'session-owned', { url: 'about:blank' }],
    ['page.navigate', 'pageId', 'page-owned', { sessionId: 'session-owned', url: 'about:blank' }],
    ['help', 'catalogRevision', CATALOG_REVISION, {}],
  ]) {
    const actual = await validateCall({ operation, [key]: value, args: { ...args, [key]: value } });
    assert.equal(actual.request[key], value); assert.equal(Object.hasOwn(actual.request.args, key), false);
    await assert.rejects(validateCall({ operation, [key]: value, args: { ...args, [key]: 'different' } }), error => error.code === 'INVALID_ENVELOPE' && error.message.includes(`Conflicting ${key}`));
  }
});

test('metadata tolerance preserves type/id/revision/field/policy guards', async () => {
  for (const value of [null, 1, {}, [], '', 'bad id', 'bad\0id', 'x'.repeat(161)]) {
    await assert.rejects(validateCall({ operation: 'page.navigate', args: { url: 'about:blank', sessionId: value } }), { code: 'INVALID_ENVELOPE' });
  }
  await assert.rejects(validateCall({ operation: 'help', args: { catalogRevision: 'stale' } }), { code: 'CATALOG_CHANGED' });
  await assert.rejects(validateCall({ operation: 'help', args: { path: 'session', code: 'unsafe' } }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall({ operation: 'help', args: { path: 'session', ownerId: 'forged' } }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall({ operation: 'help', args: { sessionId: 'session-owned' } }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall({ operation: 'capabilities', args: { path: 'session' } }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall({ operation: 'session.open', args: { sessionId: 'session-owned' } }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall({ operation: 'session.status', args: { sessionId: 'session-owned', pageId: 'page-owned' } }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall({ operation: 'media.screenshot', args: { sessionId: 'session-owned', path: '/tmp/arbitrary' } }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall({ operation: 'page.navigate', args: { sessionId: 'session-owned', url: 'javascript:alert(1)' } }), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall({ operation: 'interact.click', args: { sessionId: 'session-owned', target: { kind: 'css', value: '#not-approved' } } }), { code: 'POLICY_DENIED' });
  let invoked = false;
  const args = { url: 'about:blank' };
  Object.defineProperty(args, 'sessionId', { enumerable: true, get() { invoked = true; return 'session-owned'; } });
  await assert.rejects(validateCall({ operation: 'page.navigate', args }), { code: 'INVALID_ENVELOPE' });
  assert.equal(invoked, false);
});

test('recovery hints are visible in error messages, not only discarded native details', async () => {
  for (const [input, code, hint] of [
    [{ operation: 'describe', args: {} }, 'INVALID_ARGS', '"path":"page.navigate"'],
    [{ operation: 'describe', args: { path: 'session' } }, 'UNKNOWN_OPERATION', '"operation":"help"'],
    [{ operation: 'page.goto', args: {} }, 'UNKNOWN_OPERATION', 'page.navigate'],
    [{ operation: 'page.navigate', args: { url: 'about:blank' } }, 'INVALID_ARGS', '"operation":"session.open"'],
    [{ operation: 'page.navigate', args: { sessionId: 'session-owned' } }, 'INVALID_ARGS', '"path":"page.navigate"'],
  ]) await assert.rejects(validateCall(input), error => error.code === code && error.message.includes(hint));
});

test('catalog revision includes effective public policy, never private cache paths', async () => {
  const changed = normalizeConfig({}, { limits: { tabs: 1 } });
  assert.notEqual(catalogRevision(changed), CATALOG_REVISION);
  assert.equal(catalogRevision(normalizeConfig({ browserCache: '/tmp/secret-cache-a' })), catalogRevision(normalizeConfig({ browserCache: '/tmp/secret-cache-b' })));
  await assert.rejects(validateCall({ operation: 'help', args: {}, catalogRevision: 'stale' }), { code: 'CATALOG_CHANGED' });
  await assert.rejects(validateCall({ operation: 'help', args: {}, catalogRevision: CATALOG_REVISION }, { config: changed }), { code: 'CATALOG_CHANGED' });
  await validateCall({ operation: 'help', args: {}, catalogRevision: catalogRevision(changed) }, { config: changed });
  assert.equal(helpCatalog({}, changed).catalogRevision, catalogRevision(changed));
  assert.equal(describeOperation('help', changed).catalogRevision, catalogRevision(changed));
});

test('AJV rejects unknown fields and types without coercion/removal/default mutation', async () => {
  const original = request('interact.click', { target: target() });
  const saved = structuredClone(original);
  const actual = await validateCall(original);
  assert.deepEqual(original, saved);
  assert.equal(actual.request.args.timeoutMs, 5000);
  assert.equal(actual.request.args.target.exact, true);
  assert.equal(actual.request.args.button, 'left');
  assert.deepEqual(actual.effects, ['mutate-page']);
  for (const args of [
    { target: target(), timeoutMs: '100' }, { target: target(), extra: true },
    { target: { ...target(), ownerId: 'foreign' } }, { target: { kind: 'ref', ref: 'r1' } },
    { target: { ...target(), role: 'not-a-real-role' } },
  ]) await assert.rejects(validateCall(request('interact.click', args)), { code: 'INVALID_ARGS' });
});

test('nested role defaults are explicit and preserve exact:false', async () => {
  const actual = await validateCall(request('interact.drag', { source: target(), destination: { ...target(), name: 'Other', exact: false } }));
  assert.equal(actual.request.args.source.exact, true);
  assert.equal(actual.request.args.destination.exact, false);
  const screenshot = await validateCall(request('media.screenshot', { maskTargets: [target()] }));
  assert.equal(screenshot.request.args.maskTargets[0].exact, true);
});

test('CSS escape hatch is gated before effects; CSS is never a JS locator expression', async () => {
  const input = request('interact.click', { target: { kind: 'css', value: '#approved' } });
  await assert.rejects(validateCall(input), { code: 'POLICY_DENIED' });
  const actual = await validateCall(input, { config: normalizeConfig({ allowCss: true }) });
  assert.equal(actual.request.args.target.kind, 'css');
  await assert.rejects(validateCall(request('interact.click', { target: { kind: 'expression', value: 'page.first()' } })), { code: 'INVALID_ARGS' });
});

test('session identity is complete and context replacement is explicit', async () => {
  const custom = { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'explicit mobile fixture' };
  const actual = await validateCall(request('session.open', { emulation: custom }));
  assert.deepEqual(actual.request.args.emulation, custom); assert.equal(actual.request.args.engine, 'chromium');
  for (const emulation of [{ viewport: { width: 393, height: 852 } }, { device: 'Pixel 7', viewport: { width: 393, height: 852 } }]) await assert.rejects(validateCall(request('session.open', { emulation })), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall(request('session.open', { downloads: true })), { code: 'POLICY_DENIED' });
  await assert.rejects(validateCall(request('session.open', { engine: 'firefox' })), { code: 'POLICY_DENIED' });
  const constrained = normalizeConfig({}, { limits: { dpr: 1 } });
  await assert.rejects(validateCall(request('session.open', { emulation: custom }), { config: constrained }), { code: 'LIMIT_EXCEEDED' });
});

test('navigation is restricted to http/https/about:blank, never scripts/file/data/credentials', async () => {
  for (const url of ['https://example.test/path', 'http://127.0.0.1/', 'about:blank']) await validateCall(request('page.navigate', { url }));
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'about:blank#other', 'https://user:pass@example.test/', 'http://']) await assert.rejects(validateCall(request('page.navigate', { url })), { code: 'INVALID_ARGS' });
});

test('timeouts are bounded by effective native action/navigation/root limits', async () => {
  await assert.rejects(validateCall(request('interact.click', { target: target(), timeoutMs: 5001 })), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(validateCall(request('media.screenshot', { readiness: { timeoutMs: 5001 } })), { code: 'LIMIT_EXCEEDED' });
  const config = normalizeConfig({}, { limits: { rootMs: 1000 } });
  const actual = await validateCall(request('page.navigate', { url: 'about:blank' }), { config });
  assert.equal(actual.request.args.timeoutMs, 1000);
  await assert.rejects(validateCall(request('page.navigate', { url: 'about:blank', timeoutMs: 1001 }), { config }), { code: 'LIMIT_EXCEEDED' });
});

test('screenshot rich conditional schema rejects conflicting modes and arbitrary paths', async () => {
  const screenshot = await validateCall(request('media.screenshot'));
  assert.equal(screenshot.request.args.mode, 'viewport'); assert.equal(screenshot.request.args.format, 'png'); assert.equal(screenshot.request.args.scale, 'css');
  for (const args of [
    { mode: 'element' }, { mode: 'viewport', target: target() },
    { mode: 'fullPage', clip: { x: 0, y: 0, width: 10, height: 10 } },
    { format: 'png', quality: 80 }, { path: '/tmp/arbitrary' },
    { mode: 'element', target: target(), clip: { x: 0, y: 0, width: 10, height: 10 } },
  ]) await assert.rejects(validateCall(request('media.screenshot', args)), { code: 'INVALID_ARGS' });
  await validateCall(request('media.screenshot', { mode: 'element', target: ref(), format: 'jpeg', quality: 80 }));
});

test('true touch union/coordinates/bounds, never a synthetic gesture fallback', async () => {
  await validateCall(request('mobile.tap', { point: { x: 10, y: 20 } }));
  await validateCall(request('mobile.tap', { target: target() }));
  await assert.rejects(validateCall(request('mobile.tap', { point: { x: 1, y: 2 }, target: target() })), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall(request('mobile.swipe', { from: { x: 2600, y: 100 }, to: { x: 10, y: 20 } })), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(validateCall(request('mobile.swipe', { from: { x: 10, y: 20 }, to: { x: 10, y: 200 }, method: 'mouse' })), { code: 'INVALID_ARGS' });
});

test('video is Page-scoped/finite and stop frame inspection is the explicit default', async () => {
  const start = await validateCall(request('media.video.start'));
  assert.equal(start.request.args.scope, 'page'); assert.equal(start.request.args.maxDurationMs, 60000);
  const stop = await validateCall(request('media.video.stop', { captureId: 'capture-owned' }));
  assert.equal(stop.request.args.inspectFrames, true);
  const config = normalizeConfig({}, { limits: { videoDurationMs: 10000, videoFps: 10 } });
  const narrowed = await validateCall(request('media.video.start'), { config });
  assert.equal(narrowed.request.args.maxDurationMs, 10000); assert.equal(narrowed.request.args.fps, 10);
  for (const args of [{ scope: 'context' }, { maxDurationMs: 0 }, { filename: '/tmp/free' }]) await assert.rejects(validateCall(request('media.video.start', args)), { code: 'INVALID_ARGS' });
  await assert.rejects(validateCall(request('media.video.start', { fps: 31 })), { code: 'LIMIT_EXCEEDED' });
});

test('sensitive classification respects explicit opt-ins and administrator disable', async () => {
  const basic = await validateCall(request('diagnostics.request', { requestId: 'request-owned' }));
  assert.equal(basic.descriptor.sensitive, false);
  const extra = await validateCall(request('diagnostics.request', { requestId: 'request-owned', includeHeaders: true }));
  assert.equal(extra.descriptor.sensitive, true);
  await assert.rejects(validateCall(request('diagnostics.request', { requestId: 'request-owned', includeBody: true }), { config: normalizeConfig({ sensitiveOps: 'disabled' }) }), { code: 'POLICY_DENIED' });
  await assert.rejects(validateCall(request('media.trace.start'), { config: normalizeConfig({ sensitiveOps: 'disabled' }) }), { code: 'POLICY_DENIED' });
  await assert.rejects(validateCall(request('media.trace.start', { sources: true })), { code: 'INVALID_ARGS' });
});

test('known advanced extras fail closed, invented operations never pass through', async () => {
  for (const item of OPERATIONS.filter(item => item.availability === 'disabled')) await assert.rejects(validateCall(request(item.operation)), { code: 'POLICY_DENIED' });
  await assert.rejects(validateCall(request('advanced.run_js', { code: '1+1' })), { code: 'UNKNOWN_OPERATION' });
  await validateCall({ operation: 'help', args: {} }, { config: normalizeConfig({ enabled: false }) });
  await assert.rejects(validateCall(request('session.open'), { config: normalizeConfig({ enabled: false }) }), { code: 'POLICY_DENIED' });
});

test('all baseline input schemas compile and accept their canonical minimal fixtures', async () => {
  const args = {
    'page.navigate': { url: 'about:blank' }, 'page.wait': { fonts: true }, 'page.dialog.respond': { action: 'dismiss' },
    'observe.text': { target: target() }, 'observe.attributes': { target: target(), names: ['id'] }, 'observe.geometry': { target: target() },
    'interact.click': { target: target() }, 'interact.fill': { target: target(), value: 'text' },
    'interact.select': { target: target(), values: ['a'] }, 'interact.check': { target: target(), checked: true },
    'interact.press': { target: target(), key: 'Enter' }, 'interact.hover': { target: target() },
    'interact.drag': { source: target(), destination: target() }, 'interact.scroll': { deltaY: 10 },
    'mobile.tap': { target: target() }, 'mobile.swipe': { from: { x: 10, y: 20 }, to: { x: 10, y: 200 } },
    'emulate.viewport': { width: 393, height: 852 }, 'emulate.media': { colorScheme: 'dark' }, 'emulate.offline': { offline: true },
    'diagnostics.request': { requestId: 'request-owned' }, 'media.video.status': { captureId: 'capture-owned' },
    'media.video.stop': { captureId: 'capture-owned' }, 'media.trace.status': { captureId: 'capture-owned' }, 'media.trace.stop': { captureId: 'capture-owned' },
    'files.upload': { paths: ['authorized.txt'], target: target() }, 'files.downloads.status': { downloadId: 'download-owned' },
    'artifacts.inspect': { artifactId: 'artifact-owned' }, 'artifacts.export': { artifactId: 'artifact-owned', destination: 'exports/evidence.png' },
  };
  const config = normalizeConfig({ allowDownloads: true });
  for (const descriptor of OPERATIONS.filter(item => item.availability === 'verified' && !['help', 'describe', 'capabilities'].includes(item.operation))) {
    await validateCall(request(descriptor.operation, args[descriptor.operation] ?? {}), { config });
  }
});

test('canonical outputs are typed, versioned and cannot contain raw engine values or error-shaped success', async () => {
  const valid = output('session.open', { sessionId: 'session-owned', state: 'open', generation: 1 });
  assert.equal(await validateOutput('session.open', valid), valid);
  await assert.rejects(validateOutput('session.open', output('session.open', { sessionId: 42, state: 'open' })), { code: 'BACKEND_INVALID_OUTPUT' });
  await assert.rejects(validateOutput('session.open', { ...valid, extra: 'raw' }), { code: 'BACKEND_INVALID_OUTPUT' });
  await assert.rejects(validateOutput('session.open', { ...valid, data: { ...valid.data, buffer: Buffer.from('raw') } }), { code: 'BACKEND_INVALID_OUTPUT' });
  await assert.rejects(validateOutput('session.open', { ...valid, refs: { generation: 1.5 } }), { code: 'BACKEND_INVALID_OUTPUT' });
  await assert.rejects(validateOutput('session.open', { ...valid, status: 'completed', effects: [{ kind: 'mutate-page', state: 'unknown' }] }), { code: 'BACKEND_INVALID_OUTPUT' });
  const config = normalizeConfig({}, { limits: { tabs: 1 } });
  await validateOutput('session.open', output('session.open', { sessionId: 'session-owned', state: 'open' }, {}, config), { config });
});

test('media output never pretends pending/empty/nonexistent evidence is finalized', async () => {
  await assert.rejects(validateOutput('media.video.stop', output('media.video.stop', { captureId: 'capture-owned', state: 'finalized' })), { code: 'BACKEND_INVALID_OUTPUT' });
  const artifact = { artifactId: 'artifact-owned', kind: 'video', mime: 'video/webm', bytes: 100, state: 'finalized', sha256: '0'.repeat(64) };
  await validateOutput('media.video.stop', output('media.video.stop', { captureId: 'capture-owned', state: 'finalized' }, { artifacts: [artifact] }));
  await assert.rejects(validateOutput('media.video.stop', output('media.video.stop', { captureId: 'capture-owned', state: 'finalized' }, { artifacts: [{ ...artifact, bytes: 0 }] })), { code: 'BACKEND_INVALID_OUTPUT' });
  await assert.rejects(validateOutput('media.video.status', output('media.video.status', { captureId: 'capture-owned', state: 'recording', scope: 'context' })), { code: 'BACKEND_INVALID_OUTPUT' });
});
