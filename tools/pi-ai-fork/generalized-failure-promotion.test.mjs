import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, readdir, symlink, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allowedOutputs, apiModules, approvedPlan, runPromotionCommand, sourceDigestFor } from './generalized-failure-promotion.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const sdkIndex = `export const PROVIDER_FAILURE_OBSERVER_VERSION = 1;
export const PROVIDER_FAILURE_APIS = Object.freeze(${JSON.stringify(apiModules)});
export function subscribeProviderFailures() {}
export function classifyProviderFailure() {}
export function reportProviderFailure() {}
export function classifyCodexFailure() {}
export function codexHttpFailureFacts() {}
export function reportCodexFailure() {}
`;
const changed = ['dist/api/openai-completions.js', 'dist/utils/provider-failure.js', 'dist/index.js'];

// Private synthetic package roots only. Retain fixtures and quarantine evidence;
// no installed SDK paths, network, credentials, timers or model calls are used.
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-generalized-promotion-test-'));
  const installed = join(root, 'sdk'), output = join(root, 'output'), candidate = join(output, 'package'), source = join(output, 'source/packages/ai');
  for (const dir of [installed, candidate, source]) await mkdir(dir, { recursive: true });
  const generated = [];
  for (const path of allowedOutputs) {
    for (const dir of [installed, candidate, source]) await mkdir(dirname(join(dir, path)), { recursive: true });
    const override = options.outputs?.[path];
    const before = override ? override.before : path === 'dist/utils/provider-failure.js' ? null : `// baseline ${path}\n`;
    const isChanged = options.allChanged || changed.includes(path);
    const after = override ? override.after : path === 'dist/index.js' ? (options.badIndex ?? sdkIndex) : isChanged ? `// candidate ${path}\n` : before;
    const isAdded = before === null;
    if (!isAdded) await writeFile(join(installed, path), before);
    await writeFile(join(candidate, path), after);
    await writeFile(join(source, path), after);
    generated.push({ path, beforeSha256: isAdded ? null : sha(before), afterSha256: sha(after), changed: isAdded || before !== after });
  }
  const protectedFiles = [];
  for (const [path, bytes] of Object.entries({
    'package.json': json({ name: '@earendil-works/pi-ai', version: '0.87.1', type: 'module' }),
    'README.md': 'protected readme\n', 'dist/oauth/protected.js': 'protected oauth\n', 'dist/catalog.js': 'protected catalog\n',
  })) {
    for (const dir of [installed, candidate]) { await mkdir(dirname(join(dir, path)), { recursive: true }); await writeFile(join(dir, path), bytes); }
    protectedFiles.push({ path, sha256: sha(bytes) });
  }
  const sourceFiles = [];
  const prefixes = [...new Set(allowedOutputs.map(path => path.replace(/(?:\.d\.ts\.map|\.d\.ts|\.js\.map|\.js)$/, '')))];
  for (const prefix of prefixes) {
    const path = prefix.replace(/^dist\//, 'src/') + '.ts';
    const before = `// baseline ${path}`, after = `// patched ${path}`;
    await mkdir(dirname(join(source, path)), { recursive: true }); await writeFile(join(source, path), after);
    sourceFiles.push({ path, beforeSha256: sha(before), afterSha256: sha(after) });
  }
  const manifestPath = join(output, 'candidate-manifest.json'), gatesPath = join(output, 'promotion-gates.json'), reportPath = join(output, 'offline-report.json');
  const manifest = { schema: 1, kind: 'generalized-failure-categories-candidate', promoted: false, installedRoot: installed, candidate, generated, protectedFiles, sourceFiles, sourceDigest: sourceDigestFor(sourceFiles) };
  const value = { root, installed, output, candidate, source, manifestPath, gatesPath, reportPath, manifest, backup: join(root, 'backup') };
  value.seal = async (changeReport = {}, changeGates = {}) => {
    const bytes = json(value.manifest); value.manifestSha256 = sha(bytes); await writeFile(manifestPath, bytes);
    const report = { manifestSha256: value.manifestSha256, candidate, passed: true, exitCode: 0, offline: true, liveCalls: 0, ...changeReport };
    const reportBytes = json(report); await writeFile(reportPath, reportBytes);
    value.gates = { schema: 1, kind: 'generalized-failure-promotion-gates', approval: approvedPlan, manifest: { path: manifestPath, sha256: value.manifestSha256 }, reports: [{ name: 'synthetic-offline', path: reportPath, sha256: sha(reportBytes) }], ...changeGates };
    const gateBytes = json(value.gates); value.gatesSha256 = sha(gateBytes); await writeFile(gatesPath, gateBytes);
  };
  value.command = (mode, entry, flags = {}) => {
    const supplied = { '--manifest': value.manifestPath, '--manifest-sha256': value.manifestSha256, '--gates': value.gatesPath, '--gates-sha256': value.gatesSha256, '--backup': value.backup, ...flags };
    if (entry !== undefined) supplied['--entry'] = String(entry);
    return runPromotionCommand([mode, ...Object.entries(supplied).flatMap(([key, val]) => [key, val])]);
  };
  await value.seal();
  return value;
}
async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }
async function receipt(f) { return JSON.parse(await readFile(join(f.backup, 'receipt.json'), 'utf8')); }
async function sdkState(f) {
  const result = {};
  for (const path of [...allowedOutputs, ...f.manifest.protectedFiles.map(entry => entry.path)]) {
    try { result[path] = sha(await readFile(join(f.installed, path))); } catch (error) { if (error.code !== 'ENOENT') throw error; result[path] = null; }
  }
  return result;
}
async function publish(f, prepared) { for (const entry of prepared.entries) await f.command('promote-entry', entry.id); }

