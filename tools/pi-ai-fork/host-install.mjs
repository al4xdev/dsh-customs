import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, readdir, realpath, open, unlink, cp, chmod, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describeArtifact, adapterName, piName, sha256 } from './runtime.mjs';

const root = '/home/alex/.local/share/dsh-cli';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scoped = `${adapterName}@0.2.0-rc.2`;
// These are reviewed source identities, not an arbitrary checkout HEAD or an
// arbitrary package claiming our build-metadata suffix. A new fork needs review.
export const sourcePins = Object.freeze({
  initial: Object.freeze({
    commit: 'c043dedb60695f45fd9577ced676074f08d7f9b0',
    hash: '7f8948d3c423a04c12a134a193bf1593f2f98fcfbe1f89d63b11c92223c2b654',
    version: '0.87.1+alex.codex-default.7f8948d3c423',
  }),
  upgrade: Object.freeze({
    commit: 'f5a24c96d72732ba63aeca9a02295c320db04c2d',
    hash: '206545bfd51ee0284248e00b39fa5736e212d6b4ff8394bbf27013d1353c089b',
    version: '0.87.1+alex.codex-default.206545bfd51e',
    artifactHash: '796b9c3cd14936bd4c46a69ccf80fcdeafb7cdfa95477fddf4e2d58f16c7fd0c',
    integrity: 'sha512-hpkP/iOg2WlWRUuNwFvv3iBb+4xG2vRSx0f9W2/mkYL0hGDyJxo1SRnoKQpAooZ7J+kxwetwfmHsnixrQ93nGw==',
    catalogHash: '34a0a629dac6faaf21f5ba5729beec060c268693470f81d8e4f9491e6a0de7c7',
  }),
});
export const managedBaselinePin = Object.freeze({
  ...sourcePins.initial,
  artifactHash: 'ffebfb3695822db02a70d3b6a58519afc03db8537afa5fdcdabe1e4dd5f830c7',
  integrity: 'sha512-lQsvyQcK4N68s3/i/AGJShHb+bNnQ9PpkZwjepoWN9XAipTTlcQlG2Rc2ROh6zDye87oBwH/m5oUiYgAfah4Mw==',
});
const baselineArtifact = join(root, 'artifacts/pi-ai-fork', managedBaselinePin.artifactHash,
  `earendil-works-pi-ai-${managedBaselinePin.version}.tgz`);
const piLockPath = `node_modules/${piName}`;

export async function assertRegularAsset(path) {
  const metadata = await lstat(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), `Durable asset must be a regular non-symlink file: ${path}`);
  assert.equal(await realpath(path), resolve(path), `Durable asset path redirects: ${path}`);
  return metadata;
}

export async function copyRegularAssetOnce(path, bytes) {
  assert.equal(await realpath(dirname(path)), resolve(dirname(path)), 'Durable asset parent redirects');
  let created;
  try {
    created = await open(path, 'wx', 0o600);
    await created.writeFile(bytes);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const expected = await assertRegularAsset(path);
    // lstat rejects existing symlinks/devices; O_NOFOLLOW also closes the
    // lstat/read race, and NONBLOCK refuses a substituted FIFO without hanging.
    const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await existing.stat();
      assert(metadata.isFile(), `Durable asset is not a regular file: ${path}`);
      assert.equal(metadata.dev, expected.dev, 'Durable asset changed during verification');
      assert.equal(metadata.ino, expected.ino, 'Durable asset changed during verification');
      assert.deepEqual(await existing.readFile(), bytes, `Existing durable asset differs: ${path}`);
    } finally { await existing.close(); }
  } finally { await created?.close(); }
  await assertRegularAsset(path);
}

async function assertDurableAssets(artifact) {
  for (const path of [artifact, join(dirname(artifact), 'provenance.json'), join(dirname(artifact), 'provenance-original.json')]) {
    await assertRegularAsset(path);
  }
}

export function assertSourcePin(info, expected) {
  const pin = expected ? sourcePins[expected] : Object.values(sourcePins).find(pin => pin.commit === info.provenance.sourceCommit);
  assert(pin, 'Artifact source is not an approved fork commit');
  assert.equal(info.provenance.sourceCommit, pin.commit, 'Artifact source commit is not the reviewed pin');
  assert.equal(info.provenance.sourceHash, pin.hash, 'Artifact source hash is not the reviewed pin');
  assert.equal(info.provenance.version, pin.version, 'Artifact version is not the reviewed pin');
  if (pin.artifactHash) {
    assert.equal(info.artifactHash, pin.artifactHash, 'Artifact bytes are not the reviewed build');
    assert.equal(info.provenance.integrity, pin.integrity, 'Artifact integrity is not the reviewed build');
    assert.equal(info.provenance.catalogHash, pin.catalogHash, 'Artifact catalog is not the reviewed snapshot');
  }
  return pin;
}

