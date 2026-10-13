import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { encodeCursor, decodeCursor } from './cursors.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadRuntime } from './deps.mjs';
import { HostFiles, scrubbedEnvironment } from './host-files.mjs';
import { NativeManagedTransport, policyKey } from './transport.mjs';
import { BrowserError, fail } from './errors.mjs';
import { response } from './protocol.mjs';
import { catalogRevision } from './manifest.mjs';
import { resolveConfig } from './config.mjs';
import { validateCall, validateOutput } from './validation.mjs';
import { HostCapacity } from './capacity.mjs';

const workerHostPath = fileURLToPath(new URL('./worker/server.mjs', import.meta.url));
export class BrowserBroker {
  constructor(ctx, profile = {}) {
    this.ctx = ctx;
    this.profile = profile;
    this.files = new HostFiles(ctx);
    this.capacity = new HostCapacity();
    this.owners = new WeakMap();
    this.disposedAgents = new WeakSet();
    this.exportGrants = new WeakMap();
    this.records = new Set();
    this.cleanupTasks = new Set();
    this.cleanupFailures = [];
    this.cursorKey = randomBytes(32);
    this.stopping = false;
  }

  grantExport(exec, grant) {
    let grants = this.exportGrants.get(exec.agent);
    if (!grants) this.exportGrants.set(exec.agent, grants = new Map());
    for (const [id, value] of grants) if (value.expiresAt < Date.now()) grants.delete(id);
    if (grants.size >= 64) fail('LIMIT_EXCEEDED', 'Too many pending export authorizations.');
    grants.set(String(exec.callId), { ...grant, expiresAt: Date.now() + 60000 });
  }

  consumeExportGrant(exec) {
    const grants = this.exportGrants.get(exec.agent);
    const grant = grants?.get(String(exec.callId));
    grants?.delete(String(exec.callId));
    if (!grant || grant.expiresAt < Date.now()) fail('POLICY_DENIED', 'Export requires the native policy decision for this exact call and Agent.');
    return grant;
  }

  owner(agent) {
    if (!agent || typeof agent !== 'object' || !agent.session) fail('OWNER_REQUIRED', 'Stateful browser calls require an actual executing Agent.');
    if (this.disposedAgents.has(agent)) fail('WORKER_DISCONNECTED', 'Disposed Agents cannot reopen browser resources.');
    let record = this.owners.get(agent);
    if (!record) {
      record = { agent, ownerId: `bo_${randomUUID()}`, sessions: new Map(), captures: new Map(), queue: Promise.resolve(), slot: null, stagingBytes: 0, lifetime: new AbortController() };
      this.owners.set(agent, record);
      this.records.add(record);
      // Clear/fork scope disposal must quiesce this owner even without a global Agent event.
      if (agent.ctx && agent.ctx !== this.ctx && typeof agent.ctx.effect === 'function') {
        agent.ctx.effect(() => async () => this.disposeAgent(agent), 'browser.owner-lease');
      }
    }
    return record;
  }

  async configuration(agent) {
    try { return await resolveConfig(agent?.session.header.cwd ?? process.cwd(), this.profile); }
    catch (error) {
      const record = agent && this.owners.get(agent);
      if (record) { record.startController?.abort(); await this.discard(record); }
      throw error;
    }
  }

  async reconcileExisting(agent, settings) {
    const record = agent && this.owners.get(agent);
    if (record) await this.reauthorize(record, settings);
  }

  async discard(record) {
    const slot = record.slot;
    if (!slot) return;
    if (!slot.closePromise) {
      slot.closePromise = (async () => {
        slot.closing = true;
        try {
          if (slot.connected) {
            try { await this.rpc(record, { operation: '__shutdown', args: {} }, { callId: `cleanup_${randomUUID()}`, signal: AbortSignal.timeout(Math.min(5000, record.config.limits.finalizeMs)) }, slot); }
            catch { /* Native managed range termination is the authoritative fallback, never just PID close. */ }
          }
        } finally {
          try { await slot.stopWatch?.(); } catch { record.watchCleanupFailed = true; }
          const results = await Promise.allSettled([slot.client.close(), slot.transport.close()]);
          slot.controller.abort();
          const failures = results.filter(result => result.status === 'rejected');
          for (const entry of record.sessions.values()) entry.state = failures.length ? 'teardown-incomplete' : 'closed';
          if (failures.length) {
            record.blocked = new BrowserError('WORKER_TEARDOWN_INCOMPLETE', 'Owned browser range did not quiesce; further stateful calls are blocked.');
            throw record.blocked;
          }
          this.capacity.release(slot.capacityToken);
          if (record.slot === slot) record.slot = null;
        }
      })();
    }
    await slot.closePromise;
  }

