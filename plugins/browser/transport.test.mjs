import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeManagedTransport } from './transport.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}
function fixture(mode = 'danger-full-access') {
  const policy = { mode, workspaceRoot: process.cwd() };
  const services = { sandboxPolicy: { resolve: () => policy } };
  let launches = 0;
  services.subprocess = { resolveExecutable: async () => process.execPath, spawn() { launches++; throw new Error('Late spawn must not be reached'); } };
  const ctx = { get: name => services[name] };
  const transport = new NativeManagedTransport({ ctx, session: {}, workerPath: '/unused/worker.mjs', cwd: process.cwd(), env: {}, expectedPolicy: policy });
  return { services, transport, launches: () => launches };
}

test('closing while executable lookup is suspended prevents a late spawn', async () => {
  const f = fixture();
  const entered = deferred(), blocked = deferred();
  f.services.subprocess.resolveExecutable = async () => { entered.resolve(); return blocked.promise; };
  const start = f.transport.start();
  await entered.promise;
  await f.transport.close();
  blocked.resolve(process.execPath);
  await assert.rejects(start, { code: 'WORKER_DISCONNECTED' });
  assert.equal(f.launches(), 0);
  assert.equal(f.transport.cleanup.ownedRangeEmpty, true);
});

test('closing while native confinement is suspended prevents a late spawn', async () => {
  const f = fixture('workspace-write');
  const entered = deferred(), blocked = deferred();
  f.services.sandbox = { async confine(argv) { entered.resolve(); await blocked.promise; return { argv, enforcement: 'full' }; } };
  const start = f.transport.start();
  await entered.promise;
  await f.transport.close();
  blocked.resolve();
  await assert.rejects(start, { code: 'WORKER_DISCONNECTED' });
  assert.equal(f.launches(), 0);
});

test('closed or read-only transports cannot resolve/spawn a worker', async () => {
  const f = fixture(); await f.transport.close();
  await assert.rejects(f.transport.start(), { code: 'WORKER_DISCONNECTED' });
  const readonly = fixture('read-only');
  let lookups = 0; readonly.services.subprocess.resolveExecutable = async () => { lookups++; return process.execPath; };
  await assert.rejects(readonly.transport.start(), { code: 'POLICY_DENIED' });
  assert.equal(lookups, 0); assert.equal(readonly.launches(), 0);
});