export function validateManagedBaseline({ manifest, lock, selected, info }) {
  assertSourcePin(info, 'initial');
  assert.equal(info.artifact, baselineArtifact, 'Previous fork must be the exact durable managed artifact');
  assert.equal(info.artifactHash, managedBaselinePin.artifactHash, 'Previous artifact SHA256 changed');
  assert.equal(info.provenance.integrity, managedBaselinePin.integrity, 'Previous artifact SHA512 changed');
  assert.deepEqual(manifest.overrides?.[scoped], { [piName]: `file:${baselineArtifact}` }, 'Existing scoped override is unmanaged');
  const entries = Object.keys(lock.packages).filter(path => path.endsWith(`node_modules/${piName}`));
  assert.deepEqual(entries, [piLockPath], 'Expected exactly the managed host pi-ai instance');
  const entry = lock.packages[piLockPath];
  assert.equal(entry.version, managedBaselinePin.version, 'Previous lock version changed');
  assert.equal(entry.integrity, managedBaselinePin.integrity, 'Previous lock integrity changed');
  assert(entry.resolved?.startsWith('file:'), 'Previous lock must use its durable artifact');
  assert.equal(resolve(root, entry.resolved.slice(5)), baselineArtifact, 'Previous lock artifact changed');
  assert.equal(selected.version, managedBaselinePin.version, 'Installed previous fork version changed');
  assert.equal(selected.directory, join(root, 'node_modules', piName), 'Previous adapter resolves outside the managed host');
  assert.equal(selected.rootManifest, selected.manifest, 'Host root and adapter disagree on previous pi-ai');
  return { artifact: info.artifact, artifactHash: info.artifactHash,
    integrity: info.provenance.integrity, provenance: info.provenance };
}

export function validateTransition({ manifest, lock, selected, info, previous }) {
  assert.equal(manifest.dependencies['@deepseek-ai/dsh'], '^0.2.0-rc.2');
  assert.equal(manifest.dependencies.pnpm, '^11.22.0');
  if (manifest.overrides?.[scoped] === undefined) {
    assertSourcePin(info, 'initial');
    assert.equal(selected.version, '0.87.1', 'Initial install requires the published 0.87.1 baseline');
    assert.equal(lock.packages[piLockPath]?.version, '0.87.1');
    return { mode: 'initial' };
  }
  assertSourcePin(info, 'upgrade');
  assert(previous, 'An upgrade requires verified managed artifact evidence');
  return { mode: 'upgrade', previous: validateManagedBaseline({ manifest, lock, selected, info: previous }) };
}

// Scratch npm rebases local tarball URLs to its own cwd. Only that URL and npm's
// anonymous root name may differ; versions, integrities and all other bytes may not.
export function compareRollbackLocks(before, after, scratch, originalRoot = root) {
  const normalized = structuredClone(after);
  normalized.name = before.name;
  for (const [path, entry] of Object.entries(normalized.packages)) {
    if (!path.endsWith(`node_modules/${piName}`) || !entry.resolved?.startsWith('file:')) continue;
    const old = before.packages[path];
    assert(old?.resolved?.startsWith('file:'), 'Rollback changed the pi-ai artifact kind');
    assert.equal(resolve(scratch, entry.resolved.slice(5)), resolve(originalRoot, old.resolved.slice(5)), 'Rollback artifact URL drift');
    entry.resolved = old.resolved;
  }
  assert.deepEqual(normalized, before, 'Rollback lock drift');
  return normalized;
}
// The active host was installed with npm's peer resolution. legacy-peer-deps
// pruned 27 framework peers in rehearsal, so preserve the host's original policy.
const flags = ['--ignore-scripts', '--no-audit', '--no-fund'];
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const hashFile = async (path) => sha256(await readFile(path));
const npm = (cwd, lockOnly = false) => execFileSync('npm', ['install', ...(lockOnly ? ['--package-lock-only'] : []), ...flags], {
  cwd, stdio: 'inherit', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
});

// Inspect every lock entry, not just the root package. Initially no non-pi drift is
// permitted; a genuinely necessary dependency change needs a new explicit review.
export function compareLocks(before, after) {
  assert.equal(before.lockfileVersion, 3);
  assert.equal(after.lockfileVersion, 3);
  const changes = [];
  for (const key of new Set([...Object.keys(before.packages), ...Object.keys(after.packages)])) {
    if (!key) { assert.deepEqual(after.packages[key], before.packages[key]); continue; }
    const a = before.packages[key];
    const b = after.packages[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const pi = key.endsWith(`node_modules/${piName}`);
    // All metadata is held constant too: changed dependency ranges can hide upgrades.
    assert(pi, `Unexpected non-pi lock drift: ${key} (${a?.version} -> ${b?.version})`);
    assert(a && b, `Cannot add or remove a pi-ai instance: ${key}`);
    changes.push({ path: key, before: a ?? null, after: b ?? null });
  }
  assert(changes.length, 'Expected a pi-ai lock change');
  for (const [name, version] of [['@deepseek-ai/dsh', '0.2.0-rc.2'], ['pnpm', '11.22.0']]) {
    assert.equal(after.packages[`node_modules/${name}`].version, version, `Host pin changed: ${name}`);
  }
  const normalized = structuredClone(after);
  for (const change of changes) normalized.packages[change.path] = change.before;
  if (Object.hasOwn(before, 'name')) normalized.name = before.name;
  else delete normalized.name;
  assert.deepEqual(normalized, before, 'Unexpected top-level lock drift');
  return changes;
}

export async function treeHashes(path) {
  const result = {};
  async function visit(dir, prefix = '') {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules') continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(dir, entry.name), `${relative}/`);
      else if (entry.isSymbolicLink()) result[relative] = `link:${await realpath(join(dir, entry.name))}`;
      else result[relative] = await hashFile(join(dir, entry.name));
    }
  }
  await visit(path);
  return result;
}