  async reauthorize(record, settings) {
    const policy = this.files.policy(record.agent);
    const fingerprint = `${policyKey(policy)}:${settings.revision}`;
    if (record.slot && (record.slot.fingerprint !== fingerprint || record.slot.closing || record.slot.transport.closed)) await this.discard(record);
    record.config = settings.config;
    record.configurationRevision = settings.revision;
    record.catalogRevision = catalogRevision(settings.config);
    record.policy = policy;
    return fingerprint;
  }

  assertOwner(record, signal) {
    signal?.throwIfAborted();
    if (this.stopping || record.disposed) fail('WORKER_DISCONNECTED', 'Browser owner or gateway is stopping.');
  }

  async start(record, settings, signal) {
    this.assertOwner(record, signal);
    const controller = record.startController = new AbortController();
    let token;
    try {
      await this.reauthorize(record, settings);
      this.assertOwner(record, signal);
      if (record.slot) return record.slot;
      token = record.startCapacityToken = this.capacity.reserve(settings.config);
      return await this.startOwned(record, settings, AbortSignal.any([signal ?? new AbortController().signal, controller.signal, record.lifetime.signal]));
    } finally {
      if (token && !record.blocked && record.slot?.capacityToken !== token) this.capacity.release(token);
      if (record.startCapacityToken === token) record.startCapacityToken = null;
      if (record.startController === controller) record.startController = null;
    }
  }

