import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, runtimeArg, profileArg] = process.argv.slice(2);
assert(['install', 'verify-installed', 'rollback'].includes(mode), 'Usage: activate.mjs install|verify-installed|rollback <runtime-root> [profile-dir]');
const runtime = resolve(runtimeArg);
const profile = resolve(profileArg ?? '/home/alex/.dsh/profiles/dsh-tui');
const receipt = JSON.parse(await readFile(join(runtime, 'runtime.json'), 'utf8'));
const official = receipt.officialRoot;
assert.equal(official, '/home/alex/.local/share/dsh-cli/node_modules', 'Runtime must match the active DSH installation');
const adapter = '@deepseek-ai/dsh-llm-pi-ai';
const link = `link:${join(runtime, 'node_modules', adapter)}`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const snapshotDir = join(runtime, 'profile-backup');
const statePath = join(snapshotDir, 'state.json');
const packagePath = join(profile, 'package.json');
const beforeBytes = await readFile(packagePath);
const before = JSON.parse(beforeBytes);
const patchBytes = await readFile(join(profile, 'cordis.patch.yml'));
const operations = await import(pathToFileURL(join(official, '@deepseek-ai/dsh-plugin-manager/lib/types/operations.js')));
const execution = process.env.PIAI_PACKAGE_EXECUTION ?? 'service';
assert(['service', 'cli'].includes(execution));
const managerOptions = {
  execution, command: '/home/alex/.local/share/dsh-cli/node_modules/.bin/pnpm',
  outputBytes: 16384, activateNewBundles: false, lockWaitMs: 120000, idleTimeoutMs: 120000,
};
const context = { profile: 'dsh-tui', dir: profile, cwd: runtime,
  installAnchor: join(official, '@deepseek-ai/dsh/package.json') };

if (mode === 'install') {
  const report = JSON.parse(await readFile(join(runtime, 'live-report.json'), 'utf8'));
  for (const field of ['live', 'passed', 'probePassed', 'compactNowPassed', 'durableReplayPassed']) {
    assert.equal(report[field], true, `Refusing activation without successful live compaction: ${field}`);
  }
  assert.equal(report.calls, 2);
  assert.equal(before.dependencies?.[adapter], undefined, 'Adapter already has a profile override; inspect it before replacing');
  await access(join(runtime, 'node_modules', adapter, 'package.json'));
  await mkdir(snapshotDir);
  const snapshots = {};
  for (const name of ['package.json', 'pnpm-lock.yaml', 'node_modules/.package-map.json']) {
    let bytes;
    try { bytes = await readFile(join(profile, name)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      snapshots[name] = null; continue;
    }
    const savedName = name.replaceAll('/', '_');
    await writeFile(join(snapshotDir, savedName), bytes, { mode: 0o600, flag: 'wx' });
    snapshots[name] = { hash: hash(bytes), savedName };
  }
  assert.equal(hash(await readFile(packagePath)), hash(beforeBytes), 'Profile changed during snapshot');
  await writeFile(statePath, `${JSON.stringify({ profile, link, snapshots, phase: 'prepared' }, null, 2)}\n`, { flag: 'wx' });
  const result = await operations.runPluginCommand(context, ['add', `${adapter}@${link}`, '--ignore-scripts'], managerOptions);
  assert.equal(result.exitCode, 0, `Profile install failed; inspect ${result.logPath}`);
  const after = JSON.parse(await readFile(packagePath));
  assert.equal(after.dependencies[adapter], link);
  const withoutOverride = structuredClone(after);
  delete withoutOverride.dependencies[adapter];
  assert.deepEqual(withoutOverride, before, 'Profile install changed unrelated manifest fields');
  assert.deepEqual(await readFile(join(profile, 'cordis.patch.yml')), patchBytes, 'Profile patch changed unexpectedly');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.phase = 'installed';
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify({ installed: true, profile, restartRequired: true, backup: snapshotDir }));
} else if (mode === 'verify-installed') {
  // A package manager can save valid files and then time out while exiting.
  // Reconcile the receipt only after independent, read-only actual-profile proof.
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.profile, profile);
  assert.equal(state.link, link);
  assert.equal(before.dependencies?.[adapter], link);
  const original = JSON.parse(await readFile(join(snapshotDir, state.snapshots['package.json'].savedName), 'utf8'));
  const expectedOriginal = structuredClone(before);
  delete expectedOriginal.dependencies[adapter];
  assert.deepEqual(expectedOriginal, original, 'Unrelated profile changes need manual review');
  const live = JSON.parse(await readFile(join(runtime, 'live-report.json'), 'utf8'));
  for (const field of ['live', 'passed', 'probePassed', 'compactNowPassed', 'durableReplayPassed']) assert.equal(live[field], true);
  const proof = JSON.parse(await readFile(join(runtime, 'actual-profile-verification.json'), 'utf8'));
  assert.equal(proof.actualProfileVerified, true);
  assert.equal(resolve(proof.router.profileDir), profile);
  assert.equal(proof.router.manifestHash, hash(beforeBytes), 'Actual-profile proof is stale');
  state.phase = 'installed';
  state.reconciledAfterManagerFailure = true;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify({ installed: true, profile, restartRequired: true, independentlyVerified: true }));
} else {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.profile, profile);
  assert.equal(before.dependencies?.[adapter], state.link, 'Override changed since activation; refusing rollback');
  // Use the official manager to remove just our dependency and update generated state.
  // Do not restore whole manifests: they may contain newer edits from other sessions.
  const result = await operations.runPluginCommand(context, ['remove', adapter, '--config.ignore-scripts=true'], managerOptions);
  assert.equal(result.exitCode, 0, `Rollback failed; inspect ${result.logPath}`);
  const after = JSON.parse(await readFile(packagePath));
  const expected = structuredClone(before);
  delete expected.dependencies[adapter];
  assert.deepEqual(after, expected, 'Rollback changed unrelated manifest fields');
  assert.deepEqual(await readFile(join(profile, 'cordis.patch.yml')), patchBytes);
  state.phase = 'rolled-back';
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  console.log(JSON.stringify({ rolledBack: true, profile, restartRequired: true }));
}
