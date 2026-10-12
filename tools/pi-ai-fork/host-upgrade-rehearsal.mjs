#!/usr/bin/env node
// Full npm upgrade -> reference-only promotion -> previous-fork rollback in a
// new private scratch directory. Never calls host install/promote/rollback and
// never mounts profiles, sessions, CredentialFile, or an LLM provider.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeArtifact, piName, sha256 } from './runtime.mjs';
import {
  assertSourcePin, compareLocks, comparePromotionLocks, compareRollbackLocks, copyRegularAssetOnce,
  treeHashes, verifyArtifact,
} from './host-install.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const root = '/home/alex/.local/share/dsh-cli';
const scoped = '@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
const receipt = await realpath(resolve(process.argv[2] ?? ''));
assert(receipt.startsWith(`${join(repo, '.dumps/pi-ai-fork')}/host-`) && basename(receipt) === 'receipt.json',
  'Usage: node tools/pi-ai-fork/host-upgrade-rehearsal.mjs <private-host-upgrade-receipt.json>');
const state = await json(receipt);
assert.equal(state.root, root);
assert.equal(state.phase, 'rehearsal-green', 'Scratch rehearsal must precede host installation');
assert.equal(state.transition?.mode, 'upgrade');
assert.equal(state.rollbackRehearsal?.passed, true, 'Previous-fork rollback rehearsal required');
const artifact = await describeArtifact(state.artifact);
assertSourcePin(artifact, 'upgrade');
assert.equal(artifact.artifactHash, state.artifactHash);
const previous = await describeArtifact(state.transition.previous.artifact);
assertSourcePin(previous, 'initial');
assert.equal(previous.artifactHash, state.transition.previous.artifactHash);
assert.equal(previous.provenance.integrity, state.transition.previous.integrity);
const dir = await mkdtemp(join(dirname(receipt), 'npm-upgrade-proof-'));
assert.equal(await realpath(dir), dir, 'Scratch target cannot redirect through a symlink');
const working = join(dir, 'host-fixture');
await mkdir(working, { mode: 0o700 });
const npm = (lockOnly = false) => {
  assert(working.startsWith(`${dir}/`) && working !== root, 'npm target must remain private scratch');
  execFileSync('npm', ['install', ...(lockOnly ? ['--package-lock-only'] : []), '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: working, stdio: 'inherit', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
};
async function hostUnchanged() {
  for (const name of ['package.json', 'package-lock.json']) {
    assert.equal(sha256(await readFile(join(root, name))), state.before[name], 'Host metadata moved during scratch rehearsal');
    assert.equal(sha256(await readFile(join(dirname(receipt), 'backup', name))), state.before[name], 'Snapshot metadata changed');
  }
  assert.deepEqual(await treeHashes(state.selectedBefore.directory), state.piTreeBefore, 'Host pi-ai moved during scratch rehearsal');
  for (const [name, hashes] of Object.entries(state.protectedPackages)) {
    assert.deepEqual(await treeHashes(join(root, 'node_modules', name)), hashes, `Protected host package changed: ${name}`);
  }
}
await hostUnchanged();
const backup = join(dirname(receipt), 'backup');
const originalLock = await json(join(backup, 'package-lock.json'));
const originalManifestBytes = await readFile(join(backup, 'package.json'));
const originalLockBytes = await readFile(join(backup, 'package-lock.json'));
await writeFile(join(working, 'package.json'), originalManifestBytes);
await writeFile(join(working, 'package-lock.json'), originalLockBytes);
npm();
const baselineLock = await json(join(working, 'package-lock.json'));
compareRollbackLocks(originalLock, baselineLock, working);
const packageDir = join(working, 'node_modules', piName);
assert.deepEqual(await treeHashes(packageDir), state.piTreeBefore);
const baselineProof = await verifyArtifact(packageDir, previous.artifact, dir);
assert.deepEqual(baselineProof, state.transition.previous.proof);

const reviewedManifest = await json(join(dirname(receipt), 'rehearsal/package.json'));
assert.deepEqual(reviewedManifest.overrides[scoped], { [piName]: `file:${artifact.artifact}` });
await save(join(working, 'package.json'), reviewedManifest);
// Simulate a crash after the manifest write, before npm: the baseline package
// must NOT pass the upgraded tree proof, even though the desired version is set.
await assert.rejects(verifyArtifact(packageDir, artifact.artifact, dir), /differs from exact artifact tree/);
npm();
const upgradedLock = await json(join(working, 'package-lock.json'));
const changes = compareLocks(baselineLock, upgradedLock);
assert.equal(changes.length, 1);
compareRollbackLocks(await json(join(dirname(receipt), 'rehearsal/package-lock.json')), upgradedLock,
  working, join(dirname(receipt), 'rehearsal'));
const upgradedProof = await verifyArtifact(packageDir, artifact.artifact, dir);
const upgradedTree = await treeHashes(packageDir);
const beforeModels = { ...state.catalogBefore.files };
const afterModels = await treeHashes(join(packageDir, 'dist/providers/data'));
delete beforeModels['.manifest.json'];
delete afterModels['.manifest.json'];
assert.deepEqual(afterModels, beforeModels, 'Scratch upgrade changed model JSON bytes');

// Promotion's destination is private scratch, NEVER the real host's durable
// directory. It exercises the same reference-only npm lock transformation.
const durable = join(dir, 'durable', artifact.artifactHash);
await mkdir(durable, { recursive: true, mode: 0o700 });
const promotedArtifact = join(durable, basename(artifact.artifact));
await copyRegularAssetOnce(promotedArtifact, await readFile(artifact.artifact));
await copyRegularAssetOnce(join(durable, 'provenance-original.json'), await readFile(join(dirname(artifact.artifact), 'provenance.json')));
await copyRegularAssetOnce(join(durable, 'provenance.json'), Buffer.from(`${JSON.stringify({ ...artifact.provenance, artifact: promotedArtifact }, null, 2)}\n`));
const promoted = await describeArtifact(promotedArtifact);
assert.equal(promoted.artifact, promotedArtifact, 'Scratch durable artifact must not redirect');
assertSourcePin(promoted, 'upgrade');
assert.equal(promoted.artifactHash, artifact.artifactHash);
const promotedManifest = structuredClone(reviewedManifest);
promotedManifest.overrides[scoped][piName] = `file:${promotedArtifact}`;
await save(join(working, 'package.json'), promotedManifest);
npm(true);
const promotedLock = await json(join(working, 'package-lock.json'));
assert.equal(comparePromotionLocks(upgradedLock, promotedLock).length, 1);
assert.deepEqual(await treeHashes(packageDir), upgradedTree, 'Scratch promotion edited installed package bytes');
assert.deepEqual(await verifyArtifact(packageDir, promotedArtifact, dir), upgradedProof);

// Restore the immutable baseline input, including its OLD scoped override.
// npm must install the previous local fork, not the published 0.87.1 package.
await writeFile(join(working, 'package.json'), originalManifestBytes);
await writeFile(join(working, 'package-lock.json'), originalLockBytes);
npm();
compareRollbackLocks(originalLock, await json(join(working, 'package-lock.json')), working);
assert.deepEqual(await readFile(join(working, 'package.json')), originalManifestBytes);
const restoredProof = await verifyArtifact(packageDir, previous.artifact, dir);
assert.deepEqual(restoredProof, baselineProof);
assert.deepEqual(await treeHashes(packageDir), state.piTreeBefore);
assert.equal((await json(join(packageDir, 'package.json'))).version, state.selectedBefore.version);
await hostUnchanged();
const report = { passed: true, receipt, scratch: dir, hostMetadataAndProtectedTreesUnchanged: true,
  hostNpmRuns: 0, llmRequests: 0, unchangedNonPiEntries: Object.keys(originalLock.packages).length - changes.length,
  upgradedVersion: artifact.provenance.version, rollbackVersion: state.selectedBefore.version,
  baselineProof, upgradedProof, restoredProof, catalogModelBytesUnchanged: true,
  partialManifestDidNotPassPostimage: true, promotionInstalledBytesUnchanged: true,
  reportPath: join(dir, 'report.json') };
await save(report.reportPath, report);
console.log(JSON.stringify(report, null, 2));