// Every test keeps its own fake SDK, so the suites may run independently.
test('module import and help are inert; strict CLI requires two explicit digests', async () => {
  assert.equal(allowedOutputs.length, 52); assert.equal(apiModules.length, 10);
  const f = await fixture(), before = await sdkState(f);
  const help = await runPromotionCommand(['--help']); assert.match(help, /NOT multi-file atomic/);
  for (const args of [[], ['prepare'], ['prepare', '--manifest', f.manifestPath], ['prepare', '--manifest', f.manifestPath, '--manifest', f.manifestPath]]) await assert.rejects(runPromotionCommand(args));
  await assert.rejects(f.command('prepare', undefined, { '--manifest-sha256': '0'.repeat(64) }), /Hash changed/);
  await assert.rejects(f.command('prepare', undefined, { '--gates-sha256': '0'.repeat(64) }), /Hash changed/);
  await assert.rejects(f.command('prepare', 0), /only applies/);
  assert.deepEqual(await sdkState(f), before); await absent(f.backup);
});

test('prepare snapshots exact graph without SDK writes; serialized publication validates fresh process and rolls back', async () => {
  const f = await fixture(), before = await sdkState(f);
  await chmod(join(f.installed, 'dist/api/openai-completions.js'), 0o664);
  const prepared = await f.command('prepare');
  assert.equal(prepared.state, 'PREPARED'); assert.equal(prepared.multiFileAtomic, false);
  assert.equal(prepared.entries.length, 3); assert.equal(prepared.entries.at(-1).path, 'dist/index.js');
  assert.deepEqual(await sdkState(f), before);
  await assert.rejects(f.command('prepare'), { code: 'EEXIST' });
  await assert.rejects(f.command('promote-entry', 2), /CAS\/order conflict/);
  await absent(join(f.backup, 'operation.lock'));
  await assert.rejects(f.command('verify-all'), /CAS\/order conflict/);
  await publish(f, prepared);
  assert.equal((await lstat(join(f.installed, 'dist/api/openai-completions.js'))).mode & 0o777, 0o664);
  const verified = await f.command('verify-all');
  assert.equal(verified.state, 'VERIFIED'); assert.deepEqual(verified.freshProcess, { passed: true, exitCode: 0, observerVersion: 1 });
  assert.equal((await receipt(f)).state, 'VERIFIED');
  await assert.rejects(f.command('rollback-entry', 0), /CAS\/order conflict/);
  const rollback = [];
  for (const entry of [...prepared.entries].reverse()) rollback.push(await f.command('rollback-entry', entry.id));
  assert.deepEqual(await sdkState(f), before); assert.equal((await receipt(f)).state, 'RESTORED');
  assert.equal((await lstat(join(f.installed, 'dist/api/openai-completions.js'))).mode & 0o777, 0o664);
  const addition = rollback.find(result => result.quarantine);
  assert(addition); assert.equal(sha(await readFile(addition.quarantine)), f.manifest.generated.find(entry => entry.path === addition.path).afterSha256);
  assert((await readdir(join(f.backup, 'ledger'))).some(name => name.endsWith('.done')));
  assert((await readdir(join(f.backup, 'snapshots'))).length === 5);
  // Repeated rollback is harmless; publication can start again from the proven baseline.
  assert.equal((await f.command('rollback-entry', 0)).state, 'RESTORED');
  await publish(f, prepared); assert.equal((await f.command('verify-all')).state, 'VERIFIED');
});

