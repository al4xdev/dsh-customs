import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  assertRegularAsset, assertSourcePin, compareLocks, comparePromotionLocks, compareRollbackLocks, copyRegularAssetOnce,
  managedBaselinePin, recoveryTransition, sourcePins, validateManagedBaseline, validateTransition,
} from './host-install.mjs';

const root = '/home/alex/.local/share/dsh-cli';
const pi = '@earendil-works/pi-ai';
const scoped = '@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2';
const piPath = `node_modules/${pi}`;
const previousArtifact = join(root, 'artifacts/pi-ai-fork', managedBaselinePin.artifactHash,
  `earendil-works-pi-ai-${managedBaselinePin.version}.tgz`);
function info(pin, artifact = '/scratch/approved.tgz') {
  return { artifact, artifactHash: pin.artifactHash ?? 'new-artifact', provenance: {
    sourceCommit: pin.commit, sourceHash: pin.hash, version: pin.version,
    integrity: pin.integrity ?? 'new-integrity', catalogHash: pin.catalogHash,
  } };
}
function fixture() {
  const manifest = { dependencies: { '@deepseek-ai/dsh': '^0.2.0-rc.2', pnpm: '^11.22.0' },
    overrides: { [scoped]: { [pi]: `file:${previousArtifact}` } } };
  const lock = { name: 'dsh-cli', lockfileVersion: 3, packages: {
    '': { dependencies: manifest.dependencies },
    'node_modules/@deepseek-ai/dsh': { version: '0.2.0-rc.2', integrity: 'dsh' },
    'node_modules/pnpm': { version: '11.22.0', integrity: 'pnpm' },
    [piPath]: { version: managedBaselinePin.version, integrity: managedBaselinePin.integrity,
      resolved: `file:${relative(root, previousArtifact)}`, dependencies: { telemetry: '0.87.1' } },
  } };
  // Match the real 610-entry host: one pi-ai and 609 protected lock entries.
  for (let i = 0; i < 606; i++) lock.packages[`node_modules/peer-${i}`] = { version: '1.0.0', integrity: `peer-${i}` };
  const directory = join(root, 'node_modules', pi);
  const selected = { directory, version: managedBaselinePin.version,
    manifest: join(directory, 'package.json'), rootManifest: join(directory, 'package.json') };
  return { manifest, lock, selected, info: info(sourcePins.upgrade), previous: info(managedBaselinePin, previousArtifact) };
}

test('approves only the reviewed source commit, full hash and version', () => {
  assert.equal(assertSourcePin(info(sourcePins.initial)), sourcePins.initial);
  assert.equal(assertSourcePin(info(sourcePins.upgrade)), sourcePins.upgrade);
  for (const [field, value] of [['sourceCommit', 'f'.repeat(40)], ['sourceHash', 'a'.repeat(64)], ['version', '0.87.1+alex.codex-default.aaaaaaaaaaaa']]) {
    const changed = info(sourcePins.upgrade);
    changed.provenance[field] = value;
    assert.throws(() => assertSourcePin(changed));
  }
});

test('approved source metadata cannot authorize different artifact or catalog bytes', () => {
  for (const mutate of [
    x => { x.artifactHash = 'a'.repeat(64); },
    x => { x.provenance.integrity = 'different-build'; },
    x => { x.provenance.catalogHash = 'a'.repeat(64); },
  ]) {
    const changed = info(sourcePins.upgrade);
    mutate(changed);
    assert.throws(() => assertSourcePin(changed));
  }
});

test('initial c043 install remains supported only over published upstream', () => {
  const f = fixture();
  delete f.manifest.overrides;
  f.selected.version = '0.87.1';
  f.lock.packages[piPath].version = '0.87.1';
  f.info = info(sourcePins.initial);
  assert.deepEqual(validateTransition(f), { mode: 'initial' });
  f.info = info(sourcePins.upgrade);
  assert.throws(() => validateTransition(f), /reviewed pin/);
});

test('upgrade retains the exact managed fork as its rollback baseline', () => {
  const f = fixture();
  const transition = validateTransition(f);
  assert.equal(transition.mode, 'upgrade');
  assert.equal(transition.previous.artifact, previousArtifact);
  assert.equal(transition.previous.provenance.version, managedBaselinePin.version);
  assert.notEqual(transition.previous.provenance.version, '0.87.1');
  assert.equal(Object.keys(f.lock.packages).length, 610);
});

