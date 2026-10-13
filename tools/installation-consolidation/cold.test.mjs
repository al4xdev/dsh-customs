import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { apply, preview, rollback, processGate, PI_VERSION, DEFAULT_LAYOUT, DEFAULT_PROOFS, webControl } from './cold.mjs';

const ADAPTER = '@deepseek-ai/dsh-llm-pi-ai';
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cold-fixture-'));
  t.after(() => {
    // This root was exclusively created by this fixture; do not follow links during cleanup.
    assert.equal(fs.realpathSync(root), root);
    assert.ok(path.basename(root).startsWith('dsh-cold-fixture-'));
    fs.rmSync(root, { recursive: true });
  });
  const layout = Object.fromEntries(['home', 'cli', 'profiles', 'npx', 'scratch', 'backup', 'proc'].map(k => [k, path.join(root, k)]));
  for (const p of Object.values(layout)) fs.mkdirSync(p, { mode: 0o700 });
  for (const p of ['node_modules', 'dsh-tui/node_modules/@deepseek-ai']) fs.mkdirSync(path.join(layout.profiles, p), { recursive: true });
  const calls = [];
  const options = { proofs: {}, gate: () => [], service: action => { calls.push(action); return action === 'is-active' ? 'active' : ''; } };
  function pkg(where, name, version = '1.0.0', code = 'export const fixture = true;') {
    const p = path.join(layout[where], 'node_modules', name);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name, version }));
    fs.writeFileSync(path.join(p, 'index.js'), code);
    return p;
  }
  function link(name, scratch = false) {
    const p = path.join(layout.profiles, scratch ? 'dsh-tui/node_modules' : 'node_modules', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(path.join(layout[scratch ? 'scratch' : 'npx'], 'node_modules', name), p);
    return p;
  }
  function proc(pid, args, node = true) {
    const p = path.join(layout.proc, String(pid)); fs.mkdirSync(p);
    fs.symlinkSync(node ? fs.realpathSync(process.execPath) : '/usr/bin/false', path.join(p, 'exe'));
    fs.writeFileSync(path.join(p, 'cmdline'), args.join('\0') + '\0');
  }
  pkg('npx', 'alpha'); pkg('cli', 'alpha');
  const alpha = link('alpha');
  pkg('scratch', ADAPTER); pkg('cli', ADAPTER);
  const adapter = link(ADAPTER, true);
  return { root, layout, options, calls, pkg, link, proc, alpha, adapter };
}