test('source digest is stable by path and binds all triples', () => {
  const files = [{ path: 'src/z.ts', beforeSha256: null, afterSha256: 'a'.repeat(64) }, { path: 'src/a.ts', beforeSha256: 'b'.repeat(64), afterSha256: 'c'.repeat(64) }];
  assert.equal(sourceDigestFor(files), sourceDigestFor([...files].reverse()));
  assert.notEqual(sourceDigestFor(files), sourceDigestFor([{ ...files[0], beforeSha256: 'd'.repeat(64) }, files[1]]));
});

test('gates bind exact approved plan, manifest and passing offline evidence', async t => {
  const cases = [
    ['plan revision', {}, { approval: { ...approvedPlan, revision: 2 } }],
    ['plan hash', {}, { approval: { ...approvedPlan, planSha256: '0'.repeat(64) } }],
    ['different manifest', {}, { manifest: { path: '/other/manifest.json', sha256: '0'.repeat(64) } }],
    ['missing reports', {}, { reports: [] }],
    ['failed report', { passed: false }, {}],
    ['failed process', { exitCode: 1 }, {}],
    ['online report', { offline: false }, {}],
    ['live calls', { liveCalls: 1 }, {}],
    ['other candidate', { candidate: '/other/package' }, {}],
    ['other manifest report', { manifestSha256: '0'.repeat(64) }, {}],
  ];
  for (const [name, report, gates] of cases) await t.test(name, async () => {
    const f = await fixture(), before = await sdkState(f); await f.seal(report, gates);
    await assert.rejects(f.command('prepare')); await absent(f.backup); assert.deepEqual(await sdkState(f), before);
  });
});

test('unapproved paths, noncomplete inventories and SDK identity are rejected before backup', async t => {
  const cases = [
    ['output path traversal', f => { f.manifest.generated[0].path = '../foreign.js'; }],
    ['protected path traversal', f => { f.manifest.protectedFiles[0].path = '../package.json'; }],
    ['absolute output', f => { f.manifest.generated[0].path = '/tmp/foreign.js'; }],
    ['duplicate output', f => { f.manifest.generated[1] = f.manifest.generated[0]; }],
    ['missing output', f => { f.manifest.generated.pop(); }],
    ['extra output', f => { f.manifest.generated.push({ ...f.manifest.generated[0], path: 'dist/foreign.js' }); }],
    ['protected overlap', f => { f.manifest.protectedFiles.push({ path: allowedOutputs[0], sha256: f.manifest.generated[0].beforeSha256 }); }],
    ['unprotected metadata', f => { f.manifest.protectedFiles = f.manifest.protectedFiles.filter(entry => entry.path !== 'package.json'); }],
    ['omitted protected output', f => { f.manifest.protectedFiles = f.manifest.protectedFiles.filter(entry => entry.path !== 'README.md'); }],
    ['false changed flag', f => { f.manifest.generated[0].changed = !f.manifest.generated[0].changed; }],
    ['wrong source digest', f => { f.manifest.sourceDigest = '0'.repeat(64); }],
    ['legacy manifest', f => { f.manifest.kind = 'codex-failure-categories-candidate'; }],
    ['wrong installed root', f => { f.manifest.installedRoot = f.candidate; }],
    ['wrong candidate root', f => { f.manifest.candidate = f.source; }],
    ['relative installed root', f => { f.manifest.installedRoot = './sdk'; }],
    ['missing source record', f => { f.manifest.sourceFiles.pop(); f.manifest.sourceDigest = sourceDigestFor(f.manifest.sourceFiles); }],
    ['SDK identity', async f => {
      const bytes = json({ name: 'different-sdk', version: '1', type: 'module' });
      for (const root of [f.installed, f.candidate]) await writeFile(join(root, 'package.json'), bytes);
      f.manifest.protectedFiles.find(entry => entry.path === 'package.json').sha256 = sha(bytes);
    }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = await fixture(); await mutate(f); await f.seal();
    await assert.rejects(f.command('prepare')); await absent(f.backup);
  });
});

