import { randomUUID } from 'node:crypto';
import { loadRuntime } from '../deps.mjs';
import { fail } from '../errors.mjs';

const boundText = (text, limit = 2048) => String(text ?? '').slice(0, limit);
export function safeUrl(value) {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString().slice(0, 4096); }
  catch { return String(value ?? '').slice(0, 4096); }
}
const contextKeys = ['viewport', 'screen', 'deviceScaleFactor', 'isMobile', 'hasTouch', 'userAgent', 'locale', 'timezoneId', 'colorScheme', 'reducedMotion', 'offline'];

export class SessionManager {
  constructor({ config = {}, onInvalidate = () => {}, beforeClose = async () => {} }) {
    this.config = config;
    this.limits = config.limits ?? {};
    this.sessions = new Map();
    this.pageHandles = new WeakMap();
    this.browser = null;
    this.browserSettings = null;
    this.browserStarting = null;
    this.onInvalidate = onInvalidate;
    this.beforeClose = beforeClose;
    this.stopping = false;
  }
  async library() {
    const module = await loadRuntime('playwright');
    // createRequire resolves the package's public CJS entry; its Playwright API is the default export.
    return module.chromium ? module : module.default;
  }
  get(sessionId, { allowClosed = false } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session || (!allowClosed && session.state !== 'ready')) fail('SESSION_NOT_FOUND', 'Owned live browser session was not found.');
    return session;
  }
  resolvePage(session, pageId) {
    const pages = [...session.pages.values()].filter(item => !item.page.isClosed());
    if (!pageId) {
      if (pages.length !== 1) fail('INVALID_ARGS', 'pageId is required unless the session has exactly one live page.');
      return pages[0];
    }
    const record = session.pages.get(pageId);
    if (!record || record.page.isClosed()) fail('PAGE_NOT_FOUND', 'Owned live page was not found.');
    return record;
  }
  async contextOptions(args = {}) {
    const library = await this.library();
    const emulation = args.emulation ?? {};
    let descriptor = {};
    const device = emulation.device ?? emulation.preset;
    if (device !== undefined) {
      descriptor = library.devices[device];
      if (!descriptor) fail('UNSUPPORTED_CAPABILITY', 'Requested device preset is unavailable in this Playwright version.');
    }
    const options = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
    for (const key of contextKeys) if (descriptor[key] !== undefined) options[key] = descriptor[key];
    for (const key of contextKeys) if (emulation[key] !== undefined) options[key] = emulation[key];
    if (emulation.dpr !== undefined) options.deviceScaleFactor = emulation.dpr;
    if (emulation.orientation === 'landscape' && options.viewport.height > options.viewport.width) {
      options.viewport = { width: options.viewport.height, height: options.viewport.width };
      if (options.screen) options.screen = { width: options.screen.height, height: options.screen.width };
    }
    this.checkViewport(options.viewport, options.deviceScaleFactor);
    if (options.screen) this.checkViewport(options.screen, options.deviceScaleFactor);
    const downloads = args.downloads === true || args.acceptDownloads === true;
    if (downloads && !this.config.allowDownloads) fail('POLICY_DENIED', 'Downloads are disabled by browser policy.');
    options.acceptDownloads = downloads;
    return options;
  }
  checkViewport(viewport, dpr = 1) {
    if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width < 1 || viewport.height < 1 || viewport.width > (this.limits.viewportWidth ?? 2560) || viewport.height > (this.limits.viewportHeight ?? 1440)) fail('LIMIT_EXCEEDED', 'Viewport exceeds the browser limits.');
    if (!Number.isFinite(dpr) || dpr <= 0 || dpr > (this.limits.dpr ?? 3) || viewport.width * viewport.height * dpr ** 2 > (this.limits.pixels ?? 16_000_000)) fail('LIMIT_EXCEEDED', 'Viewport DPR or rendered pixel budget exceeds the browser limits.');
  }
  async ensureBrowser(engine, headless) {
    if (this.stopping) fail('BACKEND_UNAVAILABLE', 'Browser runtime is closing.');
    if (!(this.config.allowedEngines ?? ['chromium']).includes(engine)) fail('UNSUPPORTED_CAPABILITY', 'Browser engine is disabled or unsupported.');
    if (this.browserStarting) await this.browserStarting;
    if (this.browser) {
      if (this.browserSettings.engine !== engine || this.browserSettings.headless !== headless) {
        if ([...this.sessions.values()].some(session => ['ready', 'starting', 'closing', 'replacing'].includes(session.state))) fail('INVALID_STATE', 'Close existing sessions before changing the shared browser engine or headed mode.');
        await this.closeBrowser();
      } else return this.browser;
    }
    this.browserStarting = (async () => {
      const library = await this.library();
      const browserType = library[engine];
      if (!browserType || !['chromium', 'firefox', 'webkit'].includes(engine)) fail('UNSUPPORTED_CAPABILITY', 'Browser engine is not available.');
      const launch = { headless };
      if (engine === 'chromium') launch.chromiumSandbox = true;
      const browser = await browserType.launch(launch);
      if (this.stopping) { await browser.close(); fail('BACKEND_UNAVAILABLE', 'Browser runtime closed during startup.'); }
      this.browser = browser;
      this.browserSettings = { engine, headless };
      browser.on('disconnected', () => {
        if (this.browser === browser) { this.browser = null; this.browserSettings = null; }
        for (const session of this.sessions.values()) if (session.state === 'ready') {
          session.state = 'failed'; clearTimeout(session.idleTimer);
          for (const page of session.pages.values()) this.onInvalidate(page);
        }
      });
      return browser;
    })();
    try { return await this.browserStarting; }
    finally { this.browserStarting = null; }
  }
  async open(args = {}) {
    if ([...this.sessions.values()].filter(session => ['ready', 'starting', 'replacing'].includes(session.state)).length >= (this.limits.sessions ?? 2)) fail('LIMIT_EXCEEDED', 'Owned session limit reached.');
    while (this.sessions.size >= 16) {
      const retired = [...this.sessions.values()].find(session => ['closed', 'failed'].includes(session.state));
      if (!retired) break;
      this.sessions.delete(retired.sessionId);
    }
    const engine = args.engine ?? 'chromium';
    const headless = args.headless !== false;
    const options = await this.contextOptions(args);
    if (engine === 'firefox' && options.isMobile) fail('UNSUPPORTED_CAPABILITY', 'Firefox does not support mobile context emulation.');
    const browser = await this.ensureBrowser(engine, headless);
    const session = { sessionId: `bs_${randomUUID()}`, generation: 1, state: 'starting', context: null, pages: new Map(), settings: { engine, headless, ...options }, originalArgs: structuredClone(args), captures: new Set(), pendingActions: new Set(), idleTimer: null };
    this.sessions.set(session.sessionId, session);
    try {
      session.context = await browser.newContext(options);
      if (this.stopping) fail('BACKEND_UNAVAILABLE', 'Browser runtime closed during context startup.');
      session.context.setDefaultTimeout(this.limits.actionMs ?? 5000);
      session.context.setDefaultNavigationTimeout(this.limits.navigationMs ?? 30000);
      session.context.on('page', page => this.registerPage(session, page));
      session.context.on('close', () => {
        clearTimeout(session.idleTimer);
        if (!['closed', 'replacing'].includes(session.state)) session.state = 'closed';
        for (const page of session.pages.values()) this.onInvalidate(page);
      });
      const page = this.registerPage(session, await session.context.newPage());
      session.settings.userAgent = options.userAgent ?? await page.page.evaluate(() => navigator.userAgent);
      session.state = 'ready';
      this.touch(session);
      return { session, page };
    } catch (error) {
      session.state = 'failed';
      await session.context?.close().catch(() => {});
      if (![...this.sessions.values()].some(item => item.state === 'ready')) await this.closeBrowser();
      throw error;
    }
  }
  registerPage(session, page) {
    const existing = this.pageHandles.get(page);
    if (existing) return existing;
    const historyLimit = Math.max(16, this.limits.tabs ?? 4);
    for (const retired of session.pages.values()) {
      if (session.pages.size < historyLimit) break;
      if (retired.page.isClosed()) { this.onInvalidate(retired); session.pages.delete(retired.pageId); }
    }
    const record = { pageId: `bp_${randomUUID()}`, session, page, document: 0, frames: new Map(), frameHandles: new WeakMap(), dialogs: new Map(), currentDialog: null, dialogListeners: new Set(), logs: { console: [], errors: [], requests: [] }, sequences: { console: 0, errors: 0, requests: 0 }, requestHandles: new WeakMap(), lost: false };
    this.pageHandles.set(page, record);
    session.pages.set(record.pageId, record);
    const append = (channel, data) => {
      const list = record.logs[channel];
      list.push({ sequence: ++record.sequences[channel], timestamp: new Date().toISOString(), ...data });
      if (list.length > 512) list.shift();
    };
    // Conservative document epochs invalidate even sibling-frame refs when any frame navigates.
    page.on('framenavigated', () => { record.document++; record.frames.clear(); record.frameHandles = new WeakMap(); this.onInvalidate(record); });
    page.on('framedetached', () => { record.document++; record.frames.clear(); record.frameHandles = new WeakMap(); this.onInvalidate(record); });
    page.on('close', () => { record.lost = true; this.onInvalidate(record); });
    page.on('console', message => append('console', { type: message.type(), text: boundText(message.text()), location: { url: safeUrl(message.location().url), lineNumber: message.location().lineNumber, columnNumber: message.location().columnNumber } }));
    page.on('pageerror', error => append('errors', { message: boundText(error.message) }));
    page.on('download', download => this.onDownload?.(session, record, download));
    page.on('request', request => {
      const entry = { requestId: `br_${randomUUID()}`, method: request.method(), url: safeUrl(request.url()), resourceType: request.resourceType(), state: 'pending' };
      record.requestHandles.set(request, entry);
      append('requests', entry);
    });
    page.on('requestfailed', request => {
      const entry = record.requestHandles.get(request);
      if (entry) append('requests', { ...entry, state: 'failed', failure: boundText(request.failure()?.errorText) });
    });
    page.on('response', response => {
      const entry = record.requestHandles.get(response.request());
      if (entry) append('requests', { ...entry, state: 'response', status: response.status() });
    });
    page.on('dialog', dialog => {
      const dialogId = `bd_${randomUUID()}`;
      const entry = { dialogId, dialog, type: dialog.type(), message: boundText(dialog.message()), handled: false };
      record.dialogs.set(dialogId, entry); record.currentDialog = entry;
      for (const listener of record.dialogListeners) listener(entry);
    });
    // A popup is owned but never silently becomes another call's selected page.
    if ([...session.pages.values()].filter(item => !item.page.isClosed()).length > (this.limits.tabs ?? 4)) {
      const closing = page.close().catch(() => {});
      session.pendingActions.add(closing); closing.finally(() => session.pendingActions.delete(closing));
    }
    return record;
  }
  touch(session) {
    clearTimeout(session.idleTimer);
    if (session.state !== 'ready') return;
    session.idleTimer = setTimeout(() => this.close(session.sessionId).catch(() => { session.state = 'failed'; }), this.limits.idleMs ?? 600000);
    session.idleTimer.unref();
  }
  status(session) {
    return { sessionId: session.sessionId, generation: session.generation, state: session.state, settings: structuredClone(session.settings), pages: this.pages(session) };
  }
  pages(session) {
    return [...session.pages.values()].filter(record => !record.page.isClosed()).map(record => ({ pageId: record.pageId, url: safeUrl(record.page.url()), document: record.document, dialog: record.currentDialog ? { dialogId: record.currentDialog.dialogId, type: record.currentDialog.type, message: record.currentDialog.message } : null }));
  }
  frames(record) {
    for (const frame of record.page.frames()) {
      if (!record.frameHandles.has(frame)) {
        const entry = { frameId: `bf_${randomUUID()}`, frame, document: record.document };
        record.frames.set(entry.frameId, entry); record.frameHandles.set(frame, entry);
      }
    }
    return [...record.frames.values()].filter(entry => !entry.frame.isDetached()).map(entry => ({ frameId: entry.frameId, parentFrameId: record.frameHandles.get(entry.frame.parentFrame())?.frameId ?? null, isMain: entry.frame === record.page.mainFrame(), url: safeUrl(entry.frame.url()), document: entry.document }));
  }
  frameTarget(record, frameId) {
    if (!frameId) return record;
    const entry = record.frames.get(frameId);
    if (!entry || entry.document !== record.document || entry.frame.isDetached() || entry.frame.page() !== record.page) fail('STALE_HANDLE', 'Frame reference is stale or belongs to a different owned Page.');
    return { ...record, baseRecord: record, frameId, root: entry.frame };
  }
  async createPage(session) {
    if (this.pages(session).length >= (this.limits.tabs ?? 4)) fail('LIMIT_EXCEEDED', 'Owned tab limit reached.');
    const record = this.registerPage(session, await session.context.newPage());
    this.touch(session);
    return record;
  }
  async dismissDialogs(session) {
    await Promise.all([...session.pages.values()].map(async record => {
      const entry = record.currentDialog;
      if (entry && !entry.handled) { entry.handled = true; await entry.dialog.dismiss().catch(() => {}); record.currentDialog = null; }
    }));
  }
  async close(sessionId) {
    const session = this.get(sessionId, { allowClosed: true });
    if (session.closing) return session.closing;
    if (session.state === 'closed') return;
    session.closing = (async () => {
      session.state = 'closing'; clearTimeout(session.idleTimer);
      await this.dismissDialogs(session);
      await this.beforeClose(session);
      await session.context?.close({ reason: 'Owned browser session closed' });
      await Promise.allSettled([...session.pendingActions]);
      for (const page of session.pages.values()) {
        this.onInvalidate(page);
        page.logs = { console: [], errors: [], requests: [] };
        page.dialogs.clear(); page.dialogListeners.clear(); page.frames.clear();
      }
      session.state = 'closed';
    })();
    await session.closing;
  }
  async replace(session, args = {}) {
    if (session.captures.size && !args.finalizeFirst) fail('INVALID_STATE', 'Finalize active captures before replacing the context.');
    const previousGeneration = session.generation;
    await this.close(session.sessionId);
    const nextArgs = { ...session.originalArgs, ...args };
    delete nextArgs.finalizeFirst;
    const replacement = await this.open(nextArgs);
    this.sessions.delete(replacement.session.sessionId);
    replacement.session.sessionId = session.sessionId;
    replacement.session.generation = previousGeneration + 1;
    this.sessions.set(session.sessionId, replacement.session);
    return replacement;
  }
  async closeBrowser() {
    if (this.browserStarting) await this.browserStarting.catch(() => {});
    const browser = this.browser;
    this.browser = null; this.browserSettings = null;
    await browser?.close();
  }
  async closeAll() {
    this.stopping = true;
    await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id)));
    await this.closeBrowser();
  }
}
