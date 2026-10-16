import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const approvedPlan = Object.freeze({ planId: 105, revision: 1, planSha256: '54bc2b89ee908ca1ee8db930f5bd93f7d1266583485840929e9441aed2a717ae' });
export const apiModules = Object.freeze(['openai-completions', 'mistral-conversations', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses', 'anthropic-messages', 'bedrock-converse-stream', 'google-generative-ai', 'google-vertex', 'pi-messages']);
const prefixes = [...apiModules.map(name => `dist/api/${name}`), 'dist/api/openai-responses-shared', 'dist/utils/provider-failure', 'dist/index'];
const suffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];
export const allowedOutputs = Object.freeze(prefixes.flatMap(prefix => suffixes.map(suffix => prefix + suffix)));
const publicationOrder = [
  ...suffixes.map(suffix => 'dist/utils/provider-failure' + suffix),
  ...suffixes.map(suffix => 'dist/api/openai-responses-shared' + suffix),
  ...apiModules.flatMap(name => suffixes.map(suffix => `dist/api/${name}${suffix}`)),
  'dist/index.d.ts', 'dist/index.d.ts.map', 'dist/index.js.map', 'dist/index.js',
];
const allowedSources = prefixes.map(prefix => prefix.replace(/^dist\//, 'src/') + '.ts');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const within = (root, path) => path === root || path.startsWith(root + '/');

function absolute(path, label = 'Path') {
  assert(typeof path === 'string' && path.length > 0 && !path.includes('\0') && resolve(path) === path, `${label} must be absolute and normalized`);
  return path;
}
function relative(path) {
  assert(typeof path === 'string' && /^[A-Za-z0-9_@.+/-]+$/.test(path) && !path.startsWith('/') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), `Unsafe package path: ${path}`);
  return path;
}
function digest(value, nullable = false) {
  assert(nullable && value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Expected lowercase SHA-256');
  return value;
}
function uniquePaths(entries, label) {
  assert(Array.isArray(entries), `${label} must be an array`);
  const paths = entries.map(entry => relative(entry.path));
  assert.equal(new Set(paths).size, paths.length, `Duplicate ${label} path`);
  return paths;
}
async function directory(path) {
  absolute(path);
  assert.equal(await realpath(path), path, `Symlink directory refused: ${path}`);
  const stat = await lstat(path);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `Expected real directory: ${path}`);
  return stat;
}
async function regular(path, optional = false) {
  absolute(path);
  await directory(dirname(path));
  let stat;
  try { stat = await lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
  assert(stat.isFile() && !stat.isSymbolicLink(), `Not a regular file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assert(opened.isFile() && opened.dev === stat.dev && opened.ino === stat.ino, `File changed while opening: ${path}`);
    const bytes = await handle.readFile();
    return { bytes, sha256: sha(bytes), mode: stat.mode & 0o777 };
  } finally { await handle.close(); }
}
async function hash(path, optional = false) { return (await regular(path, optional))?.sha256 ?? null; }
async function syncDir(path) {
  await directory(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durableNew(path, bytes, mode = 0o600) {
  absolute(path); await directory(dirname(path));
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.chmod(mode); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function checkedJson(path, expectedHash) {
  digest(expectedHash);
  const file = await regular(path);
  assert.equal(file.sha256, expectedHash, `Hash changed: ${path}`);
  return JSON.parse(file.bytes.toString('utf8'));
}

// node_modules is a runtime dependency mount, not a package output. The producer
// intentionally mounts it as a symlink; no traversal or writes beneath it occur.
async function inventory(root) {
  await directory(root);
  const files = [];
  async function walk(path, prefix = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (prefix === '' && entry.name === 'node_modules') continue;
      const name = relative(prefix + entry.name), target = join(root, name);
      assert(!entry.isSymbolicLink(), `Symlink package output refused: ${target}`);
      if (entry.isDirectory()) { await directory(target); await walk(target, name + '/'); }
      else { assert(entry.isFile(), `Special package output refused: ${target}`); files.push(name); }
    }
  }
  await walk(root);
  return files.sort();
}

/** Canonical digest shared with the candidate producer: no locale-dependent ordering. */
export function sourceDigestFor(sourceFiles) {
  return sha(JSON.stringify(sourceFiles.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

async function provenance(options) {
  const { manifestPath, manifestSha256, gatesPath, gatesSha256, backup } = options;
  for (const path of [manifestPath, gatesPath, backup]) absolute(path);
  assert.notEqual(manifestPath, gatesPath, 'Manifest and approval gates must be separate files');
  const manifest = await checkedJson(manifestPath, manifestSha256);
  assert.equal(manifest.schema, 1); assert.equal(manifest.kind, 'generalized-failure-categories-candidate');
  assert.equal(manifest.promoted, false, 'Only an unpromoted candidate manifest is accepted');
  const installed = absolute(manifest.installedRoot), candidate = absolute(manifest.candidate);
  const source = join(dirname(manifestPath), 'source/packages/ai');
  assert.equal(candidate, join(dirname(manifestPath), 'package'), 'Candidate must be the reviewed compiled package root');
  for (const path of [installed, candidate, source]) await directory(path);
  for (const [a, b] of [[installed, candidate], [installed, source], [candidate, source]]) {
    assert(!within(a, b) && !within(b, a), 'Source, candidate and installed roots must be separate');
  }
  for (const root of [installed, candidate, source]) assert(!within(root, backup) && !within(backup, root), 'Backup must be separate from SDK/source/candidate roots');
  assert(!within(backup, manifestPath) && !within(backup, gatesPath), 'Approval inputs cannot live inside the backup');
  const outputPaths = uniquePaths(manifest.generated, 'generated');
  assert.deepEqual(outputPaths.slice().sort(), [...allowedOutputs].sort(), 'Generated output set differs from approved allowlist');
  for (const file of manifest.generated) {
    digest(file.beforeSha256, true); digest(file.afterSha256);
    assert.equal(file.changed, file.beforeSha256 !== file.afterSha256, 'Inconsistent changed flag');
  }
  assert(manifest.generated.some(file => file.changed), 'Candidate has no changes');
  const protectedPaths = uniquePaths(manifest.protectedFiles, 'protected');
  assert(protectedPaths.includes('package.json'), 'Package metadata must be protected');
  for (const file of manifest.protectedFiles) { assert(!allowedOutputs.includes(file.path), 'Protected/output overlap'); digest(file.sha256); }
  const sourcePaths = uniquePaths(manifest.sourceFiles, 'source');
  assert.deepEqual(sourcePaths.slice().sort(), allowedSources.slice().sort(), 'Source set differs from approved modules');
  for (const file of manifest.sourceFiles) {
    digest(file.beforeSha256, true); digest(file.afterSha256);
    assert.equal(await hash(join(source, file.path)), file.afterSha256, `Reviewed source changed: ${file.path}`);
  }
  digest(manifest.sourceDigest);
  assert.equal(manifest.sourceDigest, sourceDigestFor(manifest.sourceFiles), 'Source digest mismatch');
  for (const file of manifest.generated) {
    assert.equal(await hash(join(source, file.path)), file.afterSha256, `Compiler bytes changed: ${file.path}`);
    assert.equal(await hash(join(candidate, file.path)), file.afterSha256, `Candidate bytes changed: ${file.path}`);
  }
  for (const file of manifest.protectedFiles) {
    assert.equal(await hash(join(installed, file.path)), file.sha256, `Protected installed output changed: ${file.path}`);
    assert.equal(await hash(join(candidate, file.path)), file.sha256, `Protected candidate output changed: ${file.path}`);
  }
  const installedMetadata = JSON.parse((await regular(join(installed, 'package.json'))).bytes.toString('utf8'));
  assert.equal(installedMetadata.name, '@earendil-works/pi-ai', 'Different SDK identity');
  assert(typeof installedMetadata.version === 'string' && installedMetadata.version.length > 0, 'SDK version missing');
  const expectedFiles = [...outputPaths, ...protectedPaths].sort();
  assert.deepEqual(await inventory(candidate), expectedFiles, 'Candidate has unreviewed or missing package files');
  // Missing generated files are allowed only for genuinely new outputs. Every
  // other SDK byte, including metadata and OAuth/catalog output, is fenced.
  const currentFiles = await inventory(installed);
  assert(currentFiles.every(path => expectedFiles.includes(path)), 'Installed SDK has unreviewed package files');
  assert(protectedPaths.every(path => currentFiles.includes(path)), 'Installed SDK lost a protected output');

  const gates = await checkedJson(gatesPath, gatesSha256);
  assert.equal(gates.schema, 1); assert.equal(gates.kind, 'generalized-failure-promotion-gates');
  assert.deepEqual(gates.approval, approvedPlan, 'Approval must bind approved plan105 revision1');
  assert.deepEqual(gates.manifest, { path: manifestPath, sha256: manifestSha256 }, 'Approval gates bind another manifest');
  assert(Array.isArray(gates.reports) && gates.reports.length > 0, 'Approved offline test reports are required');
  const names = new Set(), reportPaths = new Set();
  for (const report of gates.reports) {
    assert(typeof report.name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(report.name) && !names.has(report.name), 'Invalid/duplicate report name');
    absolute(report.path); assert(!reportPaths.has(report.path), 'Duplicate report path');
    assert(!within(backup, report.path), 'Reports cannot live inside backup');
    assert(![manifestPath, gatesPath].includes(report.path), 'Reports must be separate artifacts');
    names.add(report.name); reportPaths.add(report.path);
    const evidence = await checkedJson(report.path, report.sha256);
    assert.equal(evidence.manifestSha256, manifestSha256, 'Test report binds another manifest');
    assert.equal(evidence.candidate, candidate, 'Test report binds another candidate');
    assert.equal(evidence.passed, true, 'Test report did not pass'); assert.equal(evidence.exitCode, 0);
    assert.equal(evidence.offline, true, 'Only offline test reports are accepted'); assert.equal(evidence.liveCalls, 0);
  }
  const changed = manifest.generated.filter(file => file.changed);
  // New leaf modules import additive helper exports that the old helper lacks.
  // Publish the compatible helper first, then shared dependencies and consumers;
  // index.js is last only when changed (an existing export-star may be unchanged).
  // Reverse rollback restores all consumers before withdrawing helper exports.
  changed.sort((a, b) => publicationOrder.indexOf(a.path) - publicationOrder.indexOf(b.path));
  return { manifest, installed, candidate, source, metadata: installedMetadata, changed };
}

function entriesFor(proof) {
  return proof.changed.map((file, id) => ({ id, path: file.path, beforeSha256: file.beforeSha256, afterSha256: file.afterSha256 }));
}
async function checkRoot(proof, expected) {
  for (const file of proof.manifest.generated) {
    const actual = await hash(join(proof.installed, file.path), true);
    const wanted = expected(file);
    assert(Array.isArray(wanted) ? wanted.includes(actual) : actual === wanted, `Target CAS/order conflict: ${file.path}`);
  }
}
async function backupDirectory(backup) {
  const stat = await directory(backup);
  assert.equal(stat.mode & 0o077, 0, 'Backup directory must be private');
  if (process.getuid) assert.equal(stat.uid, process.getuid(), 'Backup directory is not owned by this process user');
  return stat;
}
function receiptIdentity(options, proof) {
  return { schema: 1, kind: 'generalized-failure-promotion-receipt', approval: approvedPlan,
    manifestPath: options.manifestPath, manifestSha256: options.manifestSha256, gatesPath: options.gatesPath, gatesSha256: options.gatesSha256,
    installedRoot: proof.installed, candidate: proof.candidate, backup: options.backup, sourceDigest: proof.manifest.sourceDigest, multiFileAtomic: false };
}
async function readReceipt(options, proof) {
  const backupStat = await backupDirectory(options.backup);
  assert.equal(backupStat.dev, (await directory(proof.installed)).dev, 'Backup filesystem changed');
  const file = await regular(join(options.backup, 'receipt.json'));
  const receipt = JSON.parse(file.bytes.toString('utf8'));
  for (const [key, value] of Object.entries(receiptIdentity(options, proof))) assert.deepEqual(receipt[key], value, `Receipt identity changed: ${key}`);
  assert(typeof receipt.id === 'string' && /^[a-f0-9-]{36}$/.test(receipt.id), 'Invalid receipt id');
  assert(Number.isSafeInteger(receipt.revision) && receipt.revision >= 1, 'Invalid receipt revision');
  assert.equal(await hash(join(options.backup, 'ledger', `${receipt.revision}-${file.sha256}.json`)), file.sha256, 'Receipt differs from retained ledger');
  assert(['PREPARED', 'UNCERTAIN', 'PARTIAL', 'VERIFIED', 'ROLLBACK_PARTIAL', 'RESTORED'].includes(receipt.state), 'Invalid receipt state');
  assert.equal(receipt.entries?.length, proof.changed.length, 'Receipt entry count changed');
  for (const expected of entriesFor(proof)) {
    const entry = receipt.entries[expected.id];
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(entry[key], value, `Receipt entry changed: ${key}`);
    assert(Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777, 'Invalid saved file mode');
    assert(['PREPARED', 'UNCERTAIN', 'CHANGED', 'RESTORED'].includes(entry.state), 'Invalid entry state');
    assert.equal(await hash(join(options.backup, 'snapshots', `${entry.id}.after`)), entry.afterSha256, 'Staged candidate snapshot changed');
    if (entry.beforeSha256 !== null) assert.equal(await hash(join(options.backup, 'snapshots', `${entry.id}.before`)), entry.beforeSha256, 'Rollback snapshot changed');
  }
  return { receipt, receiptSha256: file.sha256 };
}
async function saveReceipt(options, receipt, expectedHash) {
  const path = join(options.backup, 'receipt.json');
  assert.equal(await hash(path), expectedHash, 'Concurrent receipt edit');
  receipt.revision += 1;
  const bytes = jsonBytes(receipt);
  const staged = join(options.backup, 'staged', `receipt-${randomUUID()}.json`);
  await durableNew(staged, bytes);
  await durableNew(join(options.backup, 'ledger', `${receipt.revision}-${sha(bytes)}.json`), bytes);
  assert.equal(await hash(path), expectedHash, 'Concurrent receipt edit; staged receipt retained');
  await directory(dirname(path)); await rename(staged, path); await syncDir(options.backup);
  return sha(bytes);
}
async function lock(options, task) {
  await backupDirectory(options.backup);
  const path = join(options.backup, 'operation.lock');
  const bytes = jsonBytes({ id: randomUUID(), pid: process.pid });
  await durableNew(path, bytes);
  try { return await task(); }
  finally {
    // A crash leaves a visible lock requiring operator review. Normal release
    // retains the lock as evidence rather than deleting an arbitrary path.
    assert.equal(await hash(path), sha(bytes), 'Operation lock changed; manual recovery required');
    const archived = join(options.backup, 'ledger', `lock-${JSON.parse(bytes).id}.done`);
    await directory(dirname(path)); await directory(dirname(archived));
    await rename(path, archived); await syncDir(options.backup); await syncDir(dirname(archived));
  }
}
async function replace(options, proof, entry, bytes, expectedHash) {
  const target = join(proof.installed, entry.path);
  assert(allowedOutputs.includes(entry.path) && within(proof.installed, target), 'Target outside allowlist');
  assert.equal(await hash(target, true), expectedHash, 'Target CAS conflict before staging');
  const staged = join(options.backup, 'staged', `${entry.id}-${randomUUID()}.output`);
  await durableNew(staged, bytes, entry.mode);
  assert.equal(await hash(target, true), expectedHash, 'Target edited while staging; candidate retained');
  await directory(dirname(target)); await directory(dirname(staged));
  // Atomic only for this file. Hash guards do not exclude a noncooperating
  // writer between the final check and rename; deployment must be serialized.
  await rename(staged, target); await syncDir(dirname(target)); await syncDir(dirname(staged));
}

async function prepare(options) {
  const proof = await provenance(options);
  await checkRoot(proof, file => file.beforeSha256);
  const parent = await directory(dirname(options.backup));
  const installedStat = await directory(proof.installed);
  assert.equal(parent.dev, installedStat.dev, 'Backup must share SDK filesystem for atomic per-file rename');
  await mkdir(options.backup, { mode: 0o700 });
  await syncDir(dirname(options.backup)); await backupDirectory(options.backup);
  for (const name of ['snapshots', 'staged', 'ledger', 'quarantine']) await mkdir(join(options.backup, name), { mode: 0o700 });
  const entries = entriesFor(proof);
  for (const entry of entries) {
    const after = await regular(join(proof.candidate, entry.path));
    const before = await regular(join(proof.installed, entry.path), true);
    assert.equal(after.sha256, entry.afterSha256); assert.equal(before?.sha256 ?? null, entry.beforeSha256, 'Target changed during preparation');
    entry.mode = before?.mode ?? after.mode; entry.state = 'PREPARED';
    await durableNew(join(options.backup, 'snapshots', `${entry.id}.after`), after.bytes);
    if (before) await durableNew(join(options.backup, 'snapshots', `${entry.id}.before`), before.bytes);
  }
  // Recheck the entire approved graph after snapshotting, before issuing a receipt.
  await provenance(options); await checkRoot(proof, file => file.beforeSha256);
  const receipt = { ...receiptIdentity(options, proof), id: randomUUID(), revision: 1, state: 'PREPARED', entries };
  const bytes = jsonBytes(receipt);
  await durableNew(join(options.backup, 'ledger', `1-${sha(bytes)}.json`), bytes);
  await durableNew(join(options.backup, 'receipt.json'), bytes);
  for (const name of ['snapshots', 'ledger', 'staged', 'quarantine']) await syncDir(join(options.backup, name));
  await syncDir(options.backup);
  return { state: receipt.state, entries, receipt: join(options.backup, 'receipt.json'), receiptSha256: sha(bytes), multiFileAtomic: false };
}
async function promoteEntry(options, proof, receipt, receiptHash) {
  const entry = receipt.entries[options.entry]; assert(entry, 'Entry is outside receipt');
  await checkRoot(proof, file => {
    const other = receipt.entries.find(item => item.path === file.path);
    if (!other) return file.beforeSha256;
    return other.id < entry.id ? other.afterSha256 : other.id > entry.id ? other.beforeSha256 : [other.beforeSha256, other.afterSha256];
  });
  const target = join(proof.installed, entry.path), current = await hash(target, true);
  if (current === entry.beforeSha256) {
    receipt.state = 'UNCERTAIN'; entry.state = 'UNCERTAIN'; receiptHash = await saveReceipt(options, receipt, receiptHash);
    await replace(options, proof, entry, (await regular(join(options.backup, 'snapshots', `${entry.id}.after`))).bytes, entry.beforeSha256);
  }
  assert.equal(await hash(target), entry.afterSha256);
  entry.state = 'CHANGED'; receipt.state = 'PARTIAL'; await saveReceipt(options, receipt, receiptHash);
  return { id: entry.id, path: entry.path, state: entry.state, multiFileAtomic: false };
}
async function rollbackEntry(options, proof, receipt, receiptHash) {
  const entry = receipt.entries[options.entry]; assert(entry, 'Entry is outside receipt');
  await checkRoot(proof, file => {
    const other = receipt.entries.find(item => item.path === file.path);
    if (!other) return file.beforeSha256;
    return other.id > entry.id ? other.beforeSha256 : [other.beforeSha256, other.afterSha256];
  });
  const target = join(proof.installed, entry.path), current = await hash(target, true);
  let quarantine;
  if (current !== entry.beforeSha256) {
    receipt.state = 'UNCERTAIN'; entry.state = 'UNCERTAIN'; receiptHash = await saveReceipt(options, receipt, receiptHash);
    if (entry.beforeSha256 === null) {
      // Added outputs are moved into the private backup, never unlinked. The
      // exact target and destination are resolved and checked immediately before rename.
      quarantine = join(options.backup, 'quarantine', `${entry.id}-${randomUUID()}.output`);
      absolute(target); assert.equal(target, join(proof.installed, entry.path));
      assert(allowedOutputs.includes(entry.path)); await directory(dirname(target)); await directory(dirname(quarantine));
      assert.equal(await hash(target), entry.afterSha256, 'Foreign edit prevents quarantine rollback');
      await rename(target, quarantine); await syncDir(dirname(target)); await syncDir(dirname(quarantine));
      assert.equal(await hash(quarantine), entry.afterSha256); entry.quarantine = quarantine;
    } else {
      await replace(options, proof, entry, (await regular(join(options.backup, 'snapshots', `${entry.id}.before`))).bytes, entry.afterSha256);
    }
  }
  assert.equal(await hash(target, true), entry.beforeSha256);
  entry.state = 'RESTORED'; receipt.state = receipt.entries.every(item => item.state === 'RESTORED') ? 'RESTORED' : 'ROLLBACK_PARTIAL';
  await saveReceipt(options, receipt, receiptHash);
  return { id: entry.id, path: entry.path, state: 'RESTORED', ...(quarantine ? { quarantine } : {}), multiFileAtomic: false };
}

const validationScript = `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const offline = () => { throw new Error('Promotion validation forbids network'); };
net.Socket.prototype.connect = offline;
dgram.Socket.prototype.send = offline;
globalThis.fetch = offline;
syncBuiltinESMExports();
const sdk = await import(pathToFileURL(process.argv[1]).href);
assert.equal(sdk.PROVIDER_FAILURE_OBSERVER_VERSION, 1);
assert.equal(typeof sdk.subscribeProviderFailures, 'function');
assert(Object.isFrozen(sdk.PROVIDER_FAILURE_APIS));
assert.deepEqual([...sdk.PROVIDER_FAILURE_APIS].sort(), ${JSON.stringify([...apiModules].sort())});
for (const name of ['classifyProviderFailure', 'reportProviderFailure', 'classifyCodexFailure', 'codexHttpFailureFacts', 'reportCodexFailure']) assert.equal(typeof sdk[name], 'function', name);
console.log(JSON.stringify({ passed: true, observerVersion: sdk.PROVIDER_FAILURE_OBSERVER_VERSION }));`;
async function freshProcess(proof) {
  // No caller-provided commands, loaders, NODE_OPTIONS, inherited credentials or
  // test scripts. This imports the reviewed local public index in a new process.
  const args = ['--input-type=module', '-e', validationScript, join(proof.installed, 'dist/index.js')];
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { cwd: proof.installed, env: { PATH: dirname(process.execPath), HOME: proof.installed }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    let stdout = '', stderr = '', overflow = false;
    const collect = field => chunk => {
      if (field === 'stdout') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 65536) { overflow = true; child.kill(); }
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      try {
        assert(!overflow, 'Fresh-process validation output exceeded limit');
        assert.equal(signal, null, 'Fresh-process validation interrupted'); assert.equal(code, 0, 'Fresh-process observer validation failed');
        const result = JSON.parse(stdout.trim()); assert.equal(result.passed, true); assert.equal(result.observerVersion, 1);
        resolveResult({ passed: true, exitCode: 0, observerVersion: 1 });
      } catch (error) { reject(error); }
    });
  });
}
async function verifyAll(options, proof, receipt, receiptHash) {
  await checkRoot(proof, file => file.afterSha256);
  const validation = await freshProcess(proof);
  // A successful child cannot legitimize a concurrent edit to any graph input.
  await provenance(options); await checkRoot(proof, file => file.afterSha256);
  for (const entry of receipt.entries) entry.state = 'CHANGED';
  receipt.state = 'VERIFIED'; receipt.freshProcess = validation;
  await saveReceipt(options, receipt, receiptHash);
  return { state: 'VERIFIED', entries: receipt.entries.length, protectedFiles: proof.manifest.protectedFiles.length, freshProcess: validation, multiFileAtomic: false,
    qualification: 'Local fresh-process import/export proof, not live provider inference or restart.' };
}

export const help = `Guarded generalized SDK failure promotion (plan105r1). No effects on import.
node tools/pi-ai-fork/generalized-failure-promotion.mjs MODE \\
  --manifest /absolute/candidate-manifest.json --manifest-sha256 SHA256 \\
  --gates /absolute/promotion-gates.json --gates-sha256 SHA256 \\
  --backup /absolute/new-private-backup-directory [--entry N]
Modes: prepare | promote-entry | rollback-entry | verify-all
prepare: snapshots and receipt only; SDK remains unchanged. Backup parent must
exist on SDK filesystem. promote-entry: serialized ascending receipt ids; additive
helper.js first with helper maps/types, then shared/API consumers, index.js last
if changed. rollback-entry: descending ids, consumers before old helper; additions
move to backup/quarantine.
verify-all: all graph hashes, then a fresh local Node import checking observer v1.
Gates JSON: {schema:1,kind:'generalized-failure-promotion-gates',
 approval:{planId:105,revision:1,planSha256:'${approvedPlan.planSha256}'},
 manifest:{path:'/exact/manifest',sha256:'...'},
 reports:[{name:'sdk',path:'/exact/offline-report.json',sha256:'...'}]}.
Each report binds manifestSha256,candidate and passed:true,exitCode:0,offline:true,
liveCalls:0. Parent review chooses sufficient reports; hashes are not human approval.
Source digest = SHA256(JSON.stringify(sourceFiles reduced to path,beforeSha256,
afterSha256, sorted by path)); source root = manifest sibling source/packages/ai,
candidate = manifest sibling package. Explicit hashes required for every mode.
Per-file rename is NOT multi-file atomic or atomic CAS against noncooperating
writers. Exclude concurrent deployments. Retain interrupted backups/stages/locks;
review a stale operation.lock manually, never silently discard it. No network,
model calls, package/catalog/OAuth/TUI/lock/profile writes, or daemon restarts.
`;

/** Argument parsing and promotion are explicit; merely importing this module is inert. */
export async function runPromotionCommand(argv) {
  if (argv.length === 1 && ['--help', 'help'].includes(argv[0])) return help;
  const [mode, ...args] = argv;
  assert(['prepare', 'promote-entry', 'rollback-entry', 'verify-all'].includes(mode), help);
  const flags = new Map();
  assert.equal(args.length % 2, 0, 'Flags require values');
  const names = new Set(['--manifest', '--manifest-sha256', '--gates', '--gates-sha256', '--backup', '--entry']);
  for (let i = 0; i < args.length; i += 2) {
    assert(names.has(args[i]) && !flags.has(args[i]), 'Unknown or duplicate flag'); flags.set(args[i], args[i + 1]);
  }
  for (const key of ['--manifest', '--manifest-sha256', '--gates', '--gates-sha256', '--backup']) assert(flags.has(key), `Required: ${key}`);
  const options = { manifestPath: flags.get('--manifest'), manifestSha256: digest(flags.get('--manifest-sha256')), gatesPath: flags.get('--gates'), gatesSha256: digest(flags.get('--gates-sha256')), backup: flags.get('--backup') };
  for (const path of [options.manifestPath, options.gatesPath, options.backup]) absolute(path);
  if (['promote-entry', 'rollback-entry'].includes(mode)) {
    assert(/^(?:0|[1-9][0-9]*)$/.test(flags.get('--entry')), 'A nonnegative --entry integer is required');
    options.entry = Number(flags.get('--entry')); assert(Number.isSafeInteger(options.entry), 'Entry too large');
  } else assert(!flags.has('--entry'), '--entry only applies to entry modes');
  if (mode === 'prepare') return prepare(options);
  // Verify the approval graph before creating even the cooperative operation lock.
  await provenance(options);
  return lock(options, async () => {
    const proof = await provenance(options);
    const { receipt, receiptSha256 } = await readReceipt(options, proof);
    if (mode === 'promote-entry') return promoteEntry(options, proof, receipt, receiptSha256);
    if (mode === 'rollback-entry') return rollbackEntry(options, proof, receipt, receiptSha256);
    return verifyAll(options, proof, receipt, receiptSha256);
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await runPromotionCommand(process.argv.slice(2)); console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