test('all source, compiler, candidate, protected and current bytes are fenced', async t => {
  const targets = [
    f => join(f.source, f.manifest.sourceFiles[0].path),
    f => join(f.source, f.manifest.generated[0].path),
    f => join(f.candidate, f.manifest.generated[0].path),
    f => join(f.installed, f.manifest.protectedFiles[1].path),
    f => join(f.candidate, f.manifest.protectedFiles[1].path),
    f => join(f.installed, f.manifest.generated[0].path),
    f => f.reportPath,
  ];
  for (const [i, target] of targets.entries()) await t.test(`tamper ${i}`, async () => {
    const f = await fixture(); await writeFile(target(f), 'foreign edit'); const current = await sdkState(f);
    await assert.rejects(f.command('prepare')); await absent(f.backup); assert.deepEqual(await sdkState(f), current);
  });
  for (const name of ['installed', 'candidate']) await t.test(`extra package file ${name}`, async () => {
    const f = await fixture(); await writeFile(join(f[name], 'dist/unreviewed.js'), 'foreign');
    await assert.rejects(f.command('prepare'), /unreviewed/); await absent(f.backup);
  });
});

test('symlink files and ancestor directories cannot redirect reads or writes', async t => {
  for (const area of ['installed', 'candidate', 'source']) await t.test(`symlink ${area} output`, async () => {
    const f = await fixture(), target = join(f[area], 'dist/api/openai-completions.js'), held = join(f.root, `${area}-original.js`);
    await rename(target, held); await symlink(held, target);
    await assert.rejects(f.command('prepare'), /regular file|Symlink package output/); await absent(f.backup);
  });
  await t.test('ancestor symlink', async () => {
    const f = await fixture(), original = join(f.installed, 'dist/api'), held = join(f.root, 'api-held');
    await rename(original, held); await symlink(held, original, 'dir');
    await assert.rejects(f.command('prepare'), /Symlink directory|Symlink package output/); await absent(f.backup);
  });
  await t.test('root symlink', async () => {
    const f = await fixture(), held = join(f.root, 'sdk-held'); await rename(f.installed, held); await symlink(held, f.installed, 'dir');
    await assert.rejects(f.command('prepare'), /Symlink directory/); await absent(f.backup);
  });
  await t.test('manifest symlink', async () => {
    const f = await fixture(), held = join(f.output, 'held-manifest.json'); await rename(f.manifestPath, held); await symlink(held, f.manifestPath);
    await assert.rejects(f.command('prepare'), /regular file/); await absent(f.backup);
  });
  await t.test('runtime node_modules mount is deliberately excluded', async () => {
    const f = await fixture(); await symlink(f.installed, join(f.candidate, 'node_modules'), 'dir');
    assert.equal((await f.command('prepare')).state, 'PREPARED');
  });
});

