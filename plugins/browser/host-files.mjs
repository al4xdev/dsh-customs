import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserError, fail } from './errors.mjs';
import { policyKey } from './transport.mjs';

const helperHostPath = fileURLToPath(new URL('./host-files-helper.mjs', import.meta.url));
const artifactPattern = /^ba_[a-f0-9-]{36}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function scrubbedEnvironment(extra = {}) {
  const safe = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SYSTEMROOT', 'WINDIR']) if (typeof process.env[key] === 'string') safe[key] = process.env[key];
  // No inherited OAuth/cloud keys, NODE_OPTIONS, NODE_PATH, proxy credentials or arbitrary model env.
  return { ...safe, ...extra };
}

export class HostFiles {
  constructor(ctx) { this.ctx = ctx; }

  policy(agent) {
    const service = this.ctx.get('sandboxPolicy');
    if (!service || !agent?.session) fail('POLICY_DENIED', 'An actual Agent session and native sandbox policy are required.');
    const policy = service.resolve({ session: agent.session });
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode) || !isAbsolute(policy.workspaceRoot)) fail('POLICY_DENIED', 'Browser received an unsupported native execution policy.');
    return policy;
  }

  fs() {
    const fs = this.ctx.get('fs');
    if (!fs) fail('BACKEND_UNAVAILABLE', 'A native filesystem provider is required for browser artifacts.');
    return fs;
  }

  async helper(record, operation, payload, signal) {
    signal?.throwIfAborted();
    const policy = this.policy(record.agent);
    if (policy.mode === 'read-only') fail('POLICY_DENIED', 'Read-only browser calls cannot write or launch filesystem helpers.');
    const subprocess = this.ctx.get('subprocess');
    if (!subprocess) fail('BACKEND_UNAVAILABLE', 'Native managed subprocess service is required.');
    const helperPath = this.fs().processPathFromHostPath(helperHostPath);
    if (!helperPath) fail('UNSUPPORTED_EXECUTION_WORLD', 'Browser helper code is not shared with the native filesystem/process world.');
    const env = scrubbedEnvironment();
    const executable = await subprocess.resolveExecutable('node', env, signal);
    let argv = [executable, helperPath, operation];
    if (policy.mode !== 'danger-full-access') {
      const sandbox = this.ctx.get('sandbox');
      if (!sandbox) fail('POLICY_DENIED', 'Native filesystem helper confinement is unavailable.');
      const confined = await sandbox.confine(argv, policy, signal);
      if (confined.enforcement !== 'full') fail('POLICY_DENIED', 'Full filesystem helper confinement is required.');
      argv = confined.argv;
    }
    if (policyKey(this.policy(record.agent)) !== policyKey(policy)) fail('POLICY_CHANGED', 'Sandbox policy changed before filesystem publication.');
    const input = JSON.stringify({ ...payload, root: record.artifactRoot, ownerId: record.ownerId });
    if (Buffer.byteLength(input) > 128 * 1024) fail('LIMIT_EXCEEDED', 'Filesystem helper request exceeds its byte budget.');
    const handle = subprocess.spawn({ argv, cwd: policy.workspaceRoot, env, signal, graceMs: 1000, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8192 } } });
    const chunks = [];
    let bytes = 0;
    let streamError;
    handle.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) { streamError = new BrowserError('BACKEND_INVALID_OUTPUT', 'Filesystem helper output exceeds its byte budget.'); handle.terminate(); }
      else chunks.push(chunk);
    });
    handle.stdout.on('error', () => { streamError = new BrowserError('WORKER_DISCONNECTED', 'Filesystem helper output failed.'); handle.terminate(); });
    handle.stdin.on('error', () => { streamError ??= new BrowserError('WORKER_DISCONNECTED', 'Filesystem helper input failed.'); });
    try {
      handle.stdin.end(input);
      const outcome = await handle.done;
      if (!await handle.waitForExit(AbortSignal.timeout(3000))) { handle.terminate(); if (!await handle.waitForExit(AbortSignal.timeout(3000))) fail('WORKER_TEARDOWN_INCOMPLETE', 'Filesystem helper range did not quiesce.'); }
      if (streamError) throw streamError;
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail('BACKEND_INVALID_OUTPUT', 'Filesystem helper did not return a valid bounded result.'); }
      if (!value.ok) throw new BrowserError(value.error?.code ?? 'IO_ERROR', value.error?.message ?? 'Filesystem helper failed.');
      signal?.throwIfAborted();
      return value.data;
    } finally {
      if (!await handle.waitForExit(AbortSignal.timeout(100))) {
        handle.terminate();
        if (!await handle.waitForExit(AbortSignal.timeout(3000))) fail('WORKER_TEARDOWN_INCOMPLETE', 'Filesystem helper range did not quiesce.');
      }
    }
  }

  async bootstrap(record, signal) {
    const policy = this.policy(record.agent);
    record.artifactRoot = policy.mode === 'workspace-write'
      ? join(policy.workspaceRoot, '.dumps', 'browser-runtime', record.ownerId)
      : join(homedir(), '.cache', 'dsh-browser', 'runtime', record.ownerId);
    const result = await this.helper(record, 'bootstrap', {}, signal);
    record.artifactRoot = result.root;
    record.artifactRoots ??= new Set();
    record.artifactRoots.add(result.root);
    const expired = await this.helper(record, 'expire', { workerActive: false, retentionMs: record.config.rawRetentionMs }, signal);
    record.stagingBytes = Math.max(0, (record.stagingBytes ?? 0) - expired.releasedBytes);
    return result.root;
  }

  async release(record, files) {
    if (!files?.length) return;
    const result = await this.helper(record, 'release', { files }, AbortSignal.timeout(5000));
    record.stagingBytes = Math.max(0, (record.stagingBytes ?? 0) - result.releasedBytes);
  }

  async namespace(record, path, signal) {
    const fs = this.fs();
    if (typeof path !== 'string' || !isAbsolute(path) || basename(path) !== record.ownerId) fail('ARTIFACT_PATH_DENIED', 'Managed namespace identity is invalid.');
    for (let current = path;; current = dirname(current)) {
      const entry = await fs.lstat(current, undefined, signal);
      if (!entry || entry.type !== 'directory') fail('ARTIFACT_PATH_DENIED', 'Managed namespace has a missing, non-directory or symlink ancestor.');
      if (dirname(current) === current) break;
    }
    const root = await fs.resolve(path, { signal });
    if (fs.processPath(root) !== path) fail('ARTIFACT_PATH_DENIED', 'Managed namespace canonical identity changed.');
    const markerPath = join(path, '.owner.json');
    const markerInfo = await fs.lstat(markerPath, undefined, signal);
    if (!markerInfo || markerInfo.type !== 'file') fail('ARTIFACT_PATH_DENIED', 'Managed owner marker is missing or a symlink.');
    const markerTarget = await fs.resolve(markerPath, { signal });
    let marker;
    try { marker = JSON.parse(Buffer.from(await fs.readBytes(markerTarget, signal, 4096)).toString('utf8')); }
    catch { fail('ARTIFACT_PATH_DENIED', 'Managed owner marker is invalid.'); }
    if (marker.ownerId !== record.ownerId) fail('ARTIFACT_PATH_DENIED', 'Managed namespace belongs to another Agent.');
    return root;
  }

  roots(record) {
    return [...(record.artifactRoots ?? new Set(record.artifactRoot ? [record.artifactRoot] : []))];
  }

  async ownedTarget(record, path, signal) {
    if (!record.artifactRoot || typeof path !== 'string' || !isAbsolute(path)) fail('ARTIFACT_PATH_DENIED', 'Artifact does not have an owned concrete path.');
    const fs = this.fs();
    const roots = await Promise.all(this.roots(record).map(root => this.namespace(record, root, signal)));
    const entry = await fs.lstat(path, undefined, signal);
    if (!entry || entry.type !== 'file') fail('ARTIFACT_PATH_DENIED', 'Artifact must be a regular non-symlink file.');
    const target = await fs.resolve(path, { signal });
    if (!roots.some(root => fs.contains(root, target))) fail('ARTIFACT_PATH_DENIED', 'Artifact is outside the actual Agent namespace.');
    return target;
  }

  async readArtifact(record, artifact, signal, cap = record.config.limits.ownerBytes) {
    if (!artifactPattern.test(artifact.artifactId) || !['finalized', 'partial'].includes(artifact.state)) fail('ARTIFACT_NOT_FINALIZED', 'Only existing owned finalized/partial artifacts can be read.');
    const target = await this.ownedTarget(record, artifact.path, signal);
    const bytes = await this.fs().readBytes(target, signal, Math.min(cap, record.config.limits.ownerBytes));
    await this.ownedTarget(record, artifact.path, signal);
    if (bytes.byteLength !== artifact.bytes || (artifact.sha256 && digest(bytes) !== artifact.sha256)) fail('ARTIFACT_CHANGED', 'Owned artifact content no longer matches its recorded metadata.');
    return bytes;
  }

  async listArtifacts(record, signal) {
    if (!record.artifactRoot) return [];
    const fs = this.fs();
    const records = [];
    for (const path of this.roots(record)) {
      const root = await this.namespace(record, path, signal);
      const entries = await fs.listDir(root, signal);
      const sidecars = entries.filter(item => item.type === 'file' && /^ba_[a-f0-9-]{36}\.json$/.test(item.name));
      if (sidecars.length + records.length > 1000) fail('LIMIT_EXCEEDED', 'Owner artifact metadata exceeds its count budget.');
      for (const entry of sidecars) {
      const bytes = await fs.readBytes(entry.target, signal, 16384);
      let artifact;
      try { artifact = JSON.parse(Buffer.from(bytes).toString('utf8')); }
      catch { fail('BACKEND_INVALID_OUTPUT', 'Owned artifact sidecar is invalid.'); }
      if (artifact.artifactId !== entry.name.slice(0, -5) || !artifactPattern.test(artifact.artifactId)) fail('ARTIFACT_PATH_DENIED', 'Artifact sidecar identity is invalid.');
      if (artifact.path) {
        const target = await fs.resolve(artifact.path, { signal });
        if (!fs.contains(root, target)) fail('ARTIFACT_PATH_DENIED', 'Artifact sidecar points outside its owner namespace.');
      }
      records.push(artifact);
      }
      await this.namespace(record, path, signal);
    }
    return records;
  }

  async findArtifact(record, artifactId, signal) {
    if (!artifactPattern.test(artifactId)) fail('ARTIFACT_NOT_FOUND', 'Owned artifact was not found.');
    const artifact = (await this.listArtifacts(record, signal)).find(item => item.artifactId === artifactId);
    if (!artifact) fail('ARTIFACT_NOT_FOUND', 'Owned artifact was not found.');
    return artifact;
  }

  async export(record, request, exec, grant) {
    const artifact = await this.findArtifact(record, request.args.artifactId, exec.signal);
    if (artifact.state !== 'finalized' || !artifact.sha256) fail('ARTIFACT_NOT_FINALIZED', 'Only a finalized checked artifact can be exported.');
    const source = await this.ownedTarget(record, artifact.path, exec.signal);
    const fs = this.fs();
    const policy = this.policy(record.agent);
    const destination = resolve(policy.workspaceRoot, request.args.destination);
    const target = await fs.resolve(destination, { signal: exec.signal });
    if (!grant || grant.artifactId !== request.args.artifactId || grant.mode !== policy.mode || grant.workspaceRoot !== policy.workspaceRoot || grant.destination !== fs.processPath(target)) fail('POLICY_CHANGED', 'Export destination or authority changed after native approval; refresh and authorize a new call.');
    if (await fs.lstat(destination, undefined, exec.signal)) fail('DESTINATION_EXISTS', 'Browser export never overwrites an existing destination.');
    const parent = await fs.resolve(dirname(destination), { signal: exec.signal });
    const workspace = await fs.resolve(policy.workspaceRoot, { signal: exec.signal });
    if (policy.mode !== 'danger-full-access' && !fs.contains(workspace, parent)) fail('POLICY_DENIED', 'Export destination is outside the native writable workspace.');
    this.ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
    let sourceRoot;
    for (const path of this.roots(record)) if (fs.contains(await this.namespace(record, path, exec.signal), source)) { sourceRoot = path; break; }
    const result = await this.helper(record, 'export', { sourceRoot, source: fs.processPath(source), destination: grant.destination, writableRoots: policy.mode === 'danger-full-access' ? [dirname(grant.destination)] : [grant.workspaceRoot], maxBytes: artifact.bytes, sha256: artifact.sha256 }, exec.signal);
    const after = await fs.stat(target, exec.signal);
    if (after) this.ctx.emit('fs/observed', target, { kind: 'present', version: after.version }, exec);
    return { ...result, artifact };
  }

  async stage(record, paths, exec) {
    const fs = this.fs();
    const policy = this.policy(record.agent);
    const sources = [];
    let total = 0;
    for (const path of paths) {
      const target = await fs.resolve(path, { cwd: policy.workspaceRoot, signal: exec.signal });
      const before = await fs.stat(target, exec.signal);
      if (!before || before.type !== 'file') fail('ARTIFACT_PATH_DENIED', 'Upload source must be a regular native filesystem file.');
      const bytes = await fs.readBytes(target, exec.signal, 20 * 1024 * 1024);
      total += bytes.byteLength;
      if (total > 32 * 1024 * 1024) fail('LIMIT_EXCEEDED', 'Upload staging exceeds its total byte budget.');
      const after = await fs.stat(target, exec.signal);
      if (!after || after.version !== before.version) fail('ARTIFACT_CHANGED', 'Upload source changed while it was being observed.');
      this.ctx.emit('fs/observed', target, { kind: 'present', version: after.version }, exec);
      sources.push({ path: fs.processPath(target), bytes: bytes.byteLength, sha256: digest(bytes), name: basename(path) });
    }
    const retained = (await this.listArtifacts(record, exec.signal)).reduce((sum, item) => sum + item.bytes, 0);
    if (retained + (record.stagingBytes ?? 0) + total > record.config.limits.ownerBytes) fail('LIMIT_EXCEEDED', 'Upload exceeds the owner managed-file budget.');
    // Conservative reservation survives partial staging failures, so retries cannot exhaust disk unnoticed.
    record.stagingBytes = (record.stagingBytes ?? 0) + total;
    return (await this.helper(record, 'stage', { sources }, exec.signal)).files;
  }
}