  async startOwned(record, settings, signal) {
    this.assertOwner(record, signal);
    if (record.blocked) throw record.blocked;
    const fingerprint = await this.reauthorize(record, settings);
    this.assertOwner(record, signal);
    if (record.slot) return record.slot;
    if (record.policy.mode === 'read-only' || !record.config.enabled) fail('POLICY_DENIED', 'Current browser authority is metadata-only or disabled.');
    signal?.throwIfAborted();
    await this.files.bootstrap(record, signal);
    this.assertOwner(record, signal);
    const workerPath = this.files.fs().processPathFromHostPath(workerHostPath);
    if (!workerPath) fail('UNSUPPORTED_EXECUTION_WORLD', 'Browser worker code is not shared with the native process world.');
    const { Client } = await loadRuntime('@modelcontextprotocol/client');
    this.assertOwner(record, signal);
    const controller = new AbortController();
    const toolPaths = {};
    for (const tool of ['ffprobe', 'ffmpeg']) {
      try { toolPaths[tool] = await this.ctx.subprocess.resolveExecutable(tool, scrubbedEnvironment(), signal); }
      catch { /* Capability limitations are explicit in the worker, not a shell fallback. */ }
      this.assertOwner(record, signal);
    }
    const currentSettings = await this.configuration(record.agent);
    this.assertOwner(record, signal);
    if (currentSettings.revision !== settings.revision) fail('POLICY_CHANGED', 'Browser configuration changed during startup; authorize a new call.');
    const retained = (await this.files.listArtifacts(record, signal)).filter(item => !item.path?.startsWith(`${record.artifactRoot}/`));
    const externalArtifactBudget = { bytes: retained.reduce((sum, item) => sum + item.bytes, record.stagingBytes ?? 0), count: retained.length };
    this.assertOwner(record, signal);
    const boot = { ownerId: record.ownerId, artifactRoot: record.artifactRoot, config: record.config, catalogRevision: record.catalogRevision, toolPaths, externalArtifactBudget };
    const env = scrubbedEnvironment({ HOME: join(record.artifactRoot, 'home'), TMPDIR: join(record.artifactRoot, 'tmp'), PLAYWRIGHT_BROWSERS_PATH: record.config.browserCache, DSH_BROWSER_BOOT: JSON.stringify(boot) });
    const transport = new NativeManagedTransport({ ctx: this.ctx, session: record.agent.session, workerPath, cwd: record.artifactRoot, env, expectedPolicy: record.policy, signal: AbortSignal.any([controller.signal, record.lifetime.signal]), cleanupMs: Math.min(15000, record.config.limits.finalizeMs) });
    const client = new Client({ name: 'dsh-browser-gateway', version: '1.0.0' });
    const slot = { client, transport, controller, fingerprint, connected: false, closing: false, capacityToken: record.startCapacityToken };
    record.slot = slot;
    client.onerror = () => {}; // Errors surface on the owned call; never leak raw worker stderr/engine causes.
    client.onclose = () => {
      slot.connected = false;
      for (const entry of record.sessions.values()) entry.state = 'closed';
      if (record.slot === slot && !slot.closing) this.trackCleanup(this.discard(record));
    };
    const cancel = () => { controller.abort(); void transport.close().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await client.connect(transport, { timeout: 10000 });
      slot.connected = true;
      const tools = await client.listTools({}, { signal, timeout: 5000 });
      if (tools.tools.length !== 1 || tools.tools[0].name !== 'browser') fail('BACKEND_INVALID_OUTPUT', 'Private worker must expose exactly one browser root.');
      const handshake = await this.rpc(record, { operation: '__handshake', args: {} }, { callId: `handshake_${randomUUID()}`, signal }, slot);
      if (!handshake.ownerMatched || handshake.manifestHash !== record.catalogRevision || handshake.backend !== 'playwright-1.64.0-page-bound') fail('BACKEND_INVALID_OUTPUT', 'Browser backend owner/catalog/version handshake failed.');
      if (!Number.isSafeInteger(handshake.workerPid) || handshake.workerPid < 1) fail('BACKEND_INVALID_OUTPUT', 'Private browser worker lifecycle identity is invalid.');
      slot.workerPid = handshake.workerPid; // Private owned-channel lifecycle evidence, never a public browser ref.
      signal?.throwIfAborted();
      if (settings.root) {
        try {
          const target = await this.ctx.fs.resolve(join(settings.root, '.agents', 'config.json'), { signal: controller.signal });
          slot.stopWatch = await this.ctx.fs.watch(target, () => {
            this.trackCleanup((async () => {
              let changed = true;
              try { changed = (await this.configuration(record.agent)).revision !== record.configurationRevision; } catch { /* Invalid configuration revokes the existing grant. */ }
              if (changed) await this.discard(record);
            })());
          }, controller.signal);
        } catch { record.configWatchUnavailable = true; }
      }
      this.assertOwner(record, signal);
      if ((await this.configuration(record.agent)).revision !== settings.revision) fail('POLICY_CHANGED', 'Browser configuration changed before the first effect; previous session handles are invalid.');
      this.assertOwner(record, signal);
      return slot;
    } catch (error) {
      await this.discard(record);
      throw error;
    } finally { signal?.removeEventListener('abort', cancel); }
  }

  async rpc(record, request, exec, slot = record.slot) {
    if (!slot) fail('WORKER_DISCONNECTED', 'Owned browser worker is not connected.');
    const deadlineMs = Math.min(exec.deadlineMs ?? Infinity, Date.now() + Math.min(record.config.limits.rootMs, request.operation.startsWith('__') ? 10000 : Math.max(record.config.limits.navigationMs, record.config.limits.actionMs)));
    const budget = Math.floor(deadlineMs - Date.now());
    if (budget <= 0) fail('DEADLINE_EXCEEDED', 'Browser root work budget expired; phase budgets are never renewed.');
    let result;
    try {
      result = await slot.client.callTool({ name: 'browser', arguments: { request, authority: { ownerId: record.ownerId, manifestHash: record.catalogRevision, callId: String(exec.callId), deadlineMs } } }, { signal: exec.signal, timeout: budget + 1000 });
    } catch (error) {
      // Public SDK2 SdkErrorCode values; caller cancellation is handled separately by the owned queue.
      if (error.code === 'REQUEST_TIMEOUT') throw new BrowserError('DEADLINE_EXCEEDED', 'Browser SDK request timed out; owned session handles must be invalidated.');
      if (['NOT_CONNECTED', 'CONNECTION_CLOSED', 'SEND_FAILED', 'NOT_INITIALIZED'].includes(error.code)) throw new BrowserError('WORKER_DISCONNECTED', 'Owned browser channel disconnected; inspect state before repeating an effect.');
      if (['INVALID_RESULT', 'UNSUPPORTED_RESULT_TYPE'].includes(error.code)) throw new BrowserError('BACKEND_INVALID_OUTPUT', 'Owned browser protocol result is invalid.');
      throw error;
    }
    if (result.isError) {
      const error = result.structuredContent?.error;
      if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') fail('BACKEND_ERROR', 'Private browser request failed.');
      throw new BrowserError(error.code, error.message, error);
    }
    if (!result.structuredContent || typeof result.structuredContent !== 'object') fail('BACKEND_INVALID_OUTPUT', 'Private browser result is missing canonical structured data.');
    return result.structuredContent;
  }