test('post-prepare foreign edits, snapshots and ledger tampering fail without clobbering', async t => {
  await t.test('target edit prevents promote and rollback', async () => {
    const f = await fixture(), prepared = await f.command('prepare');
    const target = join(f.installed, prepared.entries[0].path); await writeFile(target, 'concurrent user edit');
    await assert.rejects(f.command('promote-entry', 0), /CAS\/order conflict/);
    await assert.rejects(f.command('rollback-entry', 0), /CAS\/order conflict/);
    assert.equal(await readFile(target, 'utf8'), 'concurrent user edit');
  });
  await t.test('all protected files still fence each operation', async () => {
    const f = await fixture(); await f.command('prepare'); await writeFile(join(f.installed, 'dist/oauth/protected.js'), 'foreign oauth edit');
    await assert.rejects(f.command('promote-entry', 0), /Protected installed/); assert.equal((await receipt(f)).state, 'PREPARED');
  });
  await t.test('candidate drift after prepare', async () => {
    const f = await fixture(); await f.command('prepare'); await writeFile(join(f.candidate, 'dist/index.js'), 'foreign candidate edit');
    await assert.rejects(f.command('promote-entry', 0), /Candidate bytes changed/);
  });
  await t.test('snapshot drift', async () => {
    const f = await fixture(); await f.command('prepare'); await writeFile(join(f.backup, 'snapshots/0.after'), 'foreign snapshot edit');
    await assert.rejects(f.command('promote-entry', 0), /snapshot changed/); await absent(join(f.backup, 'operation.lock'));
  });
  await t.test('receipt drift', async () => {
    const f = await fixture(); await f.command('prepare'); const ledger = await receipt(f); ledger.entries[0].mode = 0o777;
    await writeFile(join(f.backup, 'receipt.json'), json(ledger));
    await assert.rejects(f.command('promote-entry', 0));
  });
  await t.test('symlink backup', async () => {
    const f = await fixture(); await f.command('prepare'); const held = join(f.root, 'backup-held'); await rename(f.backup, held); await symlink(held, f.backup, 'dir');
    await assert.rejects(f.command('promote-entry', 0), /Symlink directory/);
  });
  await t.test('nonprivate backup', async () => {
    const f = await fixture(); await f.command('prepare'); await chmod(f.backup, 0o755);
    await assert.rejects(f.command('promote-entry', 0), /private/);
  });
  await t.test('stale operation lock is retained', async () => {
    const f = await fixture(); await f.command('prepare'); await writeFile(join(f.backup, 'operation.lock'), 'interrupted process lock');
    await assert.rejects(f.command('promote-entry', 0), { code: 'EEXIST' });
    assert.equal(await readFile(join(f.backup, 'operation.lock'), 'utf8'), 'interrupted process lock');
  });
});

test('interruption after file publication is reconciled by hashes, not duplicate writes', async () => {
  const f = await fixture(), prepared = await f.command('prepare');
  const first = prepared.entries[0], target = join(f.installed, first.path);
  // Emulate rename succeeded but final receipt update did not happen.
  await writeFile(target, await readFile(join(f.backup, 'snapshots/0.after')));
  assert.equal((await receipt(f)).entries[0].state, 'PREPARED');
  assert.equal((await f.command('promote-entry', 0)).state, 'CHANGED');
  assert.equal((await f.command('promote-entry', 0)).state, 'CHANGED');
  await f.command('rollback-entry', 0);
  if (first.beforeSha256 === null) await absent(target);
  else assert.equal(sha(await readFile(target)), first.beforeSha256);
});

test('fresh process validates full generalized and legacy export contract without executing models', async t => {
  await t.test('wrong/missing generalized exports fail', async () => {
    const f = await fixture({ badIndex: 'export const PROVIDER_FAILURE_OBSERVER_VERSION = 1; export function subscribeProviderFailures() {}\n' });
    const prepared = await f.command('prepare'); await publish(f, prepared);
    await assert.rejects(f.command('verify-all'), /Fresh-process observer validation failed/);
    assert.equal((await receipt(f)).state, 'PARTIAL');
    for (const entry of [...prepared.entries].reverse()) await f.command('rollback-entry', entry.id);
  });
  await t.test('network attempted at module evaluation is refused', async () => {
    const f = await fixture({ badIndex: sdkIndex + '\nawait fetch("http://127.0.0.1:9/never-allowed");\n' });
    const prepared = await f.command('prepare'); await publish(f, prepared);
    await assert.rejects(f.command('verify-all'), /Fresh-process observer validation failed/);
  });
});

test('all changed outputs publish additive helper group first, shared dependencies next, index export last', async () => {
  const f = await fixture({ allChanged: true });
  // Manifest enumeration is not dependency ordering and cannot control rollout.
  f.manifest.generated.reverse(); await f.seal();
  const prepared = await f.command('prepare'), paths = prepared.entries.map(entry => entry.path);
  assert.equal(paths.length, 52);
  const suffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];
  assert.deepEqual(paths.slice(0, 4), suffixes.map(suffix => 'dist/utils/provider-failure' + suffix));
  assert.deepEqual(paths.slice(4, 8), suffixes.map(suffix => 'dist/api/openai-responses-shared' + suffix));
  assert.deepEqual(paths.slice(8, -4), apiModules.flatMap(name => suffixes.map(suffix => `dist/api/${name}${suffix}`)));
  assert.deepEqual(paths.slice(-4), ['dist/index.d.ts', 'dist/index.d.ts.map', 'dist/index.js.map', 'dist/index.js']);
  assert.deepEqual([...paths].reverse().slice(-4), [...paths.slice(0, 4)].reverse());
});

