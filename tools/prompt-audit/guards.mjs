// Process-wide fences for the offline capture child (capture.mjs). Installed before
// any SDK module loads, so every plugin of the booted profile runs behind them:
// - network: outbound TCP/TLS connects, fetch, WebSocket and EventSource fail;
//   TCP listeners are rebound to an ephemeral 127.0.0.1 port (Companion's fixed
//   3081 may be taken on the lab, and nothing must be reachable from outside);
// - writes: any fs mutation that resolves (through symlinks) into a protected root
//   (the real DSH_HOME, ~/.dsh-tui) throws EROFS and is recorded;
// - every write outside the temporary root and every spawned command is recorded
//   for the report without being blocked (plugins legitimately probe `git`, caches).
// Unix sockets stay allowed unless they live in a protected root.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const toPath = value => {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return undefined; // file descriptors and FileHandles were checked when opened
};

/** Resolve symlinks of the deepest existing ancestor, keeping the missing tail. */
export function canonicalTarget(path) {
  let current = resolve(path);
  const tail = [];
  for (;;) {
    try { return join(fs.realpathSync.native(current), ...[...tail].reverse()); }
    catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Operations on the link itself (unlink, rename, symlink…) must not follow it. */
const canonicalEntry = path => join(canonicalTarget(dirname(resolve(path))), basename(resolve(path)));

export const isUnder = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

const writeOpen = flags => typeof flags === 'number'
  ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
  : typeof flags === 'string' && /[wax+]/.test(flags);

// [method, mutated path argument indexes, follows symlinks]
const MUTATORS = [
  ['writeFile', [0], true], ['appendFile', [0], true], ['mkdir', [0], true], ['mkdtemp', [0], true],
  ['truncate', [0], true], ['chmod', [0], true], ['chown', [0], true], ['utimes', [0], true],
  ['copyFile', [1], true], ['cp', [1], true],
  ['rename', [0, 1], false], ['rm', [0], false], ['rmdir', [0], false], ['unlink', [0], false],
  ['symlink', [1], false], ['link', [0, 1], false], ['lchown', [0], false], ['lutimes', [0], false],
];

export function installGuards({ protectedRoots, tempRoot }) {
  const roots = protectedRoots.filter(Boolean).map(canonicalTarget);
  const temp = canonicalTarget(tempRoot);
  const report = { deniedWrites: [], outsideWrites: [], blockedNetwork: [], rebound: [], spawned: [] };
  const note = (list, value) => { if (!list.includes(value)) list.push(value); };
  const check = (method, path, follow = true) => {
    const raw = toPath(path);
    if (raw === undefined) return;
    const target = follow ? canonicalTarget(raw) : canonicalEntry(raw);
    if (roots.some(root => isUnder(target, root))) {
      note(report.deniedWrites, `${method} ${target}`);
      const error = new Error(`prompt-audit: write into a protected root refused (${method} ${target})`);
      error.code = 'EROFS';
      throw error;
    }
    if (!isUnder(target, temp)) note(report.outsideWrites, `${method} ${target}`);
  };
  // A refusal follows each API's own error convention: thrown (sync), rejected
  // (promises) or passed to the callback, so callers' error handling still applies.
  const refuseIn = (style, args, error) => {
    if (style === 'promise') return Promise.reject(error);
    const callback = args.findLast?.(arg => typeof arg === 'function');
    if (style === 'callback' && callback) { process.nextTick(callback, error); return undefined; }
    throw error;
  };
  const wrap = (holder, method, style, guard, label = method) => {
    const original = holder[method];
    if (typeof original !== 'function') return;
    holder[method] = function guarded(...args) {
      try { guard(label, args); } catch (error) { return refuseIn(style, args, error); }
      return original.apply(this, args);
    };
  };
  for (const [method, indexes, follow] of MUTATORS) {
    const guard = (label, args) => { for (const index of indexes) check(label, args[index], follow); };
    wrap(fs, method, 'callback', guard);
    wrap(fs, `${method}Sync`, 'sync', guard, method);
    wrap(fs.promises, method, 'promise', guard);
  }
  const openGuard = (label, args) => { if (writeOpen(args[1])) check(label, args[0]); };
  // readFile(path, { flag: 'w' }) truncates; treat it as the open it is.
  const readGuard = (label, args) => { if (writeOpen(typeof args[1] === 'object' ? args[1]?.flag : undefined)) check(label, args[0]); };
  wrap(fs, 'readFile', 'callback', readGuard);
  wrap(fs, 'readFileSync', 'sync', readGuard, 'readFile');
  wrap(fs.promises, 'readFile', 'promise', readGuard);
  wrap(fs, 'open', 'callback', openGuard);
  wrap(fs, 'openSync', 'sync', openGuard, 'open');
  wrap(fs.promises, 'open', 'promise', openGuard);
  const originalStream = fs.createWriteStream;
  fs.createWriteStream = function guardedStream(path, options) {
    check('createWriteStream', path);
    return originalStream.call(this, path, options);
  };

  const refuse = what => {
    note(report.blockedNetwork, what);
    const error = new Error(`prompt-audit: network access refused (${what})`);
    error.code = 'ENETUNREACH';
    return error;
  };
  const unixPath = first => (typeof first === 'string' && !/^\d+$/.test(first) ? first
    : typeof first === 'object' && first !== null && typeof first.path === 'string' ? first.path : undefined);
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (unixPath(first) === undefined) {
      const where = typeof first === 'object' && first !== null ? `${first.host ?? 'localhost'}:${first.port}` : `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${first}`;
      const error = refuse(`tcp ${where}`);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return originalConnect.apply(this, args);
  };
  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function guardedListen(...args) {
    const socket = unixPath(args[0]);
    if (socket !== undefined) {
      check('listen', socket);
      return originalListen.apply(this, args);
    }
    if (typeof args[0] === 'object' && args[0] !== null && !('port' in args[0])) return originalListen.apply(this, args); // handles/fds
    const callback = args.find(arg => typeof arg === 'function');
    const requested = typeof args[0] === 'object' && args[0] !== null ? `${args[0].host ?? '*'}:${args[0].port}` : `${typeof args[1] === 'string' ? args[1] : '*'}:${args[0]}`;
    note(report.rebound, requested);
    const options = typeof args[0] === 'object' && args[0] !== null ? { ...args[0] } : {};
    return originalListen.call(this, { ...options, port: 0, host: '127.0.0.1' }, ...(callback ? [callback] : []));
  };
  globalThis.fetch = async input => { throw refuse(`fetch ${typeof input === 'string' ? input : input?.url ?? String(input)}`); };
  globalThis.WebSocket = class { constructor(url) { throw refuse(`websocket ${url}`); } };
  globalThis.EventSource = class { constructor(url) { throw refuse(`eventsource ${url}`); } };

  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = childProcess[method];
    childProcess[method] = function recorded(command, ...rest) {
      note(report.spawned, basename(String(command).trim().split(/\s+/)[0]));
      return original.call(this, command, ...rest);
    };
  }
  // ESM `import { writeFile } from 'node:fs'` bindings follow the patched objects.
  syncBuiltinESMExports();
  return report;
}