for (const [name, mutate] of [
  ['unmanaged override', f => { f.manifest.overrides[scoped][pi] = 'file:/scratch/unmanaged.tgz'; }],
  ['extra scoped override', f => { f.manifest.overrides[scoped].other = '1.0.0'; }],
  ['missing prior evidence', f => { delete f.previous; }],
  ['non-durable prior artifact', f => { f.previous.artifact = '/scratch/previous.tgz'; }],
  ['previous SHA256 mismatch', f => { f.previous.artifactHash = 'a'.repeat(64); }],
  ['previous SHA512 mismatch', f => { f.previous.provenance.integrity = 'wrong'; }],
  ['previous source pin mismatch', f => { f.previous.provenance.sourceCommit = sourcePins.upgrade.commit; }],
  ['previous source hash mismatch', f => { f.previous.provenance.sourceHash = 'a'.repeat(64); }],
  ['lock baseline downgraded to upstream', f => { f.lock.packages[piPath].version = '0.87.1'; }],
  ['lock baseline integrity mismatch', f => { f.lock.packages[piPath].integrity = 'wrong'; }],
  ['lock artifact URL mismatch', f => { f.lock.packages[piPath].resolved = 'file:/scratch/wrong.tgz'; }],
  ['installed version mismatch', f => { f.selected.version = '0.87.1'; }],
  ['installed resolution outside host', f => { f.selected.directory = '/scratch/pi-ai'; }],
  ['root/adapter identity mismatch', f => { f.selected.rootManifest = '/scratch/other/package.json'; }],
  ['duplicate pi-ai instance', f => { f.lock.packages[`node_modules/other/${piPath}`] = structuredClone(f.lock.packages[piPath]); }],
  ['old artifact pretending to be upgrade', f => { f.info = info(sourcePins.initial); }],
]) {
  test(`rejects ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.throws(() => validateTransition(f));
  });
}

test('baseline validator accepts only the exact durable reviewed previous artifact', () => {
  const f = fixture();
  assert.equal(validateManagedBaseline({ ...f, info: f.previous }).artifactHash, managedBaselinePin.artifactHash);
});

test('upgrade changes exactly one pi-ai and keeps 609 other lock entries', () => {
  const f = fixture();
  const after = structuredClone(f.lock);
  after.packages[piPath] = { ...after.packages[piPath], version: sourcePins.upgrade.version,
    resolved: 'file:/scratch/new.tgz', integrity: 'new-integrity' };
  assert.equal(compareLocks(f.lock, after).length, 1);
  assert.equal(Object.keys(after.packages).length - 1, 609);
  for (const mutate of [
    l => { l.packages['node_modules/peer-605'].version = '2.0.0'; },
    l => { l.packages['node_modules/peer-605'].integrity = 'drift'; },
    l => { l.packages['node_modules/peer-605'].dependencies = { hidden: '2.0.0' }; },
    l => { delete l.packages['node_modules/peer-605']; },
    l => { l.packages['node_modules/new-peer'] = { version: '1.0.0' }; },
    l => { delete l.packages[piPath]; },
    l => { l.packages[`node_modules/new/${piPath}`] = structuredClone(l.packages[piPath]); },
  ]) {
    const changed = structuredClone(after);
    mutate(changed);
    assert.throws(() => compareLocks(f.lock, changed));
  }
});

test('scratch rollback only rebases the SAME previous fork artifact URL', () => {
  const f = fixture();
  const scratch = '/home/alex/git/my/dsh-customs/.dumps/pi-ai-fork/host-test/rollback-test';
  const after = structuredClone(f.lock);
  after.name = 'rollback-test';
  after.packages[piPath].resolved = `file:${relative(scratch, previousArtifact)}`;
  assert.deepEqual(compareRollbackLocks(f.lock, after, scratch), f.lock);
  for (const mutate of [
    l => { l.packages[piPath].version = '0.87.1'; },
    l => { l.packages[piPath].integrity = 'upstream'; },
    l => { l.packages[piPath].resolved = 'file:/scratch/upstream.tgz'; },
    l => { l.packages['node_modules/peer-605'].version = '2.0.0'; },
  ]) {
    const changed = structuredClone(after);
    mutate(changed);
    assert.throws(() => compareRollbackLocks(f.lock, changed, scratch));
  }
});

test('promotion preserves the version, integrity, dependencies and package count', () => {
  const f = fixture();
  const after = structuredClone(f.lock);
  after.packages[piPath].resolved = 'file:/another/durable/artifact.tgz';
  assert.equal(comparePromotionLocks(f.lock, after).length, 1);
  for (const field of ['version', 'integrity', 'dependencies']) {
    const changed = structuredClone(after);
    changed.packages[piPath][field] = field === 'dependencies' ? {} : 'changed';
    assert.throws(() => comparePromotionLocks(f.lock, changed));
  }
});

test('interrupted recovery requires complete proof and an explicit direction', () => {
  assert.equal(recoveryTransition('installing', 'recover-before', true), 'rehearsal-green');
  assert.equal(recoveryTransition('installing', 'recover-complete', true), 'installed');
  assert.equal(recoveryTransition('promoting', 'recover-before', true), 'installed');
  assert.equal(recoveryTransition('promoting', 'recover-complete', true), 'installed');
  assert.equal(recoveryTransition('rolling-back', 'recover-before', true), 'installed');
  assert.equal(recoveryTransition('rolling-back', 'recover-complete', true), 'rolled-back');
  for (const phase of ['installing', 'promoting', 'rolling-back']) {
    assert.throws(() => recoveryTransition(phase, 'recover-complete', false), /partial\/foreign/);
    assert.throws(() => recoveryTransition(phase, 'install', true), /explicit/);
  }
  assert.throws(() => recoveryTransition('installed', 'recover-complete', true), /interrupted/);
});

async function durableFixture() {
  const parent = '/home/alex/git/my/dsh-customs/.dumps/pi-ai-fork/upgrade-asset-tests';
  await mkdir(parent, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(parent), parent);
  const dir = await mkdtemp(join(parent, 'fixture-'));
  assert.equal(await realpath(dir), dir);
  // Fixtures remain in the ignored private dump; no delete/move targets exist.
  const durable = join(dir, 'durable');
  const ephemeral = join(dir, 'ephemeral');
  await mkdir(durable);
  await mkdir(ephemeral);
  return { durable, ephemeral, bytes: Buffer.from('valid asset fixture bytes') };
}

test('durable promotion creates and safely reuses identical regular files', async () => {
  const f = await durableFixture();
  for (const name of ['package.tgz', 'provenance.json', 'provenance-original.json']) {
    const path = join(f.durable, name);
    await copyRegularAssetOnce(path, f.bytes);
    await copyRegularAssetOnce(path, f.bytes);
    assert((await assertRegularAsset(path)).isFile());
    assert.deepEqual(await readFile(path), f.bytes);
    await assert.rejects(copyRegularAssetOnce(path, Buffer.from('different')), /asset differs/);
  }
});

for (const name of ['package.tgz', 'provenance.json', 'provenance-original.json']) {
  test(`durable promotion refuses ${name} symlink even with valid equal bytes`, async () => {
    const f = await durableFixture();
    const target = join(f.ephemeral, name);
    const link = join(f.durable, name);
    await writeFile(target, f.bytes);
    await symlink(target, link);
    await assert.rejects(copyRegularAssetOnce(link, f.bytes), /regular non-symlink/);
    await assert.rejects(assertRegularAsset(link), /regular non-symlink/);
    assert.deepEqual(await readFile(target), f.bytes);
  });
}

test('durable promotion refuses directory and device assets', async () => {
  const f = await durableFixture();
  const directory = join(f.durable, 'not-a-file');
  await mkdir(directory);
  await assert.rejects(copyRegularAssetOnce(directory, f.bytes), /regular non-symlink/);
  await assert.rejects(assertRegularAsset('/dev/null'), /regular non-symlink/);
});

test('top-level lock metadata cannot drift during an otherwise valid upgrade', () => {
  const f = fixture();
  const after = structuredClone(f.lock);
  after.packages[piPath].version = sourcePins.upgrade.version;
  after.unreviewedTopLevel = true;
  assert.throws(() => compareLocks(f.lock, after), /top-level lock drift/);
});