test('unchanged export-star index stays importable after every promotion and reverse rollback step', async () => {
  const legacyHelper = `export const PROVIDER_FAILURE_OBSERVER_VERSION = 1;
export function subscribeProviderFailures() {}
export function classifyCodexFailure() {}
export function codexHttpFailureFacts() {}
export function reportCodexFailure() {}
`;
  const sharedBefore = 'export function legacyShared() {}\n';
  const sharedAfter = `import { classifyProviderFailure } from '../utils/provider-failure.js';
export function legacyShared() {}
export const generalizedShared = classifyProviderFailure;
`;
  // Just like candidate4, the public export-star needs no compiled index edit.
  const index = 'export * from "./utils/provider-failure.js";\n' + apiModules.map((name, id) => `export * as api${id} from './api/${name}.js';`).join('\n') + '\n';
  const outputs = {
    'dist/utils/provider-failure.js': { before: legacyHelper, after: sdkIndex },
    'dist/api/openai-responses-shared.js': { before: sharedBefore, after: sharedAfter },
    'dist/index.js': { before: index, after: index },
  };
  for (const name of apiModules) outputs[`dist/api/${name}.js`] = {
    before: `import { reportCodexFailure } from '../utils/provider-failure.js';\nexport const ready = typeof reportCodexFailure === 'function';\n`,
    after: `import { reportProviderFailure } from '../utils/provider-failure.js';\nimport { generalizedShared } from './openai-responses-shared.js';\nexport const ready = typeof reportProviderFailure === 'function' && typeof generalizedShared === 'function';\n`,
  };
  const f = await fixture({ outputs }), before = await sdkState(f);
  function importFresh() {
    const source = `import assert from 'node:assert/strict';\nimport { pathToFileURL } from 'node:url';\nconst sdk = await import(pathToFileURL(process.argv[1]).href);\nfor (let i = 0; i < 10; i++) assert.equal(sdk['api' + i].ready, true);`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', source, join(f.installed, 'dist/index.js')], { encoding: 'utf8', cwd: f.root, env: { PATH: dirname(process.execPath) } });
  }
  assert.equal(importFresh().status, 0);
  // Prove the fixture catches the old leaf-first bug before using the promoter.
  const leaf = 'dist/api/openai-completions.js';
  await writeFile(join(f.installed, leaf), outputs[leaf].after);
  const unsafe = importFresh(); assert.notEqual(unsafe.status, 0); assert.match(unsafe.stderr, /does not provide an export named/);
  await writeFile(join(f.installed, leaf), outputs[leaf].before);
  const prepared = await f.command('prepare');
  assert.equal(prepared.entries[0].path, 'dist/utils/provider-failure.js');
  assert.equal(prepared.entries[1].path, 'dist/api/openai-responses-shared.js');
  assert(!prepared.entries.some(entry => entry.path === 'dist/index.js'));
  for (const entry of prepared.entries) {
    await f.command('promote-entry', entry.id);
    const result = importFresh(); assert.equal(result.status, 0, `Fresh import after publish ${entry.path}: ${result.stderr}`);
  }
  assert.equal((await f.command('verify-all')).state, 'VERIFIED');
  for (const entry of [...prepared.entries].reverse()) {
    await f.command('rollback-entry', entry.id);
    const result = importFresh(); assert.equal(result.status, 0, `Fresh import after rollback ${entry.path}: ${result.stderr}`);
  }
  assert.deepEqual(await sdkState(f), before);
});

test('CLI fresh process --help has no deployment effects', async () => {
  const script = fileURLToPath(new URL('./generalized-failure-promotion.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env: { PATH: dirname(process.execPath) } });
  assert.equal(result.status, 0); assert.match(result.stdout, /Guarded generalized SDK/); assert.equal(result.stderr, '');
});