  async local(record, request, exec) {
    const context = { callId: String(exec.callId), catalogRevision: record.catalogRevision };
    const current = record.policy.mode !== 'read-only' && record.slot?.connected && !record.slot.closing;
    const lastKnown = [{ code: 'LAST_KNOWN_STATUS', message: 'No live worker was queried; this is owned lifecycle metadata, not a claim that a browser action is currently possible.' }];
    if (request.operation === 'session.list') {
      if (current) return this.liveMetadata(record, request, exec);
      return response(request, context, { data: { sessions: [...record.sessions.values()].slice(-16) }, warnings: lastKnown });
    }
    if (request.operation === 'session.status') {
      const session = record.sessions.get(request.sessionId);
      if (!session) fail('SESSION_NOT_FOUND', 'Owned session was not found.');
      if (current && !['closed', 'failed', 'teardown-incomplete'].includes(session.state)) return this.liveMetadata(record, request, exec);
      return response(request, context, { refs: { sessionId: session.sessionId, generation: session.generation }, data: session, warnings: lastKnown });
    }
    if (['media.video.status', 'media.trace.status'].includes(request.operation)) {
      const capture = record.captures.get(request.args.captureId);
      const session = record.sessions.get(request.sessionId);
      if (!capture || capture.sessionId !== request.sessionId || capture.data.generation !== session?.generation || capture.kind !== (request.operation === 'media.video.status' ? 'video' : 'trace')) fail('STALE_HANDLE', 'Owned capture was not found in this session generation.');
      if (current && !['closed', 'failed', 'teardown-incomplete'].includes(session.state)) return this.liveMetadata(record, request, exec);
      const artifacts = (await this.files.listArtifacts(record, exec.signal)).filter(item => item.captureId === request.args.captureId && item.sessionId === request.sessionId && item.generation === session.generation);
      const primary = artifacts.find(item => item.kind === capture.kind);
      const state = primary?.state ?? (['starting', 'recording', 'stopping'].includes(capture.data.state) ? 'partial' : capture.data.state);
      // Metadata queries never admit image bytes or create native attachments, including inspected video frames.
      return response(request, context, { refs: { sessionId: request.sessionId, generation: session.generation }, data: { ...capture.data, state, artifactMetadata: artifacts }, warnings: lastKnown, ...(state === 'partial' || state === 'failed' ? { status: 'partial' } : {}) });
    }
    if (request.operation === 'artifacts.list') {
      const list = await this.files.listArtifacts(record, exec.signal);
      const filtered = list.filter(item => (!request.args.kind || item.kind === request.args.kind) && (!request.args.state || item.state === request.args.state) && (!request.args.query || JSON.stringify(item).includes(request.args.query)));
      const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const claims = { owner: record.ownerId, revision: record.catalogRevision, filter: digest({ kind: request.args.kind, state: request.args.state, query: request.args.query }), content: digest(filtered.map(item => [item.artifactId, item.state, item.bytes, item.sha256])) };
      const offset = request.args.cursor ? decodeCursor(this.cursorKey, request.args.cursor, claims).offset : 0;
      const artifacts = filtered.slice(offset, offset + request.args.limit);
      const next = offset + artifacts.length;
      const cursor = next < filtered.length ? encodeCursor(this.cursorKey, { ...claims, offset: next, expiresAt: Date.now() + 15 * 60 * 1000 }) : undefined;
      return response(request, context, { data: { artifacts, cursor, hasMore: next < filtered.length } });
    }
    if (request.operation === 'artifacts.inspect') {
      const artifact = await this.files.findArtifact(record, request.args.artifactId, exec.signal);
      return response(request, context, { data: { artifact }, artifacts: artifact.state === 'finalized' ? [artifact] : [] });
    }
    return null;
  }

