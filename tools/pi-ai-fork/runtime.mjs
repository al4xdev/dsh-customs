import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const officialRootDefault = '/home/alex/.local/share/dsh-cli/node_modules';
export const adapterName = '@deepseek-ai/dsh-llm-pi-ai';
export const piName = '@earendil-works/pi-ai';
export const adapterVersion = '0.2.0-rc.2';
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const exists = async (path) => {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

export async function describeArtifact(input, officialInput = officialRootDefault) {
  assert(input, 'Usage: node tools/pi-ai-fork/runtime.mjs <artifact.tgz> [official-node_modules]');
  const artifact = await realpath(resolve(input));
  assert(artifact.endsWith('.tgz'), 'Expected an npm tarball (.tgz)');
  const bytes = await readFile(artifact);
  const provenance = await readJson(join(dirname(artifact), 'provenance.json'));
  assert.equal(await realpath(provenance.artifact), artifact, 'Provenance artifact mismatch');
  assert.equal(provenance.fork, 'https://github.com/al4xdev/pi');
  assert.equal(provenance.upstreamVersion, '0.87.1');
  assert.match(provenance.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(provenance.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    'Artifact integrity does not match provenance');
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(manifest.name, piName);
  assert.equal(manifest.version, provenance.version);
  assert.equal(manifest.version, `0.87.1+alex.codex-default.${provenance.sourceHash.slice(0, 12)}`);
  const officialRoot = await realpath(resolve(officialInput));
  const officialAdapter = await readJson(join(officialRoot, adapterName, 'package.json'));
  assert.equal(officialAdapter.name, adapterName);
  assert.equal(officialAdapter.version, adapterVersion);
  const artifactHash = sha256(bytes);
  // Host peer identity is part of the runtime identity, not just the patched source.
  const runtimeHash = sha256(JSON.stringify({ artifactHash, officialRoot, adapterVersion }));
  const runtime = join(repo, '.dumps/pi-ai-fork', `runtime-${runtimeHash.slice(0, 16)}`);
  return { artifact, artifactHash, runtimeHash, runtime, officialRoot, officialAdapter, provenance };
}

export function runtimeManifest(info) {
  return {
    name: 'alex-pi-ai-codex-isolated-runtime', private: true, type: 'module',
    dependencies: { [adapterName]: adapterVersion, [piName]: `file:${info.artifact}` },
    overrides: { [adapterName]: { [piName]: `$${piName}` } },
  };
}

export async function linkOfficialPeers(info) {
  const peers = Object.keys(info.officialAdapter.peerDependencies).sort();
  for (const name of peers) {
    const target = await realpath(join(info.officialRoot, name));
    const link = join(info.runtime, 'node_modules', name);
    if (await exists(link)) {
      assert((await lstat(link)).isSymbolicLink(), `Refusing duplicate peer installation: ${name}`);
      assert.equal(await realpath(link), target, `Peer points to another host: ${name}`);
    } else {
      await mkdir(dirname(link), { recursive: true });
      await symlink(target, link, 'dir');
    }
  }
  return peers;
}

export async function buildRuntime(artifact, officialRoot) {
  const info = await describeArtifact(artifact, officialRoot);
  const manifest = runtimeManifest(info);
  const receiptPath = join(info.runtime, 'runtime.json');
  if (await exists(info.runtime)) {
    // Never repair or overwrite a partially built runtime silently.
    assert(await exists(receiptPath), `Incomplete runtime ${info.runtime}; inspect it before retrying`);
    const previous = await readJson(receiptPath);
    assert.equal(previous.runtimeHash, info.runtimeHash);
    assert.deepEqual(await readJson(join(info.runtime, 'package.json')), manifest);
  } else {
    await mkdir(dirname(info.runtime), { recursive: true });
    await mkdir(info.runtime);
    await writeFile(join(info.runtime, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // legacy-peer-deps prevents npm from downloading the host-plane peers. Their
    // realpath symlinks are added only after npm finishes, so npm cannot replace them.
    const npmArgs = ['install', '--ignore-scripts', '--legacy-peer-deps', '--omit=dev', '--no-audit', '--no-fund'];
    execFileSync('npm', npmArgs, { cwd: info.runtime, stdio: 'inherit' });
    const peers = await linkOfficialPeers(info);
    await writeFile(receiptPath, `${JSON.stringify({
      artifact: info.artifact, artifactHash: info.artifactHash, runtimeHash: info.runtimeHash,
      runtime: info.runtime, officialRoot: info.officialRoot,
      adapter: `${adapterName}@${adapterVersion}`, peers, npmArgs,
      provenance: info.provenance,
    }, null, 2)}\n`);
  }
  // ESM parentURL resolution needs this flag; require.resolve is not a pi-ai proof.
  execFileSync(process.execPath, ['--experimental-import-meta-resolve',
    join(repo, 'tools/pi-ai-fork/verify.mjs'), info.artifact, info.officialRoot], { stdio: 'inherit' });
  return info;
}

async function selfTest() {
  const { test } = await import('node:test');
  await test('runtime manifest pins official adapter and tarball override', () => {
    const manifest = runtimeManifest({ artifact: '/scratch/fork.tgz' });
    assert.equal(manifest.dependencies[adapterName], adapterVersion);
    assert.equal(manifest.dependencies[piName], 'file:/scratch/fork.tgz');
    assert.equal(manifest.overrides[adapterName][piName], '$@earendil-works/pi-ai');
    assert.equal(manifest.private, true);
    assert.equal(manifest.scripts, undefined);
  });
  await test('missing artifact fails closed before installing', async () => {
    await assert.rejects(describeArtifact(), /Usage:/);
    await assert.rejects(describeArtifact('/nonexistent/pi-ai-test.tgz'), { code: 'ENOENT' });
  });
  await test('artifact byte hashes are deterministic and sensitive', () => {
    assert.equal(sha256(Buffer.from('fork')), sha256(Buffer.from('fork')));
    assert.notEqual(sha256(Buffer.from('fork')), sha256(Buffer.from('official')));
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--self-test') await selfTest();
  else {
    const info = await buildRuntime(process.argv[2], process.argv[3]);
    console.log(JSON.stringify({ runtime: info.runtime, artifactHash: info.artifactHash }, null, 2));
  }
}
