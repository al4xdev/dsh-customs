import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { preview, apply, VERSION_PAIRS, EXPECTED_COUNTS, COMPLETED_COUNTS, BASELINE, ALIASES } from './finish.mjs';
import { processGate } from './cold.mjs';

const ADAPTER = '@deepseek-ai/dsh-llm-pi-ai';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-finish-fixture-'));
  t.after(() => { assert.equal(fs.realpathSync(root), root); assert.ok(path.basename(root).startsWith('dsh-finish-fixture-')); fs.rmSync(root, { recursive: true }); });
  const layout = Object.fromEntries(['home', 'cli', 'npx', 'scratch', 'profiles', 'proc'].map(n => [n, path.join(root, n)]));
  const tempRoot = path.join(root, 'temp');
  for (const p of [...Object.values(layout), tempRoot]) fs.mkdirSync(p, { mode: 0o700 });
  fs.mkdirSync(path.join(layout.profiles, 'node_modules'));
  fs.mkdirSync(path.join(layout.profiles, 'dsh-tui/node_modules/@deepseek-ai'), { recursive: true });
  const calls = [];
  const options = { proofs: {}, baseline: null, aliases: {}, adapterFiles: 2, expectedCounts: {}, gate: () => [], tempRoot, service: action => { calls.push(action); return action === 'is-active' ? 'active' : ''; } };
  function pkg(where, name, version = '1.0.0') {
    const p = path.join(layout[where], 'node_modules', name); fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name, version })); fs.writeFileSync(path.join(p, 'index.js'), 'fixture code only'); return p;
  }
  function link(name, { scratch = false, target } = {}) {
    const p = path.join(layout.profiles, scratch ? 'dsh-tui/node_modules' : 'node_modules', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(target ?? path.join(layout[scratch ? 'scratch' : 'npx'], 'node_modules', name), p); return p;
  }
  function alias(name, action, version = '1.0.0') {
    const oldRelative = `node_modules/owner/node_modules/${name}`;
    options.aliases[name] = { oldRelative, action };
    if (action === 'retarget') {
      const lockFile = 'package-lock.json', lockKey = 'node_modules/' + name;
      const lock = fs.existsSync(path.join(layout.npx, lockFile)) ? JSON.parse(fs.readFileSync(path.join(layout.npx, lockFile))) : { packages: {} };
      lock.packages[lockKey] = { name, version };
      fs.writeFileSync(path.join(layout.npx, lockFile), JSON.stringify(lock));
      const lockHash = sha(fs.readFileSync(path.join(layout.npx, lockFile)));
      for (const rule of Object.values(options.aliases)) if (rule.locks) rule.locks[0].hash = lockHash;
      Object.assign(options.aliases[name], { locks: [{ file: lockFile, hash: lockHash }], version }); pkg('cli', name, version); pkg('npx', name, version);
    }
    return link(name, { target: path.join(layout.npx, oldRelative) });
  }
  pkg('npx', 'alpha'); pkg('cli', 'alpha'); const alpha = link('alpha');
  pkg('scratch', ADAPTER); pkg('cli', ADAPTER); const adapter = link(ADAPTER, { scratch: true });
  return { root, layout, options, calls, pkg, link, alias, alpha, adapter, tempRoot };
}
function receipt(f) { const dir = fs.readdirSync(f.tempRoot)[0]; return path.join(f.tempRoot, dir, 'receipt.jsonl'); }