  async confirmDelivery(record, value, exec, slot) {
    const originals = value.artifacts.filter(item => item.state === 'finalized');
    if (!originals.length) return;
    const settings = await this.configuration(record.agent);
    await this.reauthorize(record, settings);
    if (record.slot !== slot || slot.closing || record.policy.mode === 'read-only') fail('POLICY_CHANGED', 'Browser authority changed before artifact delivery confirmation.', { effectState: 'unknown', retryable: false });
    const ids = [...new Set(originals.map(item => item.artifactId))];
    const ack = await this.rpc(record, { operation: '__delivered', args: { artifactIds: ids } }, exec, slot);
    if (!Array.isArray(ack.artifacts) || ack.artifacts.length !== ids.length) fail('BACKEND_INVALID_OUTPUT', 'Delivery confirmation does not match the owned artifact set.');
    const immutable = ['artifactId', 'kind', 'mime', 'bytes', 'sha256', 'path', 'sessionId', 'generation', 'pageId', 'captureId', 'width', 'height', 'durationMs', 'state'];
    const confirmed = new Map();
    for (const item of ack.artifacts) {
      const original = originals.find(candidate => candidate.artifactId === item.artifactId);
      if (!original || confirmed.has(item.artifactId) || immutable.some(key => item[key] !== original[key]) || !Number.isFinite(Date.parse(item.retentionUntil))) fail('BACKEND_INVALID_OUTPUT', 'Delivery confirmation changed immutable artifact identity or evidence.');
      confirmed.set(item.artifactId, item);
    }
    value.artifacts = value.artifacts.map(item => confirmed.get(item.artifactId) ?? item);
    await validateOutput(value.operation, value, { config: record.config });
  }

  rememberSession(record, session) {
    record.sessions.set(session.sessionId, { ...session });
    // Preserve live handles; only bounded, inactive lifecycle history may be forgotten.
    while (record.sessions.size > 16) {
      const expired = [...record.sessions].find(([, value]) => ['closed', 'failed', 'teardown-incomplete'].includes(value.state));
      if (!expired) break;
      record.sessions.delete(expired[0]);
    }
  }

  rememberCapture(record, capture) {
    record.captures.set(capture.data.captureId, capture);
    while (record.captures.size > 1000) {
      const expired = [...record.captures].find(([, value]) => record.sessions.get(value.sessionId)?.state !== 'ready' || record.sessions.get(value.sessionId)?.generation !== value.data.generation || !['starting', 'recording', 'stopping'].includes(value.data.state));
      if (!expired) break;
      record.captures.delete(expired[0]);
    }
  }

  async liveMetadata(record, request, exec) {
    try {
      const value = await this.rpc(record, request, exec);
      await validateOutput(request.operation, value, { config: record.config });
      if (value.operation !== request.operation || value.callId !== String(exec.callId)) fail('BACKEND_INVALID_OUTPUT', 'Metadata response is not bound to this call.');
      if (request.operation === 'session.list') for (const session of value.data.sessions) this.rememberSession(record, session);
      if (request.operation === 'session.status') this.rememberSession(record, value.data);
      if (request.operation.startsWith('media.')) record.captures.get(request.args.captureId).data = { ...value.data };
      return value;
    } catch (error) {
      if (exec.signal?.aborted || ['WORKER_DISCONNECTED', 'DEADLINE_EXCEEDED', 'BACKEND_INVALID_OUTPUT'].includes(error.code)) await this.discard(record);
      throw error;
    }
  }

