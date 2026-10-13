import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyCodexFailureCandidate } from './verify-codex-failure-candidate.mjs';

const workspace = '/home/alex/git/my/dsh-customs';
const sdk = '/home/alex/.local/share/dsh-cli/node_modules/@earendil-works/pi-ai';
const output = join(workspace, '.dumps/codex-failure-categories-20261013-candidate3');
const candidate = join(output, 'package'), source = join(output, 'source/packages/ai');
const manifestPath = join(output, 'candidate-manifest.json');
const manifestHash = 'cf4dd4f41b910ab1ca46a8f01f61d055ac7517a9ea8322326fd1de725f50987c';
const nativePath = join(workspace, '.dumps/codex-failure-categories-20261013/native-candidate3-receipt-hardened.json');
const nativeHash = 'b5ecb8f7bc911a7984d695ef6cb1d21397a5564ac724f50dbc663be468b9f2bf';
const tuiPath = join(output, 'protected-task32-proof.json');
const tuiHash = 'd5bc957847773ff1bbfe56179c9bcdf070502a225d37fe32fbd710f81328fa5a';
const backupParent = '/home/alex/.local/share/dsh-customs-backups';
const backup = join(backupParent, 'codex-failure-categories-20261013-task38');
const ledgerPath = join(backup, 'receipt.json');
const suffixes = ['.js', '.js.map', '.d.ts', '.d.ts.map'];
const allowlist = ['dist/api/openai-codex-responses', 'dist/index', 'dist/utils/provider-failure'].flatMap(prefix => suffixes.map(suffix => prefix + suffix));
// Publish the public index JS last, after all helper/API/type/map bytes exist.
const sequence = [
  ...suffixes.map(suffix => 'dist/utils/provider-failure' + suffix),
  'dist/api/openai-codex-responses.js', 'dist/api/openai-codex-responses.js.map', 'dist/api/openai-codex-responses.d.ts.map',
  'dist/index.d.ts', 'dist/index.d.ts.map', 'dist/index.js.map', 'dist/index.js',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function regular(path, optional = false) {
  assert.equal(resolve(path), path, 'Absolute normalized path required');
  assert.equal(await realpath(dirname(path)), dirname(path), `Symlink parent refused: ${path}`);
  let stat;
  try { stat = await lstat(path); } catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
  assert(stat.isFile() && !stat.isSymbolicLink(), `Not a regular owned file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return { bytes: await handle.readFile(), mode: stat.mode & 0o777 }; } finally { await handle.close(); }
}
async function hash(path, optional = false) { const file = await regular(path, optional); return file ? sha(file.bytes) : null; }
async function syncDir(path) { const handle = await open(path, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
async function durableNew(path, bytes, mode = 0o600) {
  assert.equal(await realpath(dirname(path)), dirname(path));
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function provenance() {
  assert.equal(await realpath(sdk), sdk); assert.equal(await realpath(candidate), candidate);
  assert.equal(await hash(manifestPath), manifestHash, 'Reviewed manifest changed');
  assert.equal(await hash(nativePath), nativeHash, 'Final hardened native receipt changed');
  assert.equal(await hash(tuiPath), tuiHash, 'Six-output Task32 proof changed');
  const manifest = JSON.parse((await regular(manifestPath)).bytes);
  assert.equal(manifest.installedRoot, sdk); assert.equal(manifest.candidate, candidate); assert.equal(manifest.promoted, false);
  assert.deepEqual(manifest.generated.map(file => file.path).sort(), allowlist.slice().sort());
  assert.equal(manifest.generated.filter(file => file.changed).length, 11);
  assert.deepEqual(manifest.generated.filter(file => file.changed).map(file => file.path).sort(), sequence.slice().sort());
  assert.equal(manifest.sourceDigest, '475db54e67d1d4ef75ef452c31d7409902d6ba7920c4bf8736ce39d0f5e26849');
  for (const file of manifest.sourceFiles) {
    assert(['src/index.ts', 'src/api/openai-codex-responses.ts', 'src/utils/provider-failure.ts'].includes(file.path));
    assert.equal(await hash(join(source, file.path)), file.afterSha256, 'Reviewed compiled source changed');
  }
  assert.equal(manifest.sourceFiles.length, 3);
  for (const file of manifest.generated) {
    assert.equal(await hash(join(source, file.path)), file.afterSha256, 'Compiler output changed');
    assert.equal(await hash(join(candidate, file.path)), file.afterSha256, 'Candidate differs from compiler bytes');
    if (!file.changed) assert.equal(await hash(join(sdk, file.path)), file.afterSha256, 'No-op owned output changed');
  }
  const native = JSON.parse((await regular(nativePath)).bytes);
  assert.equal(native.task, '38r1'); assert.equal(native.candidate, candidate); assert.equal(native.stableBeforeAfter, true);
  assert.deepEqual(native.tests, { total: 40, pass: 40, fail: 0, exitCode: 0 });
  assert.equal(native.safety.liveCalls, 0); assert.equal(native.safety.realCredentials, false);
  // These fixed-path receipt facts fence the exact root/fixture/log graph used by the gate.
  for (const [path, digest] of Object.entries(native.hashes)) {
    assert(path.startsWith(candidate + '/') || path.startsWith(join(workspace, 'plugins/codex-transient-close/')) || path.startsWith(join(workspace, '.dumps/codex-failure-categories-20261013/')));
    assert.equal(await hash(path), digest, 'Final native input changed');
  }
  const tui = JSON.parse((await regular(tuiPath)).bytes);
  const tuiRoot = join(workspace, 'frontend/dsh-tui/lib/types/dsh-adapter/oauth');
  const tuiNames = ['index.js', 'index.d.ts', 'index.d.ts.map', 'profiles.js', 'profiles.d.ts', 'profiles.d.ts.map'];
  assert.deepEqual(tui.targets.map(file => file.target), tuiNames.map(name => join(tuiRoot, name)));
  for (const file of tui.targets) assert.equal(await hash(file.target), file.afterHash, 'Task32 TUI compiled output changed');
  for (const file of manifest.protectedFiles) {
    assert(!allowlist.includes(file.path)); assert(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
    assert.equal(await hash(join(sdk, file.path)), file.sha256, 'Protected installed SDK output changed');
    assert.equal(await hash(join(candidate, file.path)), file.sha256, 'Protected candidate SDK output changed');
  }
  assert.equal(manifest.protectedFiles.length, 764);
  assert.equal(await hash(join(sdk, 'package.json')), await hash(join(candidate, 'package.json')), 'Package metadata must remain unchanged');
  return manifest;
}
function entriesFor(manifest) {
  return sequence.map((path, id) => {
    const file = manifest.generated.find(item => item.path === path);
    return { id, path, target: join(sdk, path), beforeHash: file.beforeSha256, afterHash: file.afterSha256,
      oldFile: file.beforeSha256 === null ? null : join(backup, `${id}.before`), newFile: join(backup, `${id}.candidate`) };
  });
}
async function ledger(manifest) {
  assert.equal(await realpath(backup), backup);
  const bytes = (await regular(ledgerPath)).bytes, receipt = JSON.parse(bytes);
  assert.equal(receipt.task, '38r1'); assert.equal(receipt.manifestHash, manifestHash); assert.equal(receipt.nativeHash, nativeHash);
  const expected = entriesFor(manifest); assert.equal(receipt.entries.length, 11);
  for (const entry of expected) {
    const recorded = receipt.entries[entry.id];
    for (const [key, value] of Object.entries(entry)) assert.equal(recorded[key], value, `Receipt target/provenance changed: ${key}`);
    assert.equal(await hash(entry.newFile), entry.afterHash, 'Durable candidate snapshot changed');
    if (entry.oldFile) assert.equal(await hash(entry.oldFile), entry.beforeHash, 'Durable rollback snapshot changed');
  }
  return { receipt, ledgerHash: sha(bytes) };
}
async function saveReceipt(receipt, expectedHash) {
  assert.equal(await hash(ledgerPath), expectedHash, 'Concurrent receipt edit; refuse overwrite');
  const temp = join(backup, `.receipt-${randomUUID()}.tmp`);
  await durableNew(temp, JSON.stringify(receipt, null, 2) + '\n');
  assert.equal(await hash(ledgerPath), expectedHash, 'Concurrent receipt edit; retain staged temp for recovery');
  await rename(temp, ledgerPath); await syncDir(backup);
  return await hash(ledgerPath);
}
async function replaceFile(entry, bytes, expectedHash, mode) {
  assert(allowlist.includes(entry.path)); assert.equal(entry.target, join(sdk, entry.path));
  const parent = dirname(entry.target); assert.equal(await realpath(parent), parent);
  assert(parent.startsWith(sdk + '/')); assert.equal(await hash(entry.target, true), expectedHash, 'Target CAS conflict');
  const temp = join(parent, `.task38-${entry.id}-${randomUUID()}.tmp`);
  // Staging and rename are same-directory. On interruption, retain temp; never delete a computed path.
  await durableNew(temp, bytes, mode);
  assert.equal(await hash(entry.target, true), expectedHash, 'Target edited while staging; retain temp, refuse overwrite');
  await rename(temp, entry.target); await syncDir(parent);
}
async function prepare() {
  const manifest = await provenance();
  await verifyCodexFailureCandidate(manifestPath);
  assert.equal(await realpath(backupParent), backupParent);
  // Exclusive directory reservation preserves earlier receipts even after interrupted preparation.
  await mkdir(backup, { mode: 0o700 }); await syncDir(backupParent);
  const entries = entriesFor(manifest);
  for (const entry of entries) {
    const proposed = await regular(join(candidate, entry.path)); assert.equal(sha(proposed.bytes), entry.afterHash);
    await durableNew(entry.newFile, proposed.bytes);
    const old = await regular(entry.target, true);
    assert.equal(old ? sha(old.bytes) : null, entry.beforeHash);
    entry.mode = old?.mode ?? proposed.mode; entry.state = 'PREPARED';
    if (old) await durableNew(entry.oldFile, old.bytes);
  }
  await verifyCodexFailureCandidate(manifestPath); await provenance();
  const receipt = { task: '38r1', state: 'PREPARED', multiFileAtomic: false, manifestPath, manifestHash, nativePath, nativeHash,
    tuiPath, tuiHash, sourceDigest: manifest.sourceDigest, packageMetadataChanged: false, createdAt: new Date().toISOString(), entries };
  await durableNew(ledgerPath, JSON.stringify(receipt, null, 2) + '\n'); await syncDir(backup);
  return receipt;
}
async function promote(id) {
  const manifest = await provenance(); let { receipt, ledgerHash } = await ledger(manifest);
  const entry = receipt.entries[id];
  // CLI calls must be serialized: every invocation proves the whole expected prefix before writing one file.
  for (const other of receipt.entries) if (other.id !== id) assert.equal(await hash(other.target, true), other.id < id ? other.afterHash : other.beforeHash, 'Promotion order or foreign edit conflict');
  const current = await hash(entry.target, true); assert(current === entry.beforeHash || current === entry.afterHash, 'Target differs from both known states');
  if (current === entry.beforeHash) {
    receipt.state = 'UNCERTAIN'; entry.state = 'UNCERTAIN'; ledgerHash = await saveReceipt(receipt, ledgerHash);
    await replaceFile(entry, (await regular(entry.newFile)).bytes, entry.beforeHash, entry.mode);
  }
  assert.equal(await hash(entry.target), entry.afterHash); entry.state = 'CHANGED'; receipt.state = 'PARTIAL';
  await saveReceipt(receipt, ledgerHash); return { id, target: entry.target, state: entry.state, multiFileAtomic: false };
}
async function verifyAll() {
  const manifest = await provenance(); const { receipt, ledgerHash } = await ledger(manifest);
  for (const file of manifest.generated) assert.equal(await hash(join(sdk, file.path)), file.afterSha256, 'Post-promotion output mismatch');
  for (const entry of receipt.entries) { assert.equal(await hash(entry.target), entry.afterHash); entry.state = 'CHANGED'; }
  receipt.state = 'VERIFIED'; receipt.verifiedAt = new Date().toISOString(); await saveReceipt(receipt, ledgerHash);
  return { state: 'VERIFIED', changed: 11, protectedSdk: 764, protectedTui: 6, packageMetadataChanged: false, multiFileAtomic: false,
    qualification: 'Byte/provenance proof only: MAIN must prove fresh-process observer identity; no daemon restart or inference executed.' };
}
async function rollback(id) {
  const manifest = await provenance(); let { receipt, ledgerHash } = await ledger(manifest); const entry = receipt.entries[id];
  for (const other of receipt.entries) if (other.id > id) assert.equal(await hash(other.target, true), other.beforeHash, 'Rollback must proceed in reverse publication order');
  const current = await hash(entry.target, true); assert(current === entry.afterHash || current === entry.beforeHash, 'Later SDK edit; refuse rollback');
  if (current !== entry.beforeHash && entry.beforeHash === null) {
    // New outputs are removed only by MAIN's recoverable trash tool, never unlink/rm here.
    return { state: 'TRASH_REQUIRED', id, exactTargetForNativeTrash: entry.target, expectedCurrentHash: entry.afterHash,
      next: `MAIN: recheck hash, use functions.trash for this exact path, then rerun --rollback-entry ${id}. No deletion was performed.` };
  }
  if (current !== entry.beforeHash) {
    receipt.state = 'UNCERTAIN'; entry.state = 'UNCERTAIN'; ledgerHash = await saveReceipt(receipt, ledgerHash);
    await replaceFile(entry, (await regular(entry.oldFile)).bytes, entry.afterHash, entry.mode);
  }
  assert.equal(await hash(entry.target, true), entry.beforeHash); entry.state = 'RESTORED'; receipt.state = 'ROLLBACK_PARTIAL';
  await saveReceipt(receipt, ledgerHash); return { id, target: entry.target, state: 'RESTORED', multiFileAtomic: false };
}
const help = `Task38 thin compiled-output rollout. SOURCE ONLY until MAIN explicitly executes.\nCalls must be serialized; rename is atomic per file, never across all11 files.\n--help                 read-only command catalog\n--plan                 read-only exact entry ordering/paths\n--prepare              exclusive durable backups + preflight, no SDK output edits\n--promote-entry N       one compiled output, ordered0..10, before-hash guards\n--verifyall             all12 outputs +764protected SDK +6TUI + native-source hashes\n--rollback-entry N      reverse10..0; existing7 restored by after-hash guard; new4 require MAIN native trash\nReceipt: ${ledgerPath}\nNo package metadata/lock/profile edits, npm, credentials, live APIs or daemon restart.\nHash guards detect observed foreign edits; operators must exclude simultaneous noncooperating edits during staging/rename.\nInterrupted temps/backup reservations are retained, never silently overwritten/deleted.\n`;
export async function runPromotionCommand(argv) {
  const [command, argument, ...extra] = argv;
  assert.equal(extra.length, 0, 'Unexpected arguments');
  if (command === '--help') { assert.equal(argument, undefined); return help; }
  if (command === '--plan') { assert.equal(argument, undefined); return { sdk, candidate, backup, entries: sequence.map((path, id) => ({ id, path, target: join(sdk, path) })) }; }
  if (command === '--prepare') { assert.equal(argument, undefined); return prepare(); }
  if (command === '--verifyall') { assert.equal(argument, undefined); return verifyAll(); }
  assert(['--promote-entry', '--rollback-entry'].includes(command), help);
  assert(typeof argument === 'string' && /^(?:[0-9]|10)$/.test(argument), 'Entry id must be0..10');
  return command === '--promote-entry' ? promote(Number(argument)) : rollback(Number(argument));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await runPromotionCommand(process.argv.slice(2)); console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
