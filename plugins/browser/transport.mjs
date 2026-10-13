import { loadRuntime } from './deps.mjs';
import { BrowserError, fail } from './errors.mjs';

export function policyKey(policy) {
  return JSON.stringify({ mode: policy.mode, workspaceRoot: policy.workspaceRoot });
}

/** Stream plumbing only. SDK public codecs/Protocol own MCP framing, requests and cancellation. */
export class NativeManagedTransport {
  constructor({ ctx, session, workerPath, cwd, env, expectedPolicy, signal, cleanupMs = 15000 }) {
    Object.assign(this, { ctx, session, workerPath, cwd, env, expectedPolicy, signal, cleanupMs });
    this.closed = false;
    this.maxFrameBytes = 512 * 1024;
  }

  assertOpen() {
    this.signal?.throwIfAborted();
    if (this.closed || this.closing) fail('WORKER_DISCONNECTED', 'Browser transport is closing; no late worker may be launched.');
  }

  async start() {
    this.assertOpen();
    if (this.started) fail('INVALID_STATE', 'Worker transport is already started.');
    this.started = true;
    this.signal?.throwIfAborted();
    const policyService = this.ctx.get('sandboxPolicy');
    const subprocess = this.ctx.get('subprocess');
    if (!policyService || !subprocess) fail('BACKEND_UNAVAILABLE', 'Native sandbox policy and managed subprocess services are required.');
    const policy = policyService.resolve({ session: this.session });
    if (policy.mode === 'read-only') fail('POLICY_DENIED', 'Read-only browser calls are metadata-only; no worker is launched.');
    if (policyKey(policy) !== policyKey(this.expectedPolicy)) fail('POLICY_CHANGED', 'Sandbox policy changed during browser startup.');
    this.policy = policy;
    const { ReadBuffer, serializeMessage } = await loadRuntime('@modelcontextprotocol/client');
    this.buffer = new ReadBuffer({ maxBufferSize: this.maxFrameBytes });
    this.serialize = serializeMessage;
    this.assertOpen();
    const executable = await subprocess.resolveExecutable('node', this.env, this.signal);
    this.assertOpen();
    let argv = [executable, this.workerPath];
    if (policy.mode !== 'danger-full-access') {
      const sandbox = this.ctx.get('sandbox');
      if (!sandbox) fail('POLICY_DENIED', 'Native worker confinement is unavailable.');
      const confined = await sandbox.confine(argv, policy, this.signal);
      if (confined.enforcement !== 'full') fail('POLICY_DENIED', 'Full browser worker confinement is required.');
      argv = confined.argv;
    }
    this.assertOpen();
    if (policyKey(policyService.resolve({ session: this.session })) !== policyKey(policy)) fail('POLICY_CHANGED', 'Sandbox policy changed before browser worker launch.');
    this.handle = subprocess.spawn({ argv, cwd: this.cwd, env: this.env, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8192 } }, graceMs: this.cleanupMs, signal: this.signal });
    if (!this.handle.stdin || !this.handle.stdout) {
      await this.close();
      fail('BACKEND_UNAVAILABLE', 'Managed worker pipes are unavailable.');
    }
    this.handle.stdout.on('data', chunk => {
      try {
        this.buffer.append(chunk);
        let message;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(new BrowserError('BACKEND_INVALID_OUTPUT', 'Invalid or oversized worker protocol frame.'));
        void this.close().catch(cause => this.onerror?.(cause));
      }
    });
    this.handle.stdout.on('error', () => {
      this.onerror?.(new BrowserError('WORKER_DISCONNECTED', 'Browser worker output closed unexpectedly.'));
      void this.close().catch(error => this.onerror?.(error));
    });
    this.handle.stdin.on('error', () => this.onerror?.(new BrowserError('WORKER_DISCONNECTED', 'Browser worker input is unavailable.')));
    this.handle.done.then(outcome => {
      this.outcome = outcome;
      void this.close().catch(error => this.onerror?.(error));
    }, () => {
      this.onerror?.(new BrowserError('WORKER_DISCONNECTED', 'Browser worker could not run.'));
      void this.close().catch(error => this.onerror?.(error));
    });
  }

  send(message) {
    if (this.closed || !this.handle?.stdin) return Promise.reject(new BrowserError('WORKER_DISCONNECTED', 'Browser worker is not connected.'));
    const bytes = this.serialize(message);
    if (Buffer.byteLength(bytes) > this.maxFrameBytes) return Promise.reject(new BrowserError('LIMIT_EXCEEDED', 'Browser protocol request exceeds its byte budget.'));
    return new Promise((resolve, reject) => this.handle.stdin.write(bytes, error => error ? reject(new BrowserError('WORKER_DISCONNECTED', 'Browser worker input failed.')) : resolve()));
  }

  notifyClosed() {
    if (this.closed) return;
    this.closed = true;
    this.buffer?.clear();
    this.onclose?.();
  }

  close() {
    // Mark synchronously: start may be suspended in dependency/executable/confinement IO.
    this.closing = true;
    return this.closePromise ??= (async () => {
      if (!this.handle) { this.cleanup = { graceful: true, ownedRangeEmpty: true }; this.notifyClosed(); return; }
      this.handle.stdin?.end();
      const graceful = await this.handle.waitForExit(AbortSignal.timeout(1000));
      if (!graceful) this.handle.terminate();
      const empty = graceful || await this.handle.waitForExit(AbortSignal.timeout(this.cleanupMs + 1000));
      this.cleanup = { graceful, ownedRangeEmpty: empty };
      if (!empty) fail('WORKER_TEARDOWN_INCOMPLETE', 'Owned browser process range did not quiesce; no successful completion can be reported.');
      this.outcome = await this.handle.done;
      this.notifyClosed();
    })();
  }
}