  async invoke(input, exec) {
    const record = this.owner(exec.agent);
    const work = async () => {
      exec.signal?.throwIfAborted();
      const settings = await this.configuration(exec.agent);
      await this.reauthorize(record, settings);
      const { request } = await validateCall(input, { config: settings.config });
      const local = await this.local(record, request, exec);
      if (local) return { value: local, record };
      if (request.operation === 'artifacts.export') {
        const data = await this.files.export(record, request, exec, this.consumeExportGrant(exec));
        const value = response(request, { callId: String(exec.callId), catalogRevision: record.catalogRevision }, { data, effects: [{ kind: 'export-artifact', state: 'applied' }] });
        await validateOutput(request.operation, value, { config: record.config });
        return { value, record };
      }
      if (record.policy.mode === 'read-only') fail('POLICY_DENIED', 'Read-only browser calls are metadata-only.');
      if (request.sessionId) {
        const session = record.sessions.get(request.sessionId);
        if (!session) fail('SESSION_NOT_FOUND', 'Owned session was not found; no worker was launched.');
        if (session.state === 'closed') fail('STALE_SESSION', 'Owned session is closed; create a new session instead of reusing old handles.');
      }
      const slot = await this.start(record, settings, exec.signal);
      let stagedFiles;
      const cancel = () => { slot.cancelled = true; void slot.transport.close().catch(() => {}); };
      exec.signal?.addEventListener('abort', cancel, { once: true });
      try {
        let remoteRequest = request;
        if (request.operation === 'files.upload') {
          const files = stagedFiles = await this.files.stage(record, request.args.paths, exec);
          // Only staging paths cross the private execution seam. Original host paths are not browser inputs.
          remoteRequest = { operation: '__upload', args: { publicRequest: { ...request, args: { ...request.args, paths: files.map(file => file.name) } }, files } };
        }
        const value = await this.rpc(record, remoteRequest, exec, slot);
        await validateOutput(request.operation, value, { config: record.config });
        if (value.operation !== request.operation || value.callId !== String(exec.callId)) fail('BACKEND_INVALID_OUTPUT', 'Browser result operation/call binding does not match.');
        try { await this.confirmDelivery(record, value, exec, slot); }
        catch (error) {
          // Native HarnessError does not preserve details; retain the effect warning in its visible message too.
          throw new BrowserError(typeof error.code === 'string' ? error.code : 'BACKEND_ERROR', 'Artifact delivery confirmation failed after the browser operation: effects may already have completed. Inspect owned artifacts before repeating.', { effectState: 'unknown', retryable: false });
        }
        if (value.data.sessionId && ['session.open', 'session.replace', 'session.close', 'session.status'].includes(request.operation)) this.rememberSession(record, value.data);
        if (value.data.captureId && request.operation.startsWith('media.')) this.rememberCapture(record, { sessionId: request.sessionId, kind: request.operation.split('.')[1], data: { ...value.data } });
        if (slot.cancelled) { await this.discard(record); fail('CANCELLED', 'Owned browser action cancelled and worker range joined; previous session handles are invalid.'); }
        return { value, record };
      } catch (error) {
        // A client cancellation can reject before Playwright settles. The managed range must join,
        // and sessions are invalidated explicitly rather than leaving a hidden action in flight.
        if (exec.signal?.aborted || slot.cancelled || ['WORKER_DISCONNECTED', 'DEADLINE_EXCEEDED', 'BACKEND_INVALID_OUTPUT'].includes(error.code)) await this.discard(record);
        throw error;
      } finally {
        exec.signal?.removeEventListener('abort', cancel);
        if (stagedFiles) {
          try { await this.files.release(record, stagedFiles); }
          catch { record.stagingCleanupPending = true; }
        }
      }
    };
    const result = record.queue.then(work);
    record.queue = result.then(() => {}, () => {});
    return result;
  }

  trackCleanup(task) {
    const tracked = Promise.resolve(task).catch(error => { this.cleanupFailures.push(error); }).finally(() => this.cleanupTasks.delete(tracked));
    this.cleanupTasks.add(tracked);
  }

  async revokeSession(session) {
    const pending = [];
    for (const record of this.records) if (record.agent.session === session) {
      record.startController?.abort();
      pending.push(this.discard(record));
    }
    await Promise.all(pending);
  }

  async disposeAgent(agent) {
    this.disposedAgents.add(agent);
    const record = this.owners.get(agent);
    if (!record) return;
    record.disposed = true;
    record.lifetime.abort();
    record.startController?.abort();
    await this.discard(record);
    await record.queue;
    await this.discard(record);
    this.records.delete(record);
    this.owners.delete(agent);
  }

  async close() {
    this.stopping = true;
    const records = [...this.records];
    for (const record of records) { record.lifetime.abort(); record.startController?.abort(); }
    const outcomes = await Promise.allSettled(records.map(record => this.discard(record)));
    await Promise.all(records.map(record => record.queue));
    const final = await Promise.allSettled(records.map(record => this.discard(record)));
    await Promise.all(this.cleanupTasks);
    this.records.clear();
    if ([...outcomes, ...final].some(result => result.status === 'rejected') || this.cleanupFailures.length) fail('WORKER_TEARDOWN_INCOMPLETE', 'One or more owned browser ranges could not be joined.');
  }
}
