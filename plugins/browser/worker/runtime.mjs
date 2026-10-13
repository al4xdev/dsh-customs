import { randomBytes, randomUUID, createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fail, BrowserError } from '../errors.mjs';
import { normalizeConfig } from '../config.mjs';
import { catalogRevision as effectiveCatalogRevision } from '../manifest.mjs';
import { validateCall, validateOutput } from '../validation.mjs';
import { response } from '../protocol.mjs';
import { ArtifactStore } from './artifacts.mjs';
import { SessionManager, safeUrl } from './sessions.mjs';
import { TargetRegistry } from './targets.mjs';
import { CaptureManager } from './capture.mjs';

const inside = (root, path) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const pendingDialog = record => record.currentDialog ? { dialogId: record.currentDialog.dialogId, type: record.currentDialog.type, message: record.currentDialog.message } : null;
function permittedUrl(input) {
  if (input === 'about:blank') return input;
  let value; try { value = new URL(input); } catch { fail('INVALID_ARGS', 'Navigation URL is invalid.'); }
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password) fail('POLICY_DENIED', 'Only HTTP(S) or about:blank navigation is allowed; URL credentials are not accepted.');
  return value.toString();
}

/** One private worker owns all handles. Nothing in its public args chooses launch options or authority. */
export class BrowserRuntime {
  constructor({ ownerId, artifactRoot, config = {}, catalogRevision, toolPaths = {}, externalArtifactBudget = {}, resourceBudget }) {
    if (typeof ownerId !== 'string' || !ownerId || !isAbsolute(artifactRoot)) fail('BACKEND_UNAVAILABLE', 'Private owned runtime configuration is invalid.');
    this.config = normalizeConfig(config);
    const revision = effectiveCatalogRevision(this.config);
    if (catalogRevision !== undefined && catalogRevision !== revision) fail('CATALOG_CHANGED', 'Private worker catalog differs from its effective host policy.');
    this.ownerId = ownerId;
    this.catalogRevision = revision;
    this.artifactRoot = artifactRoot;
    this.artifacts = new ArtifactStore({ root: artifactRoot, ownerId, resourceBudget: resourceBudget ?? externalArtifactBudget, limits: { ...this.config.limits, retentionMs: this.config.rawRetentionMs, deliveryRetentionMs: this.config.deliveryRetentionMs } });
    this.targets = new TargetRegistry({ config: this.config, artifacts: this.artifacts });
    this.capture = new CaptureManager({ config: this.config, artifacts: this.artifacts, targets: this.targets, toolPaths });
    this.sessions = new SessionManager({ config: this.config, onInvalidate: record => this.targets.invalidate(record), beforeClose: session => this.capture.closeSession(session) });
    this.sessions.onDownload = (session, record, download) => this.ownDownload(session, record, download);
    this.cursorKey = randomBytes(32);
    this.queue = Promise.resolve();
    this.closing = null;
  }
  execute(input, context) { return this.enqueue(input, context); }
  upload(input, stagedFiles, context) { return this.enqueue(input, context, stagedFiles); }
  confirmDelivery(args, context = {}) {
    const task = this.queue.then(async () => {
      if (this.closing) fail('BACKEND_UNAVAILABLE', 'Owned browser worker is closing.');
      if (!args || typeof args !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) fail('INVALID_ARGS', 'Delivery arguments must be a closed object.');
      const descriptors = Object.getOwnPropertyDescriptors(args);
      if (Reflect.ownKeys(descriptors).length !== 1 || !descriptors.artifactIds || !Object.hasOwn(descriptors.artifactIds, 'value')) fail('INVALID_ARGS', 'Delivery accepts only artifactIds.');
      return { artifacts: await this.artifacts.confirmDelivery(descriptors.artifactIds.value, context) };
    });
    this.queue = task.catch(() => {});
    return task;
  }
  enqueue(input, context = {}, stagedFiles) {
    // SDK requests can be concurrent; one owned mutation pipeline prevents lifecycle/capture races.
    const task = this.queue.then(() => this.run(input, context, stagedFiles));
    this.queue = task.catch(() => {});
    return task;
  }
  async run(input, { callId = `bc_${randomUUID()}`, signal } = {}, stagedFiles) {
    if (this.closing) fail('BACKEND_UNAVAILABLE', 'Owned browser worker is closing.');
    if (signal?.aborted) fail('CANCELLED', 'Browser request was cancelled before effects.');
    const { request, descriptor } = await validateCall(input, { config: this.config });
    const args = request.args;
    let session;
    let page;
    let cleanup;
    if (descriptor.requiresSession) session = this.sessions.get(request.sessionId, { allowClosed: ['session.status', 'session.close', 'media.video.status', 'media.video.stop', 'media.trace.status', 'media.trace.stop'].includes(request.operation) });
    if (descriptor.usesPage) page = this.sessions.resolvePage(session, request.pageId);
    const targetRecord = page ? this.sessions.frameTarget(page, args.frameId) : null;
    if (session && !descriptor.engines.includes(session.settings.engine)) fail('UNSUPPORTED_CAPABILITY', 'Operation is not verified for this session engine.');
    const abort = () => {
      // Playwright public APIs do not accept AbortSignal. Closing and joining the owned scope cancels them,
      // rather than abandoning a still-mutating action behind a rejected Promise.race.
      cleanup ??= (session ? this.sessions.close(session.sessionId) : this.sessions.closeAll()).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) { abort(); await cleanup; fail('CANCELLED', 'Browser request was cancelled before effects.'); }
      let result = await this.dispatch(request, args, { session, page, targetRecord, signal, stagedFiles });
      if (result.session) { session = result.session; delete result.session; }
      if (result.page) { page = result.page; delete result.page; }
      if (signal?.aborted) { abort(); await cleanup; fail('CANCELLED', 'Browser action stopped; its owned context was closed. Inspect state before retrying.', { effectState: 'unknown', retryable: false }); }
      if (session?.state === 'ready' && !descriptor.effects.every(effect => effect === 'discovery')) this.sessions.touch(session);
      const refs = { ...(session ? { sessionId: session.sessionId, generation: session.generation } : {}), ...(page ? { pageId: page.pageId } : {}), ...(args.frameId ? { frameId: args.frameId } : {}), ...(result.data?.snapshotId ? { snapshotId: result.data.snapshotId } : {}), ...(result.data?.captureId ? { captureId: result.data.captureId } : {}) };
      const partial = result.status === 'partial' || result.data?.state === 'partial';
      result = { ...result, status: partial ? 'partial' : 'completed', refs: { ...refs, ...result.refs }, effects: descriptor.effects.map(kind => ({ kind, state: kind === 'discovery' || kind === 'observe-page' || (kind === 'write-managed-artifact' && request.operation === 'observe.snapshot' && !result.artifacts?.length) ? 'none' : partial ? 'partial' : 'applied' })) };
      const value = response(request, { callId, catalogRevision: this.catalogRevision }, result);
      return await validateOutput(request.operation, value, { config: this.config });
    } catch (error) {
      if (signal?.aborted) { abort(); await cleanup; fail('CANCELLED', 'Browser action stopped and its owned scope was closed.', { effectState: 'unknown', retryable: false }); }
      if (error instanceof BrowserError) throw error;
      if (page?.page.isClosed()) fail('PAGE_CLOSED', 'The expected owned Page closed; no action was redirected to another Page.', { effectState: 'unknown', retryable: false });
      if (error?.name === 'TimeoutError') fail('TIMEOUT', 'Browser action timed out. Inspect owned state before retrying a mutation.', { effectState: 'unknown', retryable: false });
      throw error;
    } finally { signal?.removeEventListener('abort', abort); await cleanup; }
  }
  async dispatch(request, args, { session, page, targetRecord, signal, stagedFiles }) {
    const operation = request.operation;
    if (page?.currentDialog && operation !== 'page.dialog.respond' && !operation.startsWith('diagnostics.') && !['page.close', 'page.frames'].includes(operation)) fail('DIALOG_PENDING', 'An owned dialog requires page.dialog.respond before another page action.');
    switch (operation) {
      case 'session.open': {
        await this.artifacts.initialize();
        const opened = await this.sessions.open(args);
        return { session: opened.session, page: opened.page, data: this.sessions.status(opened.session) };
      }
      case 'session.list': return { data: { sessions: [...this.sessions.sessions.values()].map(item => this.sessions.status(item)) } };
      case 'session.status': return { data: this.sessions.status(session) };
      case 'session.close': await this.sessions.close(session.sessionId); return { data: this.sessions.status(session) };
      case 'session.replace': { const opened = await this.sessions.replace(session, args); return { session: opened.session, page: opened.page, data: this.sessions.status(opened.session) }; }
      case 'page.list': return { data: { pages: this.sessions.pages(session) } };
      case 'page.frames': return { data: { frames: this.sessions.frames(page) } };
      case 'page.create': {
        const url = permittedUrl(args.url);
        const created = await this.sessions.createPage(session);
        await created.page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.limits.navigationMs });
        return { page: created, data: { pageId: created.pageId, url: safeUrl(created.page.url()) } };
      }
      case 'page.close':
        await this.sessions.dismissDialogs(session);
        await this.capture.closePage(page);
        await page.page.close({ runBeforeUnload: false });
        return { data: { pageId: page.pageId, state: 'closed' } };
      case 'page.navigate':
        return this.pageAction(page, () => page.page.goto(permittedUrl(args.url), { waitUntil: args.waitUntil, timeout: args.timeoutMs }), () => ({ url: safeUrl(page.page.url()) }));
      case 'page.back':
      case 'page.forward':
      case 'page.reload': {
        const method = { 'page.back': 'goBack', 'page.forward': 'goForward', 'page.reload': 'reload' }[operation];
        return this.pageAction(page, () => page.page[method]({ waitUntil: args.waitUntil, timeout: args.timeoutMs }), () => ({ url: safeUrl(page.page.url()) }));
      }
      case 'page.wait': {
        if (args.target) await this.targets.wait(targetRecord, args.target, args.state, args.timeoutMs);
        if (args.text) {
          const root = targetRecord.root ?? page.page;
          await root.getByText(args.text, { exact: true }).waitFor({ state: args.state, timeout: args.timeoutMs });
        }
        await this.capture.readiness(page, { fonts: args.fonts, images: args.images });
        return { data: { state: args.state } };
      }
      case 'page.dialog.respond': {
        const dialog = page.currentDialog;
        if (!dialog || dialog.handled) fail('INVALID_STATE', 'The selected owned Page has no pending dialog.');
        dialog.handled = true;
        if (args.action === 'accept') await dialog.dialog.accept(args.promptText);
        else await dialog.dialog.dismiss();
        page.currentDialog = null;
        await Promise.allSettled([...session.pendingActions]);
        return { data: { action: args.action, dialogId: dialog.dialogId } };
      }
      case 'observe.snapshot': {
        const observed = await this.targets.snapshot(targetRecord, args);
        const artifacts = observed.artifacts; delete observed.artifacts;
        return { data: observed, artifacts };
      }
      case 'observe.text': return this.targets.use(targetRecord, args.target, async target => { const text = await target.textContent() ?? ''; return { data: { text: text.slice(0, args.maxChars), truncated: text.length > args.maxChars } }; });
      case 'observe.attributes': return this.targets.use(targetRecord, args.target, async target => ({ data: { attributes: Object.fromEntries(await Promise.all((args.names ?? ['id', 'class', 'role', 'aria-label', 'data-testid']).map(async name => [name, await target.getAttribute(name)]))) } }));
      case 'observe.geometry': return this.targets.use(targetRecord, args.target, async target => ({ data: await target.evaluate(element => {
        const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, scroll: { scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight, clientWidth: element.clientWidth, clientHeight: element.clientHeight, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft }, overflow: { x: style.overflowX, y: style.overflowY }, viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }, coordinateSpace: 'css-viewport' };
      }) }));
      case 'interact.click': return this.targetAction(targetRecord, args.target, target => target.click({ button: args.button, clickCount: args.clickCount, timeout: args.timeoutMs }));
      case 'interact.fill': return this.targetAction(targetRecord, args.target, target => target.fill(args.value, { timeout: args.timeoutMs }));
      case 'interact.select': return this.targetAction(targetRecord, args.target, target => target.selectOption(args.values, { timeout: args.timeoutMs }));
      case 'interact.check': return this.targetAction(targetRecord, args.target, target => target.setChecked(args.checked, { timeout: args.timeoutMs }));
      case 'interact.press': return this.targetAction(targetRecord, args.target, target => target.press(args.key, { timeout: args.timeoutMs }));
      case 'interact.hover': return this.targetAction(targetRecord, args.target, target => target.hover({ timeout: args.timeoutMs }));
      case 'interact.drag': return this.drag(targetRecord, args);
      case 'interact.scroll': return this.pageAction(page, () => page.page.mouse.wheel(args.deltaX, args.deltaY), () => ({ deltaX: args.deltaX, deltaY: args.deltaY }));
      case 'mobile.devices': {
        const library = await this.sessions.library();
        const devices = Object.entries(library.devices).filter(([name]) => !args.query || name.toLowerCase().includes(args.query.toLowerCase())).slice(0, args.limit).map(([name, item]) => ({ name, viewport: item.viewport, screen: item.screen, deviceScaleFactor: item.deviceScaleFactor, isMobile: item.isMobile, hasTouch: item.hasTouch, defaultBrowserType: item.defaultBrowserType }));
        return { data: { devices } };
      }
      case 'mobile.tap': {
        if (!session.settings.hasTouch) fail('UNSUPPORTED_CAPABILITY', 'Touch operations require a hasTouch context; no mouse fallback is used.');
        if (args.target) return this.targetAction(targetRecord, args.target, target => target.tap({ timeout: args.timeoutMs }));
        this.point(page, args.point);
        return this.pageAction(page, () => page.page.touchscreen.tap(args.point.x, args.point.y), () => ({ point: args.point }));
      }
      case 'mobile.swipe': return this.swipe(page, args, signal);
      case 'emulate.viewport':
        if (session.captures.size) fail('INVALID_STATE', 'Finalize active captures before changing their viewport.');
        this.sessions.checkViewport(args, session.settings.deviceScaleFactor);
        await page.page.setViewportSize({ width: args.width, height: args.height });
        return { data: { viewport: page.page.viewportSize(), identityUnchanged: true } };
      case 'emulate.media': await page.page.emulateMedia(args); return { data: { media: args } };
      case 'emulate.offline': await session.context.setOffline(args.offline); session.settings.offline = args.offline; return { data: { offline: args.offline } };
      case 'diagnostics.console':
      case 'diagnostics.errors':
      case 'diagnostics.requests': return { data: this.diagnosticEntries(page, operation.split('.')[1], args) };
      case 'diagnostics.request': {
        if (args.includeBody || args.includeHeaders) fail('UNSUPPORTED_CAPABILITY', 'Raw request headers/bodies are not captured in this baseline; no implicit sensitive-data fallback.');
        const entries = page.logs.requests.filter(item => item.requestId === args.requestId);
        if (!entries.length) fail('STALE_HANDLE', 'Owned request is no longer present in the bounded event buffer.');
        return { data: { request: entries.at(-1) } };
      }
      case 'media.screenshot': return this.capture.screenshot(page, args);
      case 'media.video.start': return this.captureResult(await this.capture.startVideo(page, args));
      case 'media.video.status':
      case 'media.trace.status': return this.captureResult(this.capture.status(args.captureId, session));
      case 'media.video.stop':
      case 'media.trace.stop': return this.captureResult(await this.capture.stop(args.captureId, session, args, signal));
      case 'media.trace.start': return this.captureResult(await this.capture.startTrace(session, args));
      case 'files.upload':
        if (!stagedFiles) fail('POLICY_DENIED', 'Upload requires the host-authorized staging route, never direct model-controlled paths.');
        return this.stagedUpload(targetRecord, args, stagedFiles);
      case 'files.downloads.list': return { data: { downloads: [...(session.downloads?.values() ?? [])].slice(-args.limit).map(item => ({ ...item })) } };
      case 'files.downloads.status': {
        const download = session.downloads?.get(args.downloadId);
        if (!download) fail('STALE_HANDLE', 'Owned download was not found.');
        return { data: { download: { ...download } } };
      }
      case 'artifacts.list': return { data: this.artifactEntries(args) };
      case 'artifacts.inspect': return { data: { artifact: this.artifacts.inspect(args.artifactId) } };
      case 'artifacts.export': fail('POLICY_DENIED', 'Artifact export is performed only by the native host-authorized filesystem route.');
      default: fail('UNSUPPORTED_CAPABILITY', 'This operation has no verified owned runtime adapter.');
    }
  }
  captureResult(status) {
    const { artifacts, warnings, ...data } = status;
    return { data, artifacts, warnings, ...(status.state === 'partial' || status.state === 'failed' ? { status: 'partial' } : {}) };
  }
  async pageAction(record, action, data = () => ({})) {
    let listener;
    const dialog = new Promise(resolve => { listener = entry => resolve({ dialog: entry }); record.dialogListeners.add(listener); });
    const active = Promise.resolve().then(action);
    const completion = active.then(value => ({ value }), error => ({ error }));
    record.session.pendingActions.add(completion);
    completion.then(() => record.session.pendingActions.delete(completion));
    // The losing action is not abandoned: the session explicitly owns it, with the API's finite timeout,
    // and dialog.respond/close joins it. This is analogous to the bounded owned video-start lifecycle.
    try {
      const outcome = await Promise.race([completion, dialog]);
      if (outcome.dialog) return { status: 'partial', data: { ...data(), pendingDialog: pendingDialog(record), actionPending: true }, warnings: [{ code: 'DIALOG_PENDING', message: 'The action remains owned and bounded while its explicit dialog decision is pending. Respond on this Page before another action.' }] };
      if (outcome.error) throw outcome.error;
      return { data: data(outcome.value) };
    } finally { record.dialogListeners.delete(listener); }
  }
  async targetAction(record, target, action) {
    const handle = await this.targets.resolve(record, target);
    let active;
    try { return await this.pageAction(record.baseRecord ?? record, () => { active = Promise.resolve().then(() => action(handle)); return active; }); }
    finally {
      if (target.kind !== 'ref') {
        const disposal = (active ?? Promise.resolve()).catch(() => {}).then(() => handle.dispose().catch(() => {}));
        record.session.pendingActions.add(disposal);
        disposal.then(() => record.session.pendingActions.delete(disposal));
        if (!(record.baseRecord ?? record).currentDialog) await disposal;
      }
    }
  }
  point(record, point) {
    const viewport = record.page.viewportSize();
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height) fail('INVALID_ARGS', 'Touch/pointer point must lie inside this Page’s CSS viewport.');
  }
  async drag(record, args) {
    return this.targets.use(record, args.source, source => this.targets.use(record, args.destination, async destination => {
      await source.scrollIntoViewIfNeeded({ timeout: args.timeoutMs });
      await destination.scrollIntoViewIfNeeded({ timeout: args.timeoutMs });
      const from = await source.boundingBox(), to = await destination.boundingBox();
      if (!from || !to) fail('TARGET_NOT_FOUND', 'Drag endpoints must be visible.');
      const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 }, b = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
      this.point(record, a); this.point(record, b);
      return this.pageAction(record.baseRecord ?? record, async () => {
        await record.page.mouse.move(a.x, a.y);
        await record.page.mouse.down();
        try { await record.page.mouse.move(b.x, b.y, { steps: 12 }); }
        finally { await record.page.mouse.up().catch(() => {}); }
      }, () => ({ from: a, to: b, gesture: 'mouse-drag' }));
    }));
  }
  async swipe(record, args, signal) {
    if (record.session.settings.engine !== 'chromium' || !record.session.settings.hasTouch) fail('UNSUPPORTED_CAPABILITY', 'Trusted swipe requires Chromium and a hasTouch context; no synthetic or mouse fallback is available.');
    this.point(record, args.from); this.point(record, args.to);
    const cdp = await record.session.context.newCDPSession(record.page);
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...args.from, id: 1 }] });
      for (let index = 1; index <= args.steps; index++) {
        await delay(args.durationMs / args.steps, undefined, { signal });
        const fraction = index / args.steps;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: args.from.x + (args.to.x - args.from.x) * fraction, y: args.from.y + (args.to.y - args.from.y) * fraction, id: 1 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      return { data: { gesture: 'trusted-touch-swipe', from: args.from, to: args.to, durationMs: args.durationMs, steps: args.steps } };
    } finally {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  }
  encodeCursor(scope, after) {
    const payload = Buffer.from(JSON.stringify({ scope, after })).toString('base64url');
    return `${payload}.${createHmac('sha256', this.cursorKey).update(payload).digest('base64url')}`;
  }
  decodeCursor(cursor, scope) {
    if (!cursor) return null;
    const parts = cursor.split('.');
    if (parts.length !== 2) fail('INVALID_CURSOR', 'Cursor is invalid or belongs to another owned query.');
    const expected = createHmac('sha256', this.cursorKey).update(parts[0]).digest();
    const supplied = Buffer.from(parts[1], 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) fail('INVALID_CURSOR', 'Cursor is invalid or belongs to another owned query.');
    let value; try { value = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { fail('INVALID_CURSOR', 'Cursor payload is invalid.'); }
    if (value.scope !== scope) fail('INVALID_CURSOR', 'Cursor query or owned document changed.');
    return value.after;
  }
  diagnosticEntries(record, channel, args) {
    const scope = JSON.stringify({ channel, pageId: record.pageId, document: record.document, query: args.query ?? '', level: args.level ?? '', limit: args.limit });
    const after = this.decodeCursor(args.cursor, scope) ?? 0;
    const buffer = record.logs[channel];
    const entries = buffer.filter(item => item.sequence > after && (!args.level || item.type === args.level) && (!args.query || JSON.stringify(item).toLowerCase().includes(args.query.toLowerCase()))).slice(0, args.limit);
    const last = entries.at(-1)?.sequence ?? Math.max(after, record.sequences[channel]);
    return { entries, cursor: this.encodeCursor(scope, last), truncated: buffer.length > 0 && after > 0 && after < buffer[0].sequence - 1 };
  }
  artifactEntries(args) {
    const scope = JSON.stringify({ kind: args.kind ?? '', state: args.state ?? '', query: args.query ?? '', limit: args.limit });
    const after = this.decodeCursor(args.cursor, scope);
    const all = this.artifacts.list();
    const index = after ? all.findIndex(item => item.artifactId === after) : -1;
    if (after && index === -1) fail('INVALID_CURSOR', 'Artifact cursor expired.');
    const items = all.slice(index + 1).filter(item => (!args.kind || item.kind === args.kind) && (!args.state || item.state === args.state) && (!args.query || JSON.stringify(item).toLowerCase().includes(args.query.toLowerCase())));
    const artifacts = items.slice(0, args.limit);
    return { artifacts, ...(items.length > artifacts.length ? { cursor: this.encodeCursor(scope, artifacts.at(-1).artifactId) } : {}) };
  }
  async stagedUpload(record, args, stagedFiles) {
    if (!Array.isArray(stagedFiles) || !stagedFiles.length || stagedFiles.length !== args.paths.length || stagedFiles.length > 16) fail('POLICY_DENIED', 'Host upload staging did not match the approved file count.');
    const root = await realpath(this.artifactRoot);
    const payloads = [];
    let total = 0;
    for (const item of stagedFiles) {
      if (!item || typeof item.path !== 'string' || !isAbsolute(item.path) || !inside(root, await realpath(item.path))) fail('POLICY_DENIED', 'Upload file is outside this worker’s owned staging namespace.');
      const file = await open(item.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 32 * 1024 ** 2 || (total += info.size) > Math.min(64 * 1024 ** 2, this.config.limits.sessionBytes)) fail('LIMIT_EXCEEDED', 'Staged upload exceeds its bounded file budget.');
        bytes = await file.readFile();
        if (bytes.length !== info.size || (item.sha256 && createHash('sha256').update(bytes).digest('hex') !== item.sha256)) fail('SOURCE_CHANGED', 'Staged upload changed after authorization.');
      } finally { await file.close(); }
      payloads.push({ name: basename(item.name ?? item.path).replace(/[\u0000-\u001f]/g, '_'), mimeType: item.mime ?? item.mimeType ?? 'application/octet-stream', buffer: bytes });
    }
    return this.targets.use(record, args.target, async target => {
      await target.setInputFiles(payloads, { timeout: args.timeoutMs });
      return { data: { uploaded: payloads.map(item => ({ name: item.name, mime: item.mimeType, bytes: item.buffer.length })) } };
    });
  }
  ownDownload(session, record, download) {
    session.downloads ??= new Map();
    const downloadId = `bw_${randomUUID()}`;
    const entry = { downloadId, pageId: record.pageId, state: 'pending', name: basename(download.suggestedFilename()).replace(/[\u0000-\u001f]/g, '_') };
    session.downloads.set(downloadId, entry);
    const task = (async () => {
      if (!this.config.allowDownloads || !session.settings.acceptDownloads) { await download.cancel(); entry.state = 'denied'; return; }
      const artifact = await this.artifacts.reserve({ kind: 'download', mime: 'application/octet-stream', extension: 'bin', sessionId: session.sessionId, pageId: record.pageId, generation: session.generation });
      entry.artifactId = artifact.artifactId;
      try {
        await download.saveAs(artifact.path);
        const failure = await download.failure();
        if (failure) throw new BrowserError('DOWNLOAD_FAILED', 'Download did not complete.');
        const finalized = await this.artifacts.finalize(artifact.artifactId);
        entry.state = 'finalized'; entry.bytes = finalized.bytes;
      } catch { entry.state = 'partial'; await this.artifacts.mark(artifact.artifactId, 'partial'); }
    })().catch(() => { entry.state = 'failed'; });
    session.pendingActions.add(task);
    task.then(() => session.pendingActions.delete(task));
  }
  async close() {
    if (!this.closing) this.closing = (async () => {
      await this.sessions.closeAll();
      await this.capture.close();
      await this.queue;
    })();
    return this.closing;
  }
}