test('approved public baseline has203 exact names and aliases use truthful hoisted proofs', () => {
  assert.equal(BASELINE.missingNames.length, 203);
  assert.equal(sha(BASELINE.missingNames.join('\n')), BASELINE.missingDigest);
  assert.equal(Object.keys(ALIASES).length, 4);
  assert.equal(ALIASES.debug.locks.length, 2);
  assert.equal(ALIASES.ms.version, '2.0.0');
});
function strictFixtureOptions(f) {
  f.link('obsolete');
  return {
    ...f.options,
    baseline: { missingNames: ['obsolete'], missingDigest: sha('obsolete'), liveDigest: sha('alpha\n') },
    expectedCounts: { shared: 2, directLive: 1, directMissing: 1, canonical: 0, scratch: 1, retarget: 2, retire: 1 },
    completedCounts: { shared: 1, directLive: 1, directMissing: 0, canonical: 2, scratch: 1, retarget: 0, retire: 0 },
  };
}
test('completed preview and repeated apply are idempotent, with zero files/services/actions', t => {
  const f = fixture(t), options = strictFixtureOptions(f);
  assert.equal(preview(f.layout, options).complete, true);
  apply(f.layout, options);
  const dirs = fs.readdirSync(f.tempRoot), calls = [...f.calls];
  const final = preview(f.layout, options);
  assert.equal(final.complete, true); assert.equal(final.stage, 'completed');
  assert.equal(final.entries.length, 0); assert.equal(final.counts.canonical, 2);
  assert.equal(apply(f.layout, options).actions, 0);
  assert.deepEqual(fs.readdirSync(f.tempRoot), dirs); assert.deepEqual(f.calls, calls);
});
test('full synthetic608-link cut produces404 retargets/205 removals and404 canonical zero-action result', t => {
  const f = fixture(t), liveNames = ['alpha'];
  for (let i = 0; i < 400; i++) {
    const name = `fixture-${String(i).padStart(3, '0')}`;
    liveNames.push(name); f.pkg('npx', name); f.pkg('cli', name); f.link(name);
  }
  for (const name of BASELINE.missingNames) f.link(name);
  f.alias('@tanstack/react-virtual', 'retire'); f.alias('react-dom', 'retire');
  f.alias('debug', 'retarget', '2.6.9'); f.alias('ms', 'retarget', '2.0.0');
  const options = {
    ...f.options, expectedCounts: EXPECTED_COUNTS, completedCounts: COMPLETED_COUNTS,
    baseline: { ...BASELINE, liveDigest: sha(liveNames.sort().join('\n') + '\n') },
  };
  const before = preview(f.layout, options);
  assert.equal(before.complete, true); assert.equal(before.entries.length, 609);
  assert.equal(before.counts.retarget, 404); assert.equal(before.counts.retire, 205);
  apply(f.layout, options);
  const after = preview(f.layout, options);
  assert.equal(after.complete, true); assert.equal(after.entries.length, 0);
  assert.equal(after.counts.shared, 403); assert.equal(after.counts.canonical, 404);
  assert.equal(apply(f.layout, options).actions, 0);
});
test('partial operation count drift rejects blind retry before any service or extra temp write', t => {
  const f = fixture(t), options = strictFixtureOptions(f); let n = 0;
  assert.throws(() => apply(f.layout, { ...options, beforeAction: () => { if (++n === 2) throw new Error('partial fixture'); } }), /partial fixture/);
  const dirs = fs.readdirSync(f.tempRoot), calls = [...f.calls];
  const partial = preview(f.layout, options);
  assert.equal(partial.complete, false); assert.match(partial.blockers.join(' '), /Count drift/);
  assert.throws(() => apply(f.layout, options), /Incomplete classified mapping/);
  assert.deepEqual(fs.readdirSync(f.tempRoot), dirs); assert.deepEqual(f.calls, calls);
});
test('unknown missing names fail baseline membership', t => {
  const f = fixture(t), options = strictFixtureOptions(f);
  f.link('unapproved-obsolete');
  assert.match(preview(f.layout, options).blockers.join(' '), /Obsolete selection digest\/membership mismatch/);
});
test('completed state cannot accept added canonical packages outside the frozen source set', t => {
  const f = fixture(t), options = strictFixtureOptions(f);
  apply(f.layout, options);
  f.pkg('npx', 'foreign-name'); f.pkg('cli', 'foreign-name');
  f.link('foreign-name', { target: path.join(f.layout.cli, 'node_modules/foreign-name') });
  const report = preview(f.layout, options);
  assert.equal(report.complete, false); assert.match(report.blockers.join(' '), /Live package selection digest mismatch/);
});
test('hoisted repair identifies missing nested identity honestly and rejects hoisted/C drift', t => {
  const f = fixture(t); f.alias('debug', 'retarget', '2.6.9');
  const e = preview(f.layout, f.options).entries.find(e => e.name === 'debug');
  assert.equal(e.previous.nestedIdentity, 'UNKNOWN (absent)'); assert.match(e.previous.proof, /hoisted repair/);
  f.pkg('cli', 'debug', '2.7.0');
  assert.match(preview(f.layout, f.options).blockers.join(' '), /Alias canonical version mismatch/);
  f.pkg('cli', 'debug', '2.6.9'); f.pkg('npx', 'debug', '2.7.0');
  assert.match(preview(f.layout, f.options).blockers.join(' '), /Hoisted source version mismatch/);
});
test('preview classifies direct missing-both and creates no dirs/files/service processes', t => {
  const f = fixture(t); const obsolete = f.link('obsolete');
  const before = fs.readdirSync(f.tempRoot), report = preview(f.layout, f.options);
  assert.equal(report.complete, true); assert.equal(report.counts.retire, 1);
  assert.equal(report.entries.find(e => e.name === 'obsolete').action, 'retire');
  assert.deepEqual(fs.readdirSync(f.tempRoot), before); assert.deepEqual(f.calls, []);
  assert.ok(fs.lstatSync(obsolete).isSymbolicLink()); assert.equal(EXPECTED_COUNTS.shared, 608);
});
test('apply retires only missing-both symlinks, saves exact targets, keeps roots and regular llamacpp12', t => {
  const f = fixture(t); const obsolete = f.link('obsolete');
  const local = path.join(f.layout.profiles, 'node_modules/@deepseek-ai/dsh-llm-llamacpp'); fs.mkdirSync(local, { recursive: true });
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(local, `${i}.js`), `local${i}`);
  const hmr = path.join(f.layout.profiles, 'dsh-tui/cordis.patch.yml'); fs.writeFileSync(hmr, 'unchanged HMR');
  const result = apply(f.layout, f.options);
  assert.equal(result.state, 'complete'); assert.equal(fs.existsSync(obsolete), false);
  assert.equal(fs.realpathSync(f.alpha), path.join(f.layout.cli, 'node_modules/alpha'));
  assert.equal(fs.realpathSync(f.adapter), path.join(f.layout.cli, 'node_modules', ADAPTER));
  assert.deepEqual(f.calls, ['is-active', 'stop', 'start']);
  assert.equal(fs.statSync(path.dirname(result.receipt)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(result.receipt).mode & 0o777, 0o600);
  const records = fs.readFileSync(result.receipt, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records[0].entries.find(e => e.name === 'obsolete').before.target, path.join(f.layout.npx, 'node_modules/obsolete'));
  assert.equal(records.at(-1).state, 'complete'); assert.ok(fs.existsSync(f.layout.npx)); assert.ok(fs.existsSync(f.layout.scratch));
  for (let i = 0; i < 12; i++) assert.equal(fs.readFileSync(path.join(local, `${i}.js`), 'utf8'), `local${i}`);
  assert.equal(fs.readFileSync(hmr, 'utf8'), 'unchanged HMR');
});
test('missing source with unexpectedly present canonical package blocks whole mapping', t => {
  const f = fixture(t); f.pkg('cli', 'obsolete'); f.link('obsolete');
  assert.equal(preview(f.layout, f.options).complete, false);
  assert.throws(() => apply(f.layout, f.options), /Incomplete classified mapping/);
  assert.deepEqual(fs.readdirSync(f.tempRoot), []); assert.deepEqual(f.calls, []);
});
test('canonical target appearing after selection prevents obsolete unlink and restores web', t => {
  const f = fixture(t); const obsolete = f.link('obsolete');
  assert.throws(() => apply(f.layout, { ...f.options, beforeAction: e => { if (e.name === 'obsolete') f.pkg('cli', 'obsolete'); } }), /Missing\/escaped package/);
  assert.ok(fs.lstatSync(obsolete).isSymbolicLink()); assert.equal(f.calls.at(-1), 'start');
  assert.equal(fs.readFileSync(receipt(f), 'utf8').trim().split('\n').map(JSON.parse).at(-1).state, 'partial');
});
test('only four exact approved version pairs pass, all other version drifts fail', t => {
  const f = fixture(t);
  for (const [name, [before, after]] of Object.entries(VERSION_PAIRS)) { f.pkg('npx', name, before); f.pkg('cli', name, after); f.link(name); }
  const report = preview(f.layout, f.options); assert.equal(report.complete, true);
  for (const name of Object.keys(VERSION_PAIRS)) assert.equal(report.entries.find(e => e.name === name).action, 'retarget');
  f.pkg('cli', 'alpha', '2.0.0'); assert.match(preview(f.layout, f.options).blockers.join(' '), /Unapproved version transition/);
});
test('source version/metadata drift after preflight is rejected without overwriting its link', t => {
  const f = fixture(t);
  assert.throws(() => apply(f.layout, { ...f.options, beforeAction: e => { if (e.name === 'alpha') f.pkg('npx', 'alpha', 'drift'); } }), /Unapproved version transition/);
  assert.equal(fs.readlinkSync(f.alpha), path.join(f.layout.npx, 'node_modules/alpha'));
  assert.equal(f.calls.at(-1), 'start');
});
test('nested obsolete aliases require exact approved target and both absent', t => {
  const f = fixture(t); const react = f.alias('react-virtual', 'retire'); f.alias('react-dom', 'retire');
  assert.equal(preview(f.layout, f.options).complete, true);
  fs.unlinkSync(react); fs.symlinkSync(path.join(f.layout.npx, 'node_modules/arbitrary/node_modules/react-virtual'), react);
  assert.match(preview(f.layout, f.options).blockers.join(' '), /Unapproved alias target/);
});
test('debug/ms aliases retarget using lock version proof, never invented old identity', t => {
  const f = fixture(t); const debug = f.alias('debug', 'retarget', '2.6.9'); const ms = f.alias('ms', 'retarget', '2.0.0');
  const report = preview(f.layout, f.options); assert.equal(report.complete, true);
  assert.equal(report.entries.find(e => e.name === 'debug').previous.version, '2.6.9');
  apply(f.layout, f.options);
  assert.equal(fs.realpathSync(debug), path.join(f.layout.cli, 'node_modules/debug'));
  assert.equal(fs.realpathSync(ms), path.join(f.layout.cli, 'node_modules/ms'));
});
test('origin-lock drift or alias canonical version mismatch blocks before any writes', t => {
  const f = fixture(t); f.alias('debug', 'retarget', '2.6.9');
  fs.appendFileSync(path.join(f.layout.npx, 'package-lock.json'), ' ');
  assert.match(preview(f.layout, f.options).blockers.join(' '), /Alias origin lock mismatch/);
  assert.throws(() => apply(f.layout, f.options), /Incomplete/); assert.deepEqual(f.calls, []);
});
test('escaping lexical or real ancestor alias targets are not retired', t => {
  const f = fixture(t); const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  const p = f.link('escape', { target: path.join(outside, 'escape') });
  f.options.aliases.escape = { oldRelative: '../outside/escape', action: 'retire' };
  assert.match(preview(f.layout, f.options).blockers.join(' '), /escapes approved root/);
  fs.unlinkSync(p); fs.symlinkSync(outside, path.join(f.layout.npx, 'node_modules/redirect'));
  fs.symlinkSync(path.join(f.layout.npx, 'node_modules/redirect/escape'), p);
  f.options.aliases.escape.oldRelative = 'node_modules/redirect/escape';
  assert.match(preview(f.layout, f.options).blockers.join(' '), /ancestor escapes/);
});
test('zero-TUI gate rejects3033 before tmp creation or service query', t => {
  const f = fixture(t); const proc = path.join(f.layout.proc, '3033'); fs.mkdirSync(proc);
  fs.symlinkSync(fs.realpathSync(process.execPath), path.join(proc, 'exe'));
  fs.writeFileSync(path.join(proc, 'cmdline'), [process.execPath, path.join(f.layout.cli, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'dsh-tui'].join('\0'));
  assert.throws(() => apply(f.layout, { ...f.options, gate: processGate }), /Cold gate rejected/);
  assert.deepEqual(fs.readdirSync(f.tempRoot), []); assert.deepEqual(f.calls, []);
});
test('old inode conflicts and regular post-edits are never overwritten', t => {
  const f = fixture(t);
  assert.throws(() => apply(f.layout, { ...f.options, beforeAction: e => { fs.unlinkSync(e.path); fs.writeFileSync(e.path, 'post-edit'); } }), /Symlink conflict/);
  assert.equal(fs.readFileSync(f.alpha, 'utf8'), 'post-edit'); assert.equal(f.calls.at(-1), 'start');
});
test('failure after first operation logs partial progress and resumes web without rollback', t => {
  const f = fixture(t); let actions = 0;
  assert.throws(() => apply(f.layout, { ...f.options, beforeAction: () => { if (++actions === 2) throw new Error('fixture failure'); } }), /fixture failure.*progress receipt/);
  const records = fs.readFileSync(receipt(f), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(r => r.state === 'completed').length, 1); assert.equal(records.at(-1).state, 'partial');
  assert.equal(fs.realpathSync(f.alpha), path.join(f.layout.cli, 'node_modules/alpha'));
  assert.equal(f.calls.at(-1), 'start');
});
test('adapter code and pinned hashes are checked without importing package code', t => {
  const f = fixture(t); const relative = 'node_modules/alpha/index.js';
  const options = { ...f.options, proofs: { [relative]: sha(fs.readFileSync(path.join(f.layout.cli, relative))) } };
  fs.writeFileSync(path.join(f.layout.cli, 'node_modules', ADAPTER, 'index.js'), 'changed');
  assert.match(preview(f.layout, options).blockers.join(' '), /Adapter bytes\/count mismatch/);
  fs.writeFileSync(path.join(f.layout.cli, relative), 'drift');
  assert.match(preview(f.layout, options).blockers.join(' '), /Static hash mismatch/);
});
test('consumer appearing after web stop prevents all tmp/link writes and web restarts', t => {
  const f = fixture(t); let stopped = false;
  const options = { ...f.options, gate: () => stopped ? [{ pid: 3033 }] : [], service: action => { f.calls.push(action); if (action === 'stop') stopped = true; return action === 'is-active' ? 'active' : ''; } };
  assert.throws(() => apply(f.layout, options), /Cold gate rejected/);
  assert.deepEqual(fs.readdirSync(f.tempRoot), []); assert.deepEqual(f.calls, ['is-active', 'stop', 'start']);
});
