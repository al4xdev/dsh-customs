import { Console } from 'node:console';
import { isAbsolute, relative, sep } from 'node:path';
import { loadRuntime } from '../deps.mjs';
import { BrowserError, fail, safeError } from '../errors.mjs';
import { INTERNAL_SCHEMA } from '../protocol.mjs';

// Install the protocol-safe console before importing engine code. Only the official SDK writes stdout.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
const raw = process.env.DSH_BROWSER_BOOT;
if (!raw || Buffer.byteLength(raw) > 65536) throw new BrowserError('INVALID_STATE', 'Private browser boot configuration is missing or too large.');
const boot = JSON.parse(raw);
if (!/^bo_[a-f0-9-]{36}$/.test(boot.ownerId) || !isAbsolute(boot.artifactRoot) || typeof boot.catalogRevision !== 'string') throw new BrowserError('INVALID_STATE', 'Private browser owner configuration is invalid.');
const [{ McpServer }, { serveStdio }, { AjvJsonSchemaValidator }, { BrowserRuntime }] = await Promise.all([
  loadRuntime('@modelcontextprotocol/server'), loadRuntime('@modelcontextprotocol/server/stdio'), loadRuntime('@modelcontextprotocol/server/validators/ajv'), import('./runtime.mjs'),
]);
const validate = new AjvJsonSchemaValidator().getValidator(INTERNAL_SCHEMA);
const inputSchema = { '~standard': {
  version: 1, vendor: 'dsh-browser', jsonSchema: { input: () => INTERNAL_SCHEMA, output: () => INTERNAL_SCHEMA },
  validate(value) { const result = validate(value); return result.valid ? { value: result.data } : { issues: [{ message: result.errorMessage }] }; },
} };
const runtime = new BrowserRuntime(boot);
let tail = Promise.resolve();
let stopping = false;
let stopPromise;
const ownedPath = path => {
  if (typeof path !== 'string' || !isAbsolute(path)) return false;
  const part = relative(boot.artifactRoot, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const success = data => ({ content: [{ type: 'text', text: 'Private browser request completed.' }], structuredContent: data });
const failure = error => ({ isError: true, content: [{ type: 'text', text: 'Private browser request failed.' }], structuredContent: { error: safeError(error) } });

const entry = serveStdio(() => {
  const server = new McpServer({ name: 'dsh-browser-private', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'Private owned Page-bound backend. Never expose this transport as independent model tools.' });
  server.registerTool('browser', { description: 'Private single-root browser worker', inputSchema }, async ({ request, authority }, context) => {
    if (authority.ownerId !== boot.ownerId || authority.manifestHash !== boot.catalogRevision) return failure(new BrowserError('OWNER_MISMATCH', 'Private browser authority does not match this channel.'));
    const remaining = authority.deadlineMs - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > runtime.config.limits.rootMs) return failure(new BrowserError('DEADLINE_EXCEEDED', 'Private browser request deadline is invalid or expired.'));
    const signal = AbortSignal.any([context.mcpReq.signal, AbortSignal.timeout(Math.ceil(remaining))]);
    const execute = async () => {
      try {
        signal.throwIfAborted();
        if (request.operation === '__handshake') return success({ ownerMatched: true, manifestHash: boot.catalogRevision, apiVersion: '1', backend: 'playwright-1.64.0-page-bound', workerPid: process.pid });
        if (request.operation === '__shutdown') { stopping = true; await runtime.close(); return success({ closed: true }); }
        if (stopping) fail('WORKER_DISCONNECTED', 'Private browser worker is stopping.');
        const call = { callId: authority.callId, signal, deadlineMs: authority.deadlineMs };
        if (request.operation === '__delivered') return success(await runtime.confirmDelivery(request.args, call));
        if (request.operation === '__upload') {
          const { publicRequest, files } = request.args;
          if (publicRequest?.operation !== 'files.upload' || !Array.isArray(files) || files.length < 1 || files.length > 16 || files.some(file => !ownedPath(file.path))) fail('ARTIFACT_PATH_DENIED', 'Upload requires trusted staging inside the owned namespace.');
          return success(await runtime.upload(publicRequest, files, call));
        }
        if (request.operation.startsWith('__')) fail('UNKNOWN_OPERATION', 'Internal browser operation is not allowlisted.');
        return success(await runtime.execute(request, call));
      } catch (error) { return failure(error); }
    };
    // Every effectful request resolves its concrete Page under one owner queue. Dialog actions can
    // transfer pending work explicitly to the session manager, rather than abandoning a race promise.
    const pending = tail.then(execute);
    tail = pending.then(() => {}, () => {});
    return pending;
  });
  return server;
});

function stop() {
  if (stopPromise) return stopPromise;
  stopping = true;
  return stopPromise = (async () => {
    try { await runtime.close(); await tail; }
    finally { await entry.close(); process.exit(0); }
  })();
}
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
process.stdin.once('end', () => void stop());