async function protectedPackages() {
  const names = (await readdir(join(root, 'node_modules/@deepseek-ai'))).map((name) => `@deepseek-ai/${name}`);
  const adapter = await json(join(root, 'node_modules', adapterName, 'package.json'));
  names.push(...Object.keys(adapter.peerDependencies), 'pnpm');
  const result = {};
  for (const name of [...new Set(names)].sort()) result[name] = await treeHashes(join(root, 'node_modules', name));
  return result;
}

async function selectedPi() {
  assert(process.execArgv.includes('--experimental-import-meta-resolve'), 'Run with --experimental-import-meta-resolve');
  const parent = pathToFileURL(join(root, 'node_modules', adapterName, 'package.json')).href;
  async function packageFromEntry(parentURL) {
    const entry = await realpath(fileURLToPath(import.meta.resolve(piName, parentURL)));
    let directory = dirname(entry);
    while (directory !== dirname(directory)) {
      try {
        const metadata = await json(join(directory, 'package.json'));
        if (metadata.name === piName) return { entry, manifest: join(directory, 'package.json'), directory, version: metadata.version };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      directory = dirname(directory);
    }
    throw new Error(`Cannot locate pi-ai manifest from ${entry}`);
  }
  const selected = await packageFromEntry(parent);
  const rootSelected = await packageFromEntry(pathToFileURL(join(root, 'package.json')).href);
  return { adapterParent: parent, ...selected, rootManifest: rootSelected.manifest };
}

async function catalogSnapshot(directory) {
  const path = join(directory, 'dist/providers/data');
  return { path, files: await treeHashes(path) };
}

export async function verifyArtifact(directory, artifact, scratch) {
  const unpack = await mkdtemp(join(scratch, 'artifact-proof-'));
  execFileSync('tar', ['-xzf', artifact, '-C', unpack]);
  const expected = await treeHashes(join(unpack, 'package'));
  const actual = await treeHashes(directory);
  assert.deepEqual(actual, expected, 'Installed pi-ai package differs from exact artifact tree');
  return { filesCompared: Object.keys(expected).length, treeHash: sha256(JSON.stringify(expected)) };
}

async function guard(state, stage) {
  for (const name of ['package.json', 'package-lock.json']) {
    assert.equal(await hashFile(join(root, name)), state[stage][name], `Concurrent root change: ${name}`);
  }
  assert.deepEqual(await protectedPackages(), state.protectedPackages, 'Host adapter/framework/peer bytes changed');
  const expectedPi = stage === 'before' ? state.selectedBefore : state.selectedAfter;
  const expectedCatalog = stage === 'before' ? state.catalogBefore : state.catalogAfter;
  assert.deepEqual(await selectedPi(), expectedPi, 'Host pi-ai resolution changed concurrently');
  assert.deepEqual(await catalogSnapshot(expectedPi.directory), expectedCatalog, 'Host catalog changed concurrently');
  assert.deepEqual(await treeHashes(expectedPi.directory), stage === 'before' ? state.piTreeBefore : state.piTreeAfter,
    'Host pi-ai tree changed concurrently');
  if (state.transition?.mode === 'upgrade') await verifyPreviousArtifact(state);
}

async function verifyPreviousArtifact(state) {
  const previous = state.transition.previous;
  await assertDurableAssets(previous.artifact);
  const info = await describeArtifact(previous.artifact);
  assertSourcePin(info, 'initial');
  assert.equal(info.artifact, baselineArtifact);
  assert.equal(info.artifactHash, previous.artifactHash);
  assert.equal(info.provenance.integrity, previous.integrity);
  assert.deepEqual(info.provenance, previous.provenance, 'Previous durable provenance changed');
  if (previous.provenanceHash) assert.equal(await hashFile(join(dirname(info.artifact), 'provenance.json')), previous.provenanceHash);
}

async function verifyInputs(state, dir) {
  for (const name of ['package.json', 'package-lock.json']) {
    assert.equal(await hashFile(join(dir, 'backup', name)), state.before[name], `Backup changed: ${name}`);
    if (state.reviewed) assert.equal(await hashFile(join(dir, 'rehearsal', name)), state.reviewed[name], `Reviewed input changed: ${name}`);
  }
  assert.deepEqual(await treeHashes(join(dir, 'backup/pi-ai-original')), state.piTreeBefore, 'Previous package snapshot changed');
  if (state.transition?.mode === 'upgrade') await verifyPreviousArtifact(state);
}

async function reviewedArtifact(state) {
  const info = await describeArtifact(state.artifact);
  assertSourcePin(info, state.transition?.mode === 'upgrade' ? 'upgrade' : 'initial');
  assert.equal(info.provenance.integrity, state.integrity, 'Reviewed artifact integrity changed');
  if (state.artifactHash) assert.equal(info.artifactHash, state.artifactHash, 'Reviewed artifact SHA256 changed');
  return info;
}

async function trustedUpgradeSource(info) {
  if (info.provenance.sourceCommit !== sourcePins.upgrade.commit) return undefined;
  const checkout = '/home/alex/git/my/pi';
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
  assert.equal(git('branch', '--show-current'), 'fix/codex-implicit-reasoning-none', 'Build source is not the reviewed fork branch');
  assert.equal(git('rev-parse', 'HEAD'), sourcePins.upgrade.commit, 'Build checkout moved beyond the reviewed commit');
  const sourceTree = git('rev-parse', 'HEAD^{tree}');
  assert.equal(sourceTree, 'cdf74bf1c669dd6e5f0407343d53b1d82d870404', 'Build source tree is not the reviewed pin');
  assert.equal(git('status', '--porcelain=v1'), '', 'Build checkout has unreviewed changes');
  assert.equal(await hashFile(join(checkout, 'packages/ai/src/api/openai-codex-responses.ts')), sourcePins.upgrade.hash);
  return { checkout, branch: git('branch', '--show-current'), sourceCommit: sourcePins.upgrade.commit, sourceTree };
}

async function rehearsal(artifact) {
  const info = await describeArtifact(artifact);
  assertSourcePin(info);
  const sourceEvidence = await trustedUpgradeSource(info);
  const dir = join(repo, '.dumps/pi-ai-fork', `host-${Date.now()}-${process.pid}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const backup = join(dir, 'backup');
  const scratch = join(dir, 'rehearsal');
  await mkdir(backup, { mode: 0o700 });
  await mkdir(scratch, { mode: 0o700 });
  const state = { schema: 2, root, artifact: info.artifact, artifactHash: info.artifactHash,
    provenance: info.provenance, sourceEvidence, integrity: info.provenance.integrity, phase: 'snapshot', before: {} };
  for (const name of ['package.json', 'package-lock.json']) {
    const bytes = await readFile(join(root, name));
    state.before[name] = sha256(bytes);
    await writeFile(join(backup, name), bytes, { mode: 0o600 });
    await writeFile(join(scratch, name), bytes, { mode: 0o600 });
  }
  const manifest = await json(join(backup, 'package.json'));
  const beforeLock = await json(join(backup, 'package-lock.json'));
  state.protectedPackages = await protectedPackages();
  state.selectedBefore = await selectedPi();
  state.catalogBefore = await catalogSnapshot(state.selectedBefore.directory);
  state.piTreeBefore = await treeHashes(state.selectedBefore.directory);
  let previous;
  if (manifest.overrides?.[scoped] !== undefined) {
    await assertDurableAssets(baselineArtifact);
    previous = await describeArtifact(baselineArtifact);
  }
  state.transition = validateTransition({ manifest, lock: beforeLock, selected: state.selectedBefore, info, previous });
  if (state.transition.mode === 'upgrade') {
    state.transition.previous.provenanceHash = await hashFile(join(dirname(baselineArtifact), 'provenance.json'));
    state.transition.previous.proof = await verifyArtifact(state.selectedBefore.directory, previous.artifact, backup);
    await save(join(backup, 'previous-provenance.json'), previous.provenance);
  }
  manifest.overrides = { ...manifest.overrides, [scoped]: { [piName]: `file:${info.artifact}` } };
  await cp(state.selectedBefore.directory, join(backup, 'pi-ai-original'), {
    recursive: true, filter: (path) => !path.slice(state.selectedBefore.directory.length).split('/').includes('node_modules'),
  });
  async function secure(path) {
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) { await chmod(join(path, entry.name), 0o700); await secure(join(path, entry.name)); }
      else if (entry.isFile()) await chmod(join(path, entry.name), 0o600);
    }
  }
  await secure(join(backup, 'pi-ai-original'));
  await save(join(backup, 'pi-ai-original-hashes.json'), state.piTreeBefore);
  await save(join(backup, 'adapter-peers-framework-hashes.json'), state.protectedPackages);
  await save(join(backup, 'catalog-metadata.json'), state.catalogBefore);
  await save(join(dir, 'receipt.json'), state);
  await guard(state, 'before');
  await save(join(scratch, 'package.json'), manifest);
  npm(scratch, true);
  const afterLock = await json(join(scratch, 'package-lock.json'));
  state.changes = compareLocks(beforeLock, afterLock);
  assert(state.changes.some((change) => change.after?.integrity === state.integrity), 'Artifact missing from reviewed lock');
  await guard(state, 'before');
  state.reviewed = {};
  for (const name of ['package.json', 'package-lock.json']) state.reviewed[name] = await hashFile(join(scratch, name));
  state.phase = 'rehearsal-green';
  await save(join(dir, 'receipt.json'), state);
  console.log(JSON.stringify({ rehearsal: 'green', mode: state.transition.mode, receipt: join(dir, 'receipt.json'),
    previousVersion: state.selectedBefore.version, unchangedNonPiEntries: Object.keys(beforeLock.packages).length - state.changes.length,
    changes: state.changes }, null, 2));
}

async function apply(receipt) {
  const dir = dirname(receipt);
  const state = await json(receipt);
  assert.equal(state.root, root);
  assert.equal(state.phase, 'rehearsal-green');
  assert.equal(state.rollbackRehearsal?.passed, true, 'Rollback scratch rehearsal required');
  await reviewedArtifact(state);
  await verifyInputs(state, dir);
  await guard(state, 'before');
  state.phase = 'installing';
  await save(receipt, state);
  // Retain the original host lock as npm's input, exactly as in rehearsal. npm
  // regenerates the single pi entry using the correct host-relative file URL;
  // copying scratch-relative resolved URLs would point at a different tarball.
  await writeFile(join(root, 'package.json'), await readFile(join(dir, 'rehearsal/package.json')));
  npm(root);
  await completeInstall(state, dir);
  await save(receipt, state);
  console.log(JSON.stringify({ installed: true, receipt, selected: state.selectedAfter, proof: state.artifactProof,
    protectedPackagesUnchanged: true, catalogModelBytesUnchanged: true,
    catalogManifestRefreshed: state.catalogBefore.files['.manifest.json'] !== state.catalogAfter.files['.manifest.json'],
  }, null, 2));
}

// This also reconciles an interrupted install whose npm already finished. It
// proves the complete reviewed postimage; it never reruns npm or repairs bytes.
async function completeInstall(state, dir) {
  await verifyInputs(state, dir);
  const info = await reviewedArtifact(state);
  const actualLock = await json(join(root, 'package-lock.json'));
  compareLocks(await json(join(dir, 'backup/package-lock.json')), actualLock);
  const reviewedLock = await json(join(dir, 'rehearsal/package-lock.json'));
  // Anonymous root manifests get a lock-only name from npm's working directory.
  reviewedLock.name = (await json(join(dir, 'backup/package-lock.json'))).name;
  for (const [path, entry] of Object.entries(reviewedLock.packages)) {
    if (!path.endsWith(`node_modules/${piName}`) || !entry.resolved?.startsWith('file:')) continue;
    const actual = actualLock.packages[path];
    assert.equal(await realpath(resolve(root, actual.resolved.slice(5))), state.artifact);
    entry.resolved = actual.resolved;
  }
  assert.deepEqual(actualLock, reviewedLock, 'Install differs from reviewed lock beyond file URL rebasing');
  assert.equal(await hashFile(join(root, 'package.json')), state.reviewed['package.json']);
  assert.deepEqual(await protectedPackages(), state.protectedPackages);
  state.selectedAfter = await selectedPi();
  assert.equal(state.selectedAfter.version, info.provenance.version);
  assert.equal(state.selectedAfter.directory, state.selectedBefore.directory, 'Installed pi-ai moved outside the reviewed host location');
  assert.equal(state.selectedAfter.adapterParent, state.selectedBefore.adapterParent);
  assert.equal(state.selectedAfter.rootManifest, state.selectedAfter.manifest, 'Host root and adapter disagree after installation');
  state.artifactProof = await verifyArtifact(state.selectedAfter.directory, state.artifact, dir);
  state.piTreeAfter = await treeHashes(state.selectedAfter.directory);
  state.catalogAfter = await catalogSnapshot(state.selectedAfter.directory);
  const beforeModels = { ...state.catalogBefore.files };
  const afterModels = { ...state.catalogAfter.files };
  // Artifact refreshed the stale stamp in scratch; all actual model JSON bytes
  // must remain exact. The original stamp is backed up for rollback.
  delete beforeModels['.manifest.json'];
  delete afterModels['.manifest.json'];
  assert.deepEqual(afterModels, beforeModels, 'Local catalog model data changed');
  state.installed = {};
  for (const name of ['package.json', 'package-lock.json']) state.installed[name] = await hashFile(join(root, name));
  state.phase = 'installed';
}

export function comparePromotionLocks(before, after) {
  const changes = compareLocks(before, after);
  const normalized = structuredClone(after);
  for (const change of changes) {
    assert(change.before && change.after, 'Promotion cannot add/remove pi-ai instances');
    const entry = normalized.packages[change.path];
    assert(entry.resolved?.startsWith('file:'), 'Promotion must resolve to a local artifact');
    entry.resolved = change.before.resolved;
    assert.deepEqual(entry, change.before, 'Promotion changed pi-ai beyond its artifact URL');
  }
  normalized.name = before.name;
  assert.deepEqual(normalized, before, 'Promotion changed unrelated lock fields');
  return changes;
}

async function promote(receipt) {
  const state = await json(receipt);
  assert.equal(state.root, root);
  assert.equal(state.phase, 'installed');
  assert.equal(state.promotion, undefined, 'Artifact already promoted');
  await verifyInputs(state, dirname(receipt));
  await guard(state, 'installed');
  const info = await reviewedArtifact(state);
  assert.equal(info.provenance.integrity, state.integrity);
  const durableDir = join(root, 'artifacts/pi-ai-fork', info.artifactHash);
  await mkdir(durableDir, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(durableDir), durableDir, 'Durable artifact directory cannot redirect through symlinks');
  const durable = join(durableDir, basename(info.artifact));
  const originalProvenancePath = join(dirname(info.artifact), 'provenance.json');
  const originalProvenance = await readFile(originalProvenancePath);
  const durableProvenance = { ...info.provenance, artifact: durable,
    originalArtifact: info.artifact, originalProvenance: originalProvenancePath };
  await copyRegularAssetOnce(durable, await readFile(info.artifact));
  await copyRegularAssetOnce(join(durableDir, 'provenance-original.json'), originalProvenance);
  await copyRegularAssetOnce(join(durableDir, 'provenance.json'), Buffer.from(`${JSON.stringify(durableProvenance, null, 2)}\n`));
  await assertDurableAssets(durable);
  const durableInfo = await describeArtifact(durable);
  assert.equal(durableInfo.artifact, durable, 'Durable artifact canonical path must not redirect');
  assert.equal(durableInfo.artifactHash, info.artifactHash);
  assert.equal(durableInfo.provenance.integrity, state.integrity);
  const scratch = join(dirname(receipt), `promote-${Date.now()}`);
  await mkdir(scratch, { mode: 0o700 });
  const beforeManifestBytes = await readFile(join(root, 'package.json'));
  const beforeLockBytes = await readFile(join(root, 'package-lock.json'));
  const beforeManifest = JSON.parse(beforeManifestBytes);
  const beforeLock = JSON.parse(beforeLockBytes);
  assert.deepEqual(beforeManifest.overrides[scoped], { [piName]: `file:${info.artifact}` });
  const expectedManifest = structuredClone(beforeManifest);
  expectedManifest.overrides[scoped][piName] = `file:${durable}`;
  await writeFile(join(scratch, 'before-package.json'), beforeManifestBytes, { mode: 0o600 });
  await writeFile(join(scratch, 'before-package-lock.json'), beforeLockBytes, { mode: 0o600 });
  await save(join(scratch, 'package.json'), expectedManifest);
  await writeFile(join(scratch, 'package-lock.json'), beforeLockBytes, { mode: 0o600 });
  npm(scratch, true);
  const reviewedLock = await json(join(scratch, 'package-lock.json'));
  const rehearsalChanges = comparePromotionLocks(beforeLock, reviewedLock);
  for (const change of rehearsalChanges) {
    assert.equal(await realpath(resolve(scratch, change.after.resolved.slice(5))), durable);
    assert.equal(change.after.integrity, state.integrity);
  }
  // Promotion changes only package-manager references, never the installed tree.
  await guard(state, 'installed');
  state.promotion = { originalArtifact: info.artifact, originalProvenance: info.provenance,
    originalProvenanceHash: sha256(originalProvenance), durable, scratch,
    beforeHashes: { ...state.installed }, reviewedHashes: {
      'package.json': await hashFile(join(scratch, 'package.json')),
      'package-lock.json': await hashFile(join(scratch, 'package-lock.json')),
    }, rehearsalGreen: true, phase: 'applying' };
  state.phase = 'promoting';
  await save(receipt, state);
  await save(join(root, 'package.json'), expectedManifest);
  npm(root, true);
  await completePromotion(state, dirname(receipt));
  await save(receipt, state);
  console.log(JSON.stringify({ promoted: true, artifact: state.artifact, receipt,
    integrity: state.integrity, installedBytesUnchanged: true, allVersionsIntegritiesUnchanged: true }));
}

async function completePromotion(state, dir) {
  const { durable, scratch, reviewedHashes } = state.promotion;
  assert.equal(state.promotion.rehearsalGreen, true);
  for (const name of ['package.json', 'package-lock.json']) {
    if (reviewedHashes) assert.equal(await hashFile(join(scratch, name)), reviewedHashes[name], 'Promotion rehearsal changed');
    assert.equal(await hashFile(join(scratch, `before-${name}`)), state.promotion.beforeHashes[name], 'Promotion baseline changed');
  }
  await verifyInputs(state, dir);
  await assertDurableAssets(durable);
  const durableInfo = await describeArtifact(durable);
  assert.equal(durableInfo.artifact, durable, 'Durable artifact canonical path must not redirect');
  assertSourcePin(durableInfo, state.transition?.mode === 'upgrade' ? 'upgrade' : 'initial');
  assert.equal(durableInfo.artifactHash, state.artifactHash ?? (await describeArtifact(state.artifact)).artifactHash);
  assert.equal(durableInfo.provenance.integrity, state.integrity);
  const beforeLock = await json(join(scratch, 'before-package-lock.json'));
  const reviewedLock = await json(join(scratch, 'package-lock.json'));
  const expectedManifest = await json(join(scratch, 'package.json'));
  assert.deepEqual(expectedManifest.overrides[scoped], { [piName]: `file:${durable}` });
  const actualLock = await json(join(root, 'package-lock.json'));
  const actualChanges = comparePromotionLocks(beforeLock, actualLock);
  for (const change of actualChanges) {
    assert.equal(await realpath(resolve(root, change.after.resolved.slice(5))), durable);
    assert.equal(change.after.integrity, state.integrity);
    reviewedLock.packages[change.path].resolved = change.after.resolved;
  }
  reviewedLock.name = beforeLock.name;
  assert.deepEqual(actualLock, reviewedLock, 'Host promotion differs from reviewed lock');
  assert.deepEqual(await json(join(root, 'package.json')), expectedManifest);
  assert.deepEqual(await protectedPackages(), state.protectedPackages);
  assert.deepEqual(await selectedPi(), state.selectedAfter);
  assert.deepEqual(await treeHashes(state.selectedAfter.directory), state.piTreeAfter);
  assert.deepEqual(await catalogSnapshot(state.selectedAfter.directory), state.catalogAfter);
  const proof = await verifyArtifact(state.selectedAfter.directory, durable, scratch);
  assert.deepEqual(proof, state.artifactProof);
  state.artifact = durable;
  state.promotion.phase = 'promoted';
  state.promotion.proof = proof;
  for (const name of ['package.json', 'package-lock.json']) state.installed[name] = await hashFile(join(root, name));
  state.phase = 'installed';
}

async function rollback(receipt, scratchOnly) {
  const dir = dirname(receipt);
  const state = await json(receipt);
  assert.equal(state.root, root);
  assert(['installed', 'rehearsal-green'].includes(state.phase));
  await verifyInputs(state, dir);
  await reviewedArtifact(state);
  if (!scratchOnly) { assert.equal(state.phase, 'installed'); await guard(state, 'installed'); }
  const target = join(dir, `rollback-${Date.now()}`);
  await mkdir(target, { mode: 0o700 });
  for (const name of ['package.json', 'package-lock.json']) await writeFile(join(target, name), await readFile(join(dir, 'backup', name)));
  npm(target, true);
  const rollbackLock = await json(join(target, 'package-lock.json'));
  const originalLock = await json(join(dir, 'backup/package-lock.json'));
  compareRollbackLocks(originalLock, rollbackLock, target);
  let packageProof;
  if (state.transition?.mode === 'upgrade') {
    // Unlike a published upstream rollback, the baseline is itself a fork. A
    // real scratch install must restore that exact durable tarball, not 0.87.1.
    npm(target);
    compareRollbackLocks(originalLock, await json(join(target, 'package-lock.json')), target);
    packageProof = await verifyArtifact(join(target, 'node_modules', piName), state.transition.previous.artifact, target);
    assert.deepEqual(packageProof, state.transition.previous.proof, 'Scratch rollback did not restore the previous fork');
    assert.deepEqual(await treeHashes(join(target, 'node_modules', piName)), state.piTreeBefore);
  }
  await verifyInputs(state, dir);
  if (scratchOnly) {
    state.rollbackRehearsal = { passed: true, target, version: state.selectedBefore.version, packageProof };
    await save(receipt, state);
    console.log(JSON.stringify({ rollbackRehearsal: 'green', target, version: state.selectedBefore.version, packageProof })); return;
  }
  // Refuse intervening edits instead of overwriting unrelated user changes.
  await guard(state, 'installed');
  state.phase = 'rolling-back';
  await save(receipt, state);
  // Scratch file: URLs are cwd-relative. Restore the original reviewed host
  // inputs byte-for-byte, never the scratch-rebased rollback lock.
  for (const name of ['package.json', 'package-lock.json']) await writeFile(join(root, name), await readFile(join(dir, 'backup', name)));
  npm(root);
  for (const name of ['package.json', 'package-lock.json']) assert.equal(await hashFile(join(root, name)), state.before[name]);
  assert.deepEqual(await protectedPackages(), state.protectedPackages);
  assert.deepEqual(await selectedPi(), state.selectedBefore);
  // npm restores the baseline (published code OR the previous managed fork).
  // Only pre-existing local catalog DATA is restored
  // separately; never restore/edit installed provider or adapter source by hand.
  const oldCatalog = join(dir, 'backup/pi-ai-original/dist/providers/data');
  assert.deepEqual(await treeHashes(oldCatalog), state.catalogBefore.files, 'Catalog backup changed');
  await cp(oldCatalog, state.catalogBefore.path, { recursive: true });
  assert.deepEqual(await catalogSnapshot(state.selectedBefore.directory), state.catalogBefore);
  assert.deepEqual(await treeHashes(state.selectedBefore.directory), state.piTreeBefore, 'Rollback pi-ai tree mismatch');
  state.phase = 'rolled-back';
  await save(receipt, state);
  console.log(JSON.stringify({ rolledBack: true, receipt }));
}

export function recoveryTransition(phase, mode, verified) {
  assert(['installing', 'promoting', 'rolling-back'].includes(phase), 'Only an interrupted mutating phase can be reconciled');
  assert(['recover-before', 'recover-complete'].includes(mode), 'Choose an explicit recovery direction');
  assert.equal(verified, true, 'Recovery requires the complete exact preimage or postimage; partial/foreign bytes need new review');
  if (mode === 'recover-before') return phase === 'installing' ? 'rehearsal-green' : 'installed';
  return phase === 'rolling-back' ? 'rolled-back' : 'installed';
}

async function observation(state) {
  const observed = { root, phase: state.phase, rootHashes: {} };
  for (const name of ['package.json', 'package-lock.json']) {
    try { observed.rootHashes[name] = await hashFile(join(root, name)); }
    catch (error) { observed.rootHashes[name] = { code: error.code ?? 'OBSERVATION_FAILED' }; }
  }
  try { observed.protectedPackagesUnchanged = JSON.stringify(await protectedPackages()) === JSON.stringify(state.protectedPackages); }
  catch (error) { observed.protectedPackagesError = error.code ?? 'OBSERVATION_FAILED'; }
  try {
    observed.selected = await selectedPi();
    observed.piTreeHash = sha256(JSON.stringify(await treeHashes(observed.selected.directory)));
  } catch (error) { observed.piResolutionError = error.code ?? 'OBSERVATION_FAILED'; }
  observed.fingerprint = sha256(JSON.stringify(observed));
  return observed;
}

async function recover(receipt, mode) {
  const dir = dirname(receipt);
  const state = await json(receipt);
  assert.equal(state.root, root);
  const observed = await observation(state);
  if (mode === 'recover-inspect') {
    console.log(JSON.stringify({ receipt, observed, recoveryIsMetadataOnly: true,
      instructions: 'Choose recover-before or recover-complete only for a proven exact state. Partial npm changes are not repaired or retried.' }, null, 2));
    return;
  }
  recoveryTransition(state.phase, mode, true);
  await verifyInputs(state, dir);
  await reviewedArtifact(state);
  const interruptedPhase = state.phase;
  if (mode === 'recover-before') {
    await guard(state, state.phase === 'installing' ? 'before' : 'installed');
    if (state.phase === 'promoting') {
      state.interruptedPromotions = [...(state.interruptedPromotions ?? []), state.promotion];
      delete state.promotion;
    }
    state.phase = recoveryTransition(interruptedPhase, mode, true);
  } else if (state.phase === 'installing') await completeInstall(state, dir);
  else if (state.phase === 'promoting') await completePromotion(state, dir);
  else {
    // Initial rollback may have restored npm's published catalog but not the
    // user's local data yet. That is partial, not a license to overwrite it.
    await guard(state, 'before');
    state.phase = recoveryTransition(interruptedPhase, mode, true);
  }
  state.recoveries = [...(state.recoveries ?? []), { mode, interruptedPhase, phase: state.phase, observed, at: new Date().toISOString() }];
  await save(receipt, state);
  console.log(JSON.stringify({ recovered: true, receipt, phase: state.phase, hostPackageWrites: 0, npmRuns: 0 }));
}

async function recordFailure(receipt, mode, error) {
  // Keep the interrupted phase and record an inspectable fingerprint. Never
  // classify a failed npm as installed, rerun it, or discard the original inputs.
  try {
    const state = await json(receipt);
    state.failures = [...(state.failures ?? []), { mode, phase: state.phase,
      code: typeof error.code === 'string' ? error.code : 'HOST_OPERATION_FAILED',
      exitStatus: Number.isInteger(error.status) ? error.status : undefined,
      at: new Date().toISOString(), observed: await observation(state) }];
    await save(receipt, state);
  } catch {
    console.error('Could not append failure evidence; retain the receipt and inputs for manual inspection.');
  }
}

async function selfTest() {
  const { test } = await import('node:test');
  const before = { lockfileVersion: 3, packages: {
    '': { dependencies: { '@deepseek-ai/dsh': '^0.2.0-rc.2', pnpm: '^11.22.0' } },
    'node_modules/@deepseek-ai/dsh': { version: '0.2.0-rc.2', integrity: 'dsh' },
    'node_modules/pnpm': { version: '11.22.0', integrity: 'pnpm' },
    'node_modules/framework': { version: '1.0.0', integrity: 'framework' },
    [`node_modules/${piName}`]: { version: '0.87.1', integrity: 'published' },
  } };
  const after = structuredClone(before);
  after.packages[`node_modules/${piName}`] = { version: '0.87.1+patched', integrity: 'artifact' };
  await test('accepts only pi-ai replacement', () => assert.equal(compareLocks(before, after).length, 1));
  for (const [name, mutate] of [
    ['upgrade', (lock) => { lock.packages['node_modules/framework'].version = '2.0.0'; }],
    ['integrity drift', (lock) => { lock.packages['node_modules/framework'].integrity = 'drift'; }],
    ['peer removal', (lock) => { delete lock.packages['node_modules/framework']; }],
    ['new dependency', (lock) => { lock.packages['node_modules/new'] = { version: '1.0.0' }; }],
    ['root drift', (lock) => { lock.packages[''].dependencies.pnpm = 'latest'; }],
    ['wrong lock version', (lock) => { lock.lockfileVersion = 2; }],
  ]) {
    await test(`refuses ${name}`, () => {
      const changed = structuredClone(after);
      mutate(changed);
      assert.throws(() => compareLocks(before, changed));
    });
  }
}

async function main() {
  const [mode, input] = process.argv.slice(2);
  if (mode === '--self-test') { await selfTest(); return; }
  assert(['dry-run', 'install', 'promote', 'rollback', 'rollback-dry-run', 'recover-inspect', 'recover-before', 'recover-complete'].includes(mode) && input,
    'Usage: node --experimental-import-meta-resolve tools/pi-ai-fork/host-install.mjs dry-run <artifact.tgz> | install|promote|rollback|rollback-dry-run|recover-inspect|recover-before|recover-complete <receipt.json>');
  // Exclusive sentinel guards other invocations; content hashes also catch external
  // package managers. Failures preserve receipts and inputs for explicit recovery.
  const lockPath = join(root, '.pi-ai-host-install.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, mode }));
    if (mode === 'dry-run') await rehearsal(resolve(input));
    else {
      const receipt = await realpath(resolve(input));
      assert(receipt.startsWith(`${join(repo, '.dumps/pi-ai-fork')}/host-`), 'Receipt outside private host snapshots');
      try {
        if (mode === 'install') await apply(receipt);
        else if (mode === 'promote') await promote(receipt);
        else if (mode.startsWith('recover-')) await recover(receipt, mode);
        else await rollback(receipt, mode === 'rollback-dry-run');
      } catch (error) { await recordFailure(receipt, mode, error); throw error; }
    }
  } finally { await lock.close(); await unlink(lockPath); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