test('import is inert and default layout/proofs are explicit, SDK50 pinned', () => {
  assert.equal(DEFAULT_LAYOUT.home, '/home/alex');
  assert.equal(Object.keys(DEFAULT_PROOFS).length, 5);
  assert.ok(Object.values(DEFAULT_PROOFS).every(v => /^[a-f0-9]{64}$/.test(v)));
  assert.throws(() => webControl('restart'), /Unapproved/); // No command is spawned.
});
test('default preview core is readonly: no directories, services, processes or HMR writes', t => {
  const f = fixture(t);
  const hmr = path.join(f.layout.profiles, 'dsh-tui', 'cordis.patch.yml');
  fs.writeFileSync(hmr, 'HMR and private settings stay untouched');
  const before = fs.readdirSync(f.layout.backup);
  const report = preview(f.layout, f.options);
  assert.equal(report.complete, true);
  assert.equal(report.mode, 'preview');
  assert.equal(report.entries.length, 2);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(fs.readdirSync(f.layout.backup), before);
  assert.equal(fs.readFileSync(hmr, 'utf8'), 'HMR and private settings stay untouched');
  assert.equal(fs.readlinkSync(f.alpha), path.join(f.layout.npx, 'node_modules/alpha'));
});
test('apply refuses live TUI3033 before all writes and systemctl calls', t => {
  const f = fixture(t); f.proc(3033, [process.execPath, path.join(f.layout.cli, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'dsh-tui', '--prompt', 'NEVER EMIT THIS']);
  const blockers = processGate(f.layout);
  assert.deepEqual(blockers, [{ pid: 3033, kind: 'TUI' }]);
  assert.ok(!JSON.stringify(blockers).includes('NEVER'));
  assert.throws(() => apply(f.layout, { ...f.options, gate: processGate }), /Cold gate/);
  assert.deepEqual(f.calls, []); assert.deepEqual(fs.readdirSync(f.layout.backup), []);
});
test('gate catches native/default TUI; excludes prototype companion, unrelated and non-node', t => {
  const f = fixture(t); const bin = path.join(f.layout.cli, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  f.proc(1, [process.execPath, bin]);
  f.proc(2, [process.execPath, bin, 'companion']);
  f.proc(3, [process.execPath, bin, 'web']);
  f.proc(4, [process.execPath, '/unrelated/tool.mjs', 'subagent']);
  f.proc(5, ['/usr/bin/false', bin, '--profile=dsh-tui'], false);
  assert.deepEqual(processGate(f.layout).map(x => x.pid), [1]);
  assert.deepEqual(processGate(f.layout, { afterStop: true }).map(x => x.pid), [1, 3]);
  assert.deepEqual(processGate(f.layout, { includeExcluded: true }).find(x => x.pid === 2), { pid: 2, kind: 'active-prototype-consumer' });
});
test('own-UID gate skips foreign exe before access and retains launcher3025/TUI3033', t => {
  const f = fixture(t); const foreign = path.join(f.layout.proc, '268'); fs.mkdirSync(foreign);
  f.proc(3025, [process.execPath, path.join(f.layout.cli, 'local-model-launch.mjs')]);
  f.proc(3033, [process.execPath, path.join(f.layout.cli, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'dsh-tui']);
  const originalStat = fs.statSync, originalReal = fs.realpathSync;
  t.mock.method(fs, 'statSync', (p, ...rest) => p === foreign ? { uid: process.getuid() + 1 } : originalStat(p, ...rest));
  t.mock.method(fs, 'realpathSync', (p, ...rest) => {
    assert.notEqual(p, path.join(foreign, 'exe'), 'Foreign exe must never be inspected');
    return originalReal(p, ...rest);
  });
  assert.deepEqual(processGate(f.layout), [{ pid: 3025, kind: 'TUI' }, { pid: 3033, kind: 'TUI' }]);
});
test('only protected systemd/sd-pam exe denial with exact own init.scope is exempt', t => {
  const f = fixture(t), bin = path.join(f.layout.cli, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const scope = `0::/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/init.scope`;
  const cases = [
    [802, 'systemd', scope, 'EACCES'], [812, '(sd-pam)', scope, 'EPERM'],
    [813, 'systemd', scope + '/other', 'EACCES'], [814, 'node', scope, 'EACCES'],
    [815, 'systemd', scope, 'EIO'],
  ];
  for (const [pid, comm, cgroup] of cases) {
    f.proc(pid, [process.execPath, bin, '--profile', 'dsh-tui']);
    fs.writeFileSync(path.join(f.layout.proc, String(pid), 'comm'), comm + '\n');
    fs.writeFileSync(path.join(f.layout.proc, String(pid), 'cgroup'), cgroup + '\n');
  }
  f.proc(3033, [process.execPath, bin, '--profile', 'dsh-tui']);
  const originalReal = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (p, ...rest) => {
    const row = cases.find(([pid]) => p === path.join(f.layout.proc, String(pid), 'exe'));
    if (row) throw Object.assign(new Error('protected fixture exe'), { code: row[3] });
    return originalReal(p, ...rest);
  });
  assert.deepEqual(processGate(f.layout), [
    { pid: 3033, kind: 'TUI' },
    ...[813, 814, 815].map(pid => ({ pid, kind: 'unreadable-process-selector' })),
  ]);
});
test('readable Node exe cannot spoof manager comm/cgroup to bypass TUI or unreadable argv gate', t => {
  const f = fixture(t), bin = path.join(f.layout.cli, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  for (const pid of [3033, 3034]) {
    f.proc(pid, [process.execPath, bin, '--profile', 'dsh-tui']);
    fs.writeFileSync(path.join(f.layout.proc, String(pid), 'comm'), 'systemd\n');
    fs.writeFileSync(path.join(f.layout.proc, String(pid), 'cgroup'), `0::/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service/init.scope\n`);
  }
  const cmdline = path.join(f.layout.proc, '3034', 'cmdline');
  fs.unlinkSync(cmdline); fs.mkdirSync(cmdline);
  assert.deepEqual(processGate(f.layout), [{ pid: 3033, kind: 'TUI' }, { pid: 3034, kind: 'unreadable-process-selector' }]);
});
test('known leading profile selectors classify prototype841 without prompt exemptions', t => {
  const f = fixture(t); const bin = path.join(f.layout.cli, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  f.proc(841, [process.execPath, bin, '--profile', 'companion', 'web']);
  f.proc(842, [process.execPath, bin, '--profile=companion', 'web']);
  f.proc(3033, [process.execPath, bin, '--profile', 'dsh-tui', 'web']);
  f.proc(3034, [process.execPath, bin, '--prompt', '--profile=companion', 'web']);
  f.proc(10899, [process.execPath, bin, '--profile', 'web', 'web']);
  assert.deepEqual(processGate(f.layout), [{ pid: 3033, kind: 'TUI' }, { pid: 3034, kind: 'TUI' }]);
  assert.equal(processGate(f.layout, { afterStop: true }).some(x => x.pid === 10899), true);
  assert.deepEqual(processGate(f.layout, { includeExcluded: true }).filter(x => x.pid < 1000), [
    { pid: 841, kind: 'active-prototype-consumer' }, { pid: 842, kind: 'active-prototype-consumer' },
  ]);
});
test('node flags, .bin launch and a prompt containing web cannot bypass TUI gate', t => {
  const f = fixture(t); const bin = path.join(f.layout.cli, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  f.proc(3033, [process.execPath, '--no-warnings', bin, '--prompt', 'web']);
  f.proc(3034, [process.execPath, path.join(f.layout.cli, 'node_modules/.bin/dsh'), 'tui']);
  assert.deepEqual(processGate(f.layout), [{ pid: 3033, kind: 'TUI' }, { pid: 3034, kind: 'TUI' }]);
});
test('regular shared llamacpp and arbitrary regular paths survive apply and rollback', t => {
  const f = fixture(t); const local = path.join(f.layout.profiles, 'node_modules/@deepseek-ai/dsh-llm-llamacpp');
  fs.mkdirSync(local, { recursive: true });
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(local, `${i}.js`), `local-${i}`);
  const regular = path.join(f.layout.profiles, 'node_modules/local.txt'); fs.writeFileSync(regular, 'owned locally');
  const report = preview(f.layout, f.options); assert.equal(report.preserved.length, 2);
  const result = apply(f.layout, f.options);
  assert.deepEqual(f.calls, ['is-active', 'stop', 'start']);
  assert.equal(fs.realpathSync(f.alpha), path.join(f.layout.cli, 'node_modules/alpha'));
  assert.equal(fs.realpathSync(f.adapter), path.join(f.layout.cli, 'node_modules', ADAPTER));
  assert.equal(fs.statSync(path.dirname(result.receipt)).mode & 0o777, 0o700);
  const receipt = JSON.parse(fs.readFileSync(result.receipt));
  assert.ok(receipt.entries.every(e => e.before.mode === 0o777 && e.after && e.previous.hash));
  rollback(f.layout, result.receipt, { ...f.options, approved: true });
  assert.equal(fs.realpathSync(f.alpha), path.join(f.layout.npx, 'node_modules/alpha'));
  assert.equal(fs.readFileSync(regular, 'utf8'), 'owned locally');
  for (let i = 0; i < 12; i++) assert.equal(fs.readFileSync(path.join(local, `${i}.js`), 'utf8'), `local-${i}`);
});
test('broken old package stays deferred even if canonical package exists', t => {
  const f = fixture(t); f.pkg('cli', 'broken'); const p = f.link('broken');
  const report = preview(f.layout, f.options);
  assert.equal(report.complete, false); assert.equal(report.counts.broken, 1);
  assert.match(report.blockers.join(' '), /Missing package target/);
  assert.throws(() => apply(f.layout, f.options), /Incomplete mapping/);
  assert.ok(fs.lstatSync(p).isSymbolicLink()); assert.deepEqual(f.calls, []);
});
test('missing canonical package rejects entire mapping without partial changes', t => {
  const f = fixture(t); f.pkg('npx', 'missing'); f.link('missing');
  assert.throws(() => apply(f.layout, f.options), /Incomplete mapping/);
  assert.deepEqual(fs.readdirSync(f.layout.backup), []);
});
test('version mismatch and fake module name reject mapping', t => {
  const f = fixture(t); f.pkg('cli', 'alpha', '2.0.0');
  assert.match(preview(f.layout, f.options).blockers.join(' '), /Version mismatch/);
  fs.writeFileSync(path.join(f.layout.cli, 'node_modules/alpha/package.json'), JSON.stringify({ name: 'fake', version: '1.0.0' }));
  assert.match(preview(f.layout, f.options).blockers.join(' '), /identity mismatch/);
});
test('only intentional Pi version transition is allowed; static overlay proof is required', t => {
  const f = fixture(t); const pi = '@earendil-works/pi-ai';
  f.pkg('npx', pi, '0.87.1'); const target = f.pkg('cli', pi, PI_VERSION); f.link(pi);
  const relative = 'node_modules/@earendil-works/pi-ai/index.js';
  const options = { ...f.options, proofs: { [relative]: digest(fs.readFileSync(path.join(target, 'index.js'))) } };
  assert.equal(preview(f.layout, options).complete, true);
  fs.writeFileSync(path.join(target, 'index.js'), 'drift');
  assert.equal(preview(f.layout, options).complete, false);
  assert.throws(() => apply(f.layout, options), /Static code hash mismatch/);
});
test('adapter byte mismatch blocks even with identical public version', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.layout.cli, 'node_modules', ADAPTER, 'index.js'), 'different');
  assert.match(preview(f.layout, f.options).blockers.join(' '), /Adapter code bytes differ/);
});
test('unapproved target, escape through symlink and count drift reject mapping', t => {
  const f = fixture(t); fs.unlinkSync(f.alpha); fs.symlinkSync(path.join(f.root, 'other'), f.alpha);
  assert.match(preview(f.layout, f.options).blockers.join(' '), /Unapproved symlink/);
  const r = preview(f.layout, { ...f.options, expectedCounts: { npx: 401, broken: 207 } });
  assert.match(r.blockers.join(' '), /Inventory count drift/);
});
test('canonical realpath escape is blocked before reading foreign metadata', t => {
  const f = fixture(t); f.pkg('npx', 'beta'); f.link('beta');
  const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign);
  // Deliberately no manifest: the confinement error must precede any metadata read.
  fs.symlinkSync(foreign, path.join(f.layout.cli, 'node_modules/beta'));
  const r = preview(f.layout, f.options);
  assert.match(r.blockers.join(' '), /Package target escapes selected root: beta/);
  assert.throws(() => apply(f.layout, f.options), /Incomplete mapping/);
  assert.deepEqual(f.calls, []);
});
test('unreadable proc selector fails closed without exposing argv', t => {
  const f = fixture(t); const p = path.join(f.layout.proc, '3033'); fs.mkdirSync(p);
  fs.symlinkSync(fs.realpathSync(process.execPath), path.join(p, 'exe'));
  fs.mkdirSync(path.join(p, 'cmdline')); // EISDIR after positively identifying Node.
  assert.deepEqual(processGate(f.layout), [{ pid: 3033, kind: 'unreadable-process-selector' }]);
});
test('scope-directory symlinks are not followed or recursively mutated', t => {
  const f = fixture(t); fs.symlinkSync(f.layout.npx, path.join(f.layout.profiles, 'node_modules/@escape'));
  const r = preview(f.layout, f.options);
  assert.equal(r.complete, false); assert.match(r.blockers.join(' '), /Unapproved symlink/);
});
test('mid-apply failure records partial state and rollback restores completed entries', t => {
  const f = fixture(t); let count = 0;
  assert.throws(() => apply(f.layout, { ...f.options, beforeReplace: () => { if (++count === 2) throw new Error('fixture failure'); } }), /fixture failure.*recovery receipt/);
  const dir = fs.readdirSync(f.layout.backup)[0]; const file = path.join(f.layout.backup, dir, 'receipt.json');
  const r = JSON.parse(fs.readFileSync(file)); assert.equal(r.state, 'partial');
  assert.equal(r.entries[0].state, 'applied'); assert.equal(r.entries[1].state, 'pending');
  rollback(f.layout, file, { ...f.options, approved: true });
  assert.equal(fs.realpathSync(f.alpha), path.join(f.layout.npx, 'node_modules/alpha'));
  assert.deepEqual(f.calls, ['is-active', 'stop', 'start', 'is-active', 'stop', 'start']);
});
test('post-edit conflict is never overwritten by apply', t => {
  const f = fixture(t);
  assert.throws(() => apply(f.layout, { ...f.options, beforeReplace: e => { fs.unlinkSync(e.path); fs.writeFileSync(e.path, 'post-edit'); } }), /Not a symlink/);
  assert.equal(fs.readFileSync(f.alpha, 'utf8'), 'post-edit');
});
test('target metadata mutation before rename prevents any replacement', t => {
  const f = fixture(t);
  assert.throws(() => apply(f.layout, { ...f.options, beforeReplace: e => { fs.writeFileSync(path.join(e.newTarget, 'package.json'), JSON.stringify({ name: e.name, version: 'changed' })); } }), /metadata changed/);
  assert.equal(fs.realpathSync(f.alpha), path.join(f.layout.npx, 'node_modules/alpha'));
});
test('rollback requires approval, cold gate and unchanged after-link inode', t => {
  const f = fixture(t); const result = apply(f.layout, f.options);
  assert.throws(() => rollback(f.layout, result.receipt, f.options), /approval required/);
  assert.throws(() => rollback(f.layout, result.receipt, { ...f.options, approved: true, gate: () => [{ pid: 3033, kind: 'TUI' }] }), /Cold gate/);
  fs.unlinkSync(f.adapter); fs.symlinkSync(path.join(f.layout.cli, 'node_modules', ADAPTER), f.adapter);
  assert.throws(() => rollback(f.layout, result.receipt, { ...f.options, approved: true }), /Post-edit conflict/);
  assert.equal(fs.realpathSync(f.adapter), path.join(f.layout.cli, 'node_modules', ADAPTER));
});
test('tampered receipt cannot target YAML, profiles or unrelated roots', t => {
  const f = fixture(t); const result = apply(f.layout, f.options);
  const r = JSON.parse(fs.readFileSync(result.receipt)); r.entries[0].path = path.join(f.layout.profiles, 'cordis.yml');
  fs.writeFileSync(result.receipt, JSON.stringify(r));
  assert.throws(() => rollback(f.layout, result.receipt, { ...f.options, approved: true }), /Unapproved receipt path/);
  assert.ok(!fs.existsSync(path.join(f.layout.profiles, 'cordis.yml')));
});
test('a TUI appearing after web stop blocks before backup creation', t => {
  const f = fixture(t); let stopped = false;
  const options = { ...f.options, gate: () => stopped ? [{ pid: 3033 }] : [], service: action => { f.calls.push(action); if (action === 'stop') stopped = true; return action === 'is-active' ? 'active' : ''; } };
  assert.throws(() => apply(f.layout, options), /Cold gate/);
  assert.deepEqual(fs.readdirSync(f.layout.backup), []);
  assert.deepEqual(f.calls, ['is-active', 'stop', 'start']);
});
