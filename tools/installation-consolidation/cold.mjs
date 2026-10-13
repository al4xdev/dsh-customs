import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_LAYOUT = Object.freeze({
  home: '/home/alex', cli: '/home/alex/.local/share/dsh-cli',
  profiles: '/home/alex/.dsh/profiles',
  npx: '/home/alex/.npm/_npx/1e7f6d9597241db0',
  scratch: '/home/alex/git/my/dsh-customs/.dumps/pi-ai-fork/runtime-cc0c4b95b7145f89',
  backup: '/home/alex/.local/share/dsh-customs-backups', proc: '/proc',
});
export const PI_VERSION = '0.87.1+alex.codex-default.206545bfd51e';
export const DEFAULT_PROOFS = Object.freeze({
  'node_modules/@deepseek-ai/dsh-session/lib/index.js': '9b3e27e2bba492552951224b6fb225a7dfcf5ba62eac6de9e67a244e50bd706e',
  'node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js': '559b39d570606a6eeae00b7ec4ca64b8f51e26900c0542b894c9a7a3a0b1abf1',
  'node_modules/@earendil-works/pi-ai/dist/index.js': 'b0a54eba6d628946201e3d3b8936eaa2f8af6949e2b7698be3603df3363110ce',
  'node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js': '069dabe67146de68cde853bf7777eadf652daafa5ab938cc72a6a2fc05c74e23',
  'node_modules/@earendil-works/pi-ai/dist/utils/provider-failure.js': '4febec9c6e68a9ce533376a60d19a6c67b23ee9c95b6c1187161dd04216baf93',
});
const ADAPTER = '@deepseek-ai/dsh-llm-pi-ai';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, p) => p === root || p.startsWith(root + path.sep);
const stat = p => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const real = p => { try { return fs.realpathSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const fail = message => { throw new Error(message); };
function directory(p) { if (!stat(p)?.isDirectory() || real(p) !== p) fail('Directory confinement failed: ' + p); }
function packagePaths(root) {
  directory(root);
  const entries = [];
  for (const name of fs.readdirSync(root).sort()) {
    if (name.startsWith('@') && stat(path.join(root, name))?.isDirectory()) {
      directory(path.join(root, name));
      for (const child of fs.readdirSync(path.join(root, name)).sort()) entries.push([`${name}/${child}`, path.join(root, name, child)]);
    } else entries.push([name, path.join(root, name)]);
  }
  return entries;
}
function metadata(p, name, root) {
  const physical = real(p);
  if (!physical) fail('Missing package target: ' + name);
  if (!root || !inside(root, physical)) fail('Package target escapes selected root: ' + name);
  const manifest = path.join(physical, 'package.json');
  if (!stat(manifest)?.isFile()) fail('Nonregular public package manifest: ' + name);
  const bytes = fs.readFileSync(manifest);
  const m = JSON.parse(bytes);
  if (m.name !== name || typeof m.version !== 'string') fail('Package identity mismatch: ' + name);
  return { name: m.name, version: m.version, hash: sha(bytes), real: physical };
}
// Only public package code is traversed, never a runtime/config root or a symlink.
function codeTree(root) {
  const out = [];
  function walk(p, relative) {
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink()) fail('Unexpected link inside adapter package');
    if (s.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) {
        if (name === 'node_modules') fail('Nested dependency tree in adapter');
        walk(path.join(p, name), relative ? relative + '/' + name : name);
      }
    } else if (s.isFile()) out.push([relative, sha(fs.readFileSync(p))]);
    else fail('Special package entry');
  }
  walk(root, '');
  return out;
}
function linkSnapshot(p) {
  const s = stat(p);
  if (!s?.isSymbolicLink()) fail('Not a symlink: ' + p);
  return { target: fs.readlinkSync(p), resolved: real(p), mode: s.mode & 0o777, dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, uid: s.uid, gid: s.gid };
}
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function assertLink(p, expected) { if (!equal(linkSnapshot(p), expected)) fail('Post-edit conflict: ' + p); }
function checkProofs(layout, proofs) {
  for (const [relative, expected] of Object.entries(proofs)) {
    const p = path.resolve(layout.cli, relative);
    if (!inside(layout.cli, p) || !inside(layout.cli, real(p) ?? '')) fail('Proof confinement failed');
    if (sha(fs.readFileSync(p)) !== expected) fail('Static code hash mismatch: ' + relative);
  }
}
export function processGate(layout, { afterStop = false, includeExcluded = false } = {}) {
  const blockers = [];
  const node = real(process.execPath);
  for (const pid of fs.readdirSync(layout.proc).filter(n => /^\d+$/.test(n))) {
    try {
      // Other users' processes are outside this user-service gate and may deny exe reads.
      if (fs.statSync(path.join(layout.proc, pid)).uid !== process.getuid()) continue;
      let executable;
      try { executable = fs.realpathSync(path.join(layout.proc, pid, 'exe')); }
      catch (e) {
        // Non-dumpable user managers deny exe access. Exempt only their exact kernel
        // service names AND user-manager init scope, never a readable/spoofed Node exe.
        if (e.code === 'EACCES' || e.code === 'EPERM') {
          try {
            const comm = fs.readFileSync(path.join(layout.proc, pid, 'comm'), 'utf8').trim();
            const cgroup = fs.readFileSync(path.join(layout.proc, pid, 'cgroup'), 'utf8').trim();
            const scope = `0::/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/init.scope`;
            if (['systemd', '(sd-pam)'].includes(comm) && cgroup === scope) continue;
          } catch { /* Unreadable or incomplete exemption evidence still fails closed. */ }
        }
        throw e;
      }
      if (executable !== node) continue;
      // Selector data stays local: neither complete argv, prompts nor environment are emitted.
      const args = fs.readFileSync(path.join(layout.proc, pid, 'cmdline')).toString().split('\0').filter(Boolean);
      const scriptIndex = args.findIndex((arg, i) => i > 0 && (
        arg.endsWith('/dsh/lib/bin.js') || arg.endsWith('/local-model-launch.mjs') ||
        ([layout.cli, layout.npx, layout.scratch].some(root => inside(root, arg)) && arg.endsWith('/.bin/dsh'))));
      const cli = scriptIndex > 0;
      // Parse only leading, known profile selectors. Unknown options stop parsing so
      // prompt values containing "web" or "--profile=companion" cannot grant exemptions.
      const profiles = [];
      let command = null;
      if (cli) for (let i = scriptIndex + 1; i < args.length; i++) {
        if (args[i] === '--profile' && args[i + 1] && !args[i + 1].startsWith('-')) profiles.push(args[++i]);
        else if (args[i].startsWith('--profile=')) profiles.push(args[i].slice('--profile='.length));
        else { command = args[i]; break; }
      }
      const profile = args.some((arg, i) => (arg === '--profile' && args[i + 1] === 'dsh-tui') || arg === '--profile=dsh-tui');
      if (!profile && cli && (profiles.includes('companion') || command === 'companion')) {
        // Explicitly excluded prototype: no availability promise and no stop/config action.
        if (includeExcluded) blockers.push({ pid: Number(pid), kind: 'active-prototype-consumer' });
        continue;
      }
      const tui = profile || (cli && command !== 'web' && command !== 'companion');
      if (tui) blockers.push({ pid: Number(pid), kind: 'TUI' });
      else if (cli && (command !== 'web' || afterStop)) blockers.push({ pid: Number(pid), kind: 'active-canonical-consumer' });
    } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') blockers.push({ pid: Number(pid), kind: 'unreadable-process-selector' }); }
  }
  return blockers;
}
export function preview(layout = DEFAULT_LAYOUT, options = {}) {
  const proofs = options.proofs ?? DEFAULT_PROOFS;
  const report = { mode: 'preview', blockers: [], entries: [], preserved: [], counts: { npx: 0, broken: 0, scratch: 0 }, rootN: 'still referenced; never quarantined by this tool', intendedDeltas: ['Pi ' + PI_VERSION + ' + observer38', 'SDK/session50; adapter bytes unchanged'] };
  const attempt = fn => { try { return fn(); } catch (e) { report.blockers.push(e.message); return null; } };
  attempt(() => { directory(layout.cli); directory(layout.npx); directory(layout.scratch); directory(layout.profiles); checkProofs(layout, proofs); });
  for (const [name, p] of attempt(() => packagePaths(path.join(layout.profiles, 'node_modules'))) ?? []) {
    if (!stat(p)?.isSymbolicLink()) { report.preserved.push({ path: p, kind: 'regular-path' }); continue; }
    attempt(() => collect(name, p, false));
  }
  const adapter = path.join(layout.profiles, 'dsh-tui/node_modules', ADAPTER);
  attempt(() => {
    directory(path.dirname(path.dirname(adapter))); directory(path.dirname(adapter));
    if (stat(adapter)?.isSymbolicLink()) collect(ADAPTER, adapter, true);
    else report.preserved.push({ path: adapter, kind: 'regular-path' });
  });
  function collect(name, p, scratch) {
    const before = linkSnapshot(p);
    // Linux symlink creation cannot preserve foreign ownership/nonstandard link modes.
    if (before.mode !== 0o777 || before.uid !== process.getuid() || before.gid !== process.getgid()) fail('Unsupported symlink attributes: ' + name);
    const old = path.resolve(path.dirname(p), before.target);
    const expectedOld = path.join(scratch ? layout.scratch : layout.npx, 'node_modules', name);
    const newTarget = path.join(layout.cli, 'node_modules', name);
    if (old === newTarget && before.resolved === real(newTarget)) { report.preserved.push({ path: p, kind: 'canonical-link' }); return; }
    if (old !== expectedOld) fail('Unapproved symlink target: ' + name);
    if (scratch) report.counts.scratch++; else if (before.resolved) report.counts.npx++; else report.counts.broken++;
    const entry = { name, path: p, before, newTarget, state: 'deferred' };
    report.entries.push(entry);
    const next = metadata(newTarget, name, layout.cli);
    if (!inside(layout.cli, next.real)) fail('Canonical target escapes selected root: ' + name);
    // Missing old public identity cannot be inferred from a link basename.
    const previous = metadata(p, name, scratch ? layout.scratch : layout.npx);
    if (!inside(scratch ? layout.scratch : layout.npx, previous.real)) fail('Old target escapes approved root: ' + name);
    const intendedPi = name === '@earendil-works/pi-ai' && next.version === PI_VERSION && ['0.87.1', '0.87.1+alex.codex-default.7f8948d3c423'].includes(previous.version);
    if (previous.version !== next.version && !intendedPi) fail('Version mismatch: ' + name + ' (' + previous.version + ' -> ' + next.version + ')');
    if (name === ADAPTER && !equal(codeTree(previous.real), codeTree(next.real))) fail('Adapter code bytes differ');
    entry.previous = previous; entry.next = next; entry.state = 'planned';
  }
  if (options.expectedCounts) for (const [key, count] of Object.entries(options.expectedCounts)) if (report.counts[key] !== count) report.blockers.push('Inventory count drift: ' + key);
  report.blockers.push(...(options.gate ?? processGate)(layout));
  report.complete = report.blockers.length === 0 && report.entries.every(e => e.state === 'planned');
  return report;
}
export function webControl(action) {
  if (!['is-active', 'stop', 'start'].includes(action)) fail('Unapproved service action');
  try { return execFileSync('/usr/bin/systemctl', ['--user', action, 'dsh-web.service'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { if (action === 'is-active' && e.status === 3) return 'inactive'; fail('Fixed web service operation failed: ' + action); }
}
function save(receipt, file) {
  const next = file + '.next';
  fs.writeFileSync(next, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(next, file);
}
function validateEntry(layout, e) {
  const shared = path.join(layout.profiles, 'node_modules', e.name);
  const adapter = path.join(layout.profiles, 'dsh-tui/node_modules', ADAPTER);
  if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(e.name) || (e.path !== shared && !(e.name === ADAPTER && e.path === adapter))) fail('Unapproved receipt path');
  directory(path.dirname(e.path));
  if (e.newTarget !== path.join(layout.cli, 'node_modules', e.name)) fail('Unapproved new target');
  const old = path.resolve(path.dirname(e.path), e.before.target);
  const oldRoot = e.path === adapter ? layout.scratch : layout.npx;
  if (old !== path.join(oldRoot, 'node_modules', e.name)) fail('Unapproved old target');
  if (!e.next || !e.previous || !inside(layout.cli, e.next.real) || !inside(oldRoot, e.previous.real) || e.before.resolved !== e.previous.real) fail('Unapproved receipt referent');
  if (e.after && (e.after.target !== e.newTarget || e.after.resolved !== e.next.real)) fail('Unapproved after-link record');
}
function recheckTargets(e) {
  if (!equal(metadata(e.newTarget, e.name, e.next.real), e.next)) fail('Canonical metadata changed: ' + e.name);
  const old = path.resolve(path.dirname(e.path), e.before.target);
  if (!equal(metadata(old, e.name, e.previous.real), e.previous)) fail('Old metadata changed: ' + e.name);
}
function replace(e, expected, target) {
  recheckTargets(e);
  assertLink(e.path, expected);
  const temp = path.join(path.dirname(e.path), '.cold-' + crypto.randomUUID());
  fs.symlinkSync(target, temp);
  try {
    assertLink(e.path, expected);
    if (fs.readlinkSync(temp) !== target || real(temp) !== real(path.resolve(path.dirname(e.path), target))) fail('New symlink verification failed');
    fs.renameSync(temp, e.path);
  } finally { if (stat(temp)) fs.unlinkSync(temp); }
  return linkSnapshot(e.path);
}
function requireGate(layout, gate, afterStop = false) { if (gate(layout, { afterStop }).length) fail('Cold gate rejected: active TUI/consumer or unreadable selector'); }
export function apply(layout = DEFAULT_LAYOUT, options = {}) {
  const gate = options.gate ?? processGate;
  const service = options.service ?? webControl;
  requireGate(layout, gate); // Before mkdir, receipt, or even a systemctl query.
  const report = preview(layout, { ...options, gate });
  if (!report.complete) fail('Incomplete mapping; no changes: ' + JSON.stringify(report.blockers));
  directory(layout.backup);
  const active = service('is-active') === 'active';
  if (active) service('stop');
  let receipt, file;
  try {
    requireGate(layout, gate, true);
    const again = preview(layout, { ...options, gate });
    if (!again.complete || !equal(report.entries, again.entries)) fail('Preflight changed after stopping web');
    const destination = fs.mkdtempSync(path.join(layout.backup, 'cold-'));
    fs.chmodSync(destination, 0o700);
    file = path.join(destination, 'receipt.json');
    receipt = { schema: 1, approval: 'task7-r7', layout, proofs: options.proofs ?? DEFAULT_PROOFS, state: 'prepared', webWasActive: active, entries: report.entries };
    save(receipt, file);
    for (const e of receipt.entries) {
      requireGate(layout, gate, true); validateEntry(layout, e); recheckTargets(e);
      assertLink(e.path, e.before);
      e.state = 'pending'; save(receipt, file);
      options.beforeReplace?.(e);
      e.after = replace(e, e.before, e.newTarget);
      e.state = 'applied'; save(receipt, file);
    }
    checkProofs(layout, receipt.proofs);
    for (const e of receipt.entries) { assertLink(e.path, e.after); recheckTargets(e); if (!inside(layout.cli, real(e.path) ?? '')) fail('Final resolution failed'); }
    receipt.state = 'applied'; save(receipt, file);
    return { receipt: file, state: receipt.state, entries: receipt.entries.length };
  } catch (e) {
    if (receipt) { receipt.state = 'partial'; receipt.error = e.message; save(receipt, file); }
    throw new Error(e.message + (file ? '; recovery receipt: ' + file : ''));
  } finally { if (active) service('start'); }
}
export function rollback(layout, file, options = {}) {
  const gate = options.gate ?? processGate, service = options.service ?? webControl;
  requireGate(layout, gate);
  if (options.approved !== true) fail('Explicit saved-receipt rollback approval required');
  directory(layout.backup);
  const dir = path.dirname(path.resolve(file));
  if (path.dirname(dir) !== layout.backup || !path.basename(dir).startsWith('cold-') || path.basename(file) !== 'receipt.json') fail('Receipt outside private backup root');
  directory(dir);
  if ((fs.statSync(dir).mode & 0o777) !== 0o700 || !stat(file)?.isFile() || (fs.statSync(file).mode & 0o777) !== 0o600 || fs.statSync(file).uid !== process.getuid()) fail('Receipt permissions/owner rejected');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (receipt.schema !== 1 || receipt.approval !== 'task7-r7' || !equal(receipt.layout, layout) || !['partial', 'applied'].includes(receipt.state)) fail('Unapproved receipt');
  for (const e of receipt.entries) { validateEntry(layout, e); recheckTargets(e); }
  const active = service('is-active') === 'active';
  if (active) service('stop');
  try {
    requireGate(layout, gate, true);
    for (const e of [...receipt.entries].reverse()) {
      requireGate(layout, gate, true); recheckTargets(e);
      if (e.state === 'planned' || e.state === 'rolled-back') continue;
      // A crash after rename but before saving after-inode is deliberately uncertain.
      if (e.state === 'pending') { assertLink(e.path, e.before); e.state = 'rolled-back'; save(receipt, file); continue; }
      if (e.state !== 'applied' || !e.after) fail('Uncertain receipt entry; manual recovery required');
      assertLink(e.path, e.after);
      e.restored = replace(e, e.after, e.before.target);
      e.state = 'rolled-back'; save(receipt, file);
    }
    receipt.state = 'rolled-back'; save(receipt, file);
    return { state: receipt.state, receipt: file };
  } finally { if (active) service('start'); }
}
export function main(args = process.argv.slice(2)) {
  const expectedCounts = { npx: 401, broken: 207, scratch: 1 };
  if (args.length === 0 || equal(args, ['--preview'])) return preview(DEFAULT_LAYOUT, { expectedCounts });
  if (equal(args, ['--apply'])) return apply(DEFAULT_LAYOUT, { expectedCounts });
  if (args.length === 3 && args[0] === '--rollback' && args[2] === '--approve-rollback=task7-r7') return rollback(DEFAULT_LAYOUT, path.resolve(args[1]), { approved: true });
  fail('Usage: cold.mjs [--preview | --apply | --rollback RECEIPT --approve-rollback=task7-r7]');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = main(); console.log(JSON.stringify(result, null, 2)); if (result.complete === false) process.exitCode = 2; }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
