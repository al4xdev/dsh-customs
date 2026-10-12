import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, getEnvironmentData, isMainThread, parentPort, setEnvironmentData, workerData } from 'node:worker_threads';
import { adapterName, adapterVersion, describeArtifact, exists, piName, readJson, runtimeManifest, sha256 } from './runtime.mjs';

const url = (path) => pathToFileURL(path).href;
const resolveFrom = (specifier, parent) => import.meta.resolve(specifier, url(parent));
export function assertInside(root, path) {
  const rel = relative(root, path);
  assert(rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep)),
    `Module escaped expected package: ${path} (root ${root})`);
}

// Published adapter/pi output has literal ESM imports. This scans all its static
// and lazy imports; the explicit Codex chain below guards against a silent miss.
export function literalImports(source) {
  return [...new Set([...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g)]
    .map((match) => match[1]))];
}

async function adapterBytesProof(installed, official) {
  let files = 0;
  async function compare(local, host) {
    const [localEntries, hostEntries] = await Promise.all([readdir(local), readdir(host)]);
    assert.deepEqual(localEntries.sort(), hostEntries.sort(), `Official adapter file list changed: ${local}`);
    for (const name of hostEntries) {
      const actual = join(local, name);
      const expected = join(host, name);
      const stat = await lstat(expected);
      if (stat.isDirectory()) await compare(actual, expected);
      else {
        assert(stat.isFile() && (await lstat(actual)).isFile(), `Non-regular adapter file: ${actual}`);
        assert.equal(sha256(await readFile(actual)), sha256(await readFile(expected)), `Official adapter byte drift: ${actual}`);
        files++;
      }
    }
  }
  await compare(installed, official);
  return files;
}

async function artifactBytesProof(info, piRoot) {
  const entries = execFileSync('tar', ['-tzf', info.artifact], { encoding: 'utf8' }).trim().split('\n');
  let files = 0;
  for (const entry of entries) {
    assert(entry.startsWith('package/'), `Unexpected archive entry: ${entry}`);
    const local = join(piRoot, entry.slice('package/'.length));
    assertInside(piRoot, local);
    if (entry.endsWith('/')) continue;
    assert((await lstat(local)).isFile(), `Artifact entry is not an installed regular file: ${local}`);
    const expected = execFileSync('tar', ['-xOf', info.artifact, entry], { maxBuffer: 32 * 1024 * 1024 });
    assert.equal(sha256(await readFile(local)), sha256(expected), `Installed artifact byte drift: ${entry}`);
    files++;
  }
  assert(files > 0);
  return files;
}

async function noDuplicatePeers(modules, peers, officialRoot) {
  let packages = 0;
  async function scan(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(root, entry.name);
      if (entry.name.startsWith('@') && entry.isDirectory()) { await scan(path); continue; }
      if (!await exists(join(path, 'package.json'))) continue;
      const manifest = await readJson(join(path, 'package.json'));
      packages++;
      if (peers.has(manifest.name)) {
        assert((await lstat(path)).isSymbolicLink(), `Duplicate host peer: ${path}`);
        assert.equal(await realpath(path), await realpath(join(officialRoot, manifest.name)));
      }
      // Do not walk official symlinks (their dependency graph belongs to the host).
      if (entry.isDirectory() && await exists(join(path, 'node_modules'))) await scan(join(path, 'node_modules'));
    }
  }
  await scan(modules);
  return packages;
}

async function resolutionProof(info, profileDir) {
  assert(process.execArgv.includes('--experimental-import-meta-resolve'),
    'Run verify.mjs with --experimental-import-meta-resolve; parentURL must not be ignored');
  const adapterRoot = await realpath(join(info.runtime, 'node_modules', adapterName));
  const adapterEntry = join(adapterRoot, 'lib/index.js');
  const piRoot = await realpath(join(info.runtime, 'node_modules', piName));
  const officialAnchor = join(info.officialRoot, adapterName, 'package.json');
  const adapterURL = resolveFrom(adapterName, join(profileDir ?? info.runtime, 'package.json'));
  assert.equal(await realpath(fileURLToPath(adapterURL)), await realpath(adapterEntry),
    'Profile ESM resolution did not select the isolated adapter');
  const adapter = await import(adapterURL);
  assert.equal(adapter.name, 'llm-pi-ai');
  assert.equal(typeof adapter.apply, 'function');
  const peers = [];
  for (const name of Object.keys(info.officialAdapter.peerDependencies).sort()) {
    const actual = resolveFrom(name, adapterEntry);
    const expected = resolveFrom(name, officialAnchor);
    assert.equal(actual, expected, `Peer ESM resolution drift: ${name}`);
    const [localModule, hostModule] = await Promise.all([import(actual), import(expected)]);
    assert.strictEqual(localModule, hostModule, `Peer namespace identity drift: ${name}`);
    const functions = Object.keys(hostModule).filter((key) => typeof hostModule[key] === 'function');
    for (const key of functions) assert.strictEqual(localModule[key], hostModule[key], `${name}.${key} identity drift`);
    peers.push({ name, resolved: actual, namespaceIdentity: true, functionIdentities: functions });
  }
  const source = await readFile(adapterEntry, 'utf8');
  const adapterPiImports = literalImports(source).filter((request) => request === piName || request.startsWith(`${piName}/`));
  assert(adapterPiImports.length > 0, 'No adapter pi-ai imports discovered');
  const graph = [];
  const visited = new Set();
  async function visit(request, parent) {
    const target = resolveFrom(request, parent);
    const path = await realpath(fileURLToPath(target));
    assertInside(piRoot, path);
    graph.push({ request, parent: url(parent), resolved: target });
    if (visited.has(path)) return target;
    visited.add(path);
    if (!path.endsWith('.js')) return target;
    for (const child of literalImports(await readFile(path, 'utf8'))) {
      if (child.startsWith('.') || child === piName || child.startsWith(`${piName}/`)) await visit(child, path);
    }
    return target;
  }
  for (const request of adapterPiImports) await visit(request, adapterEntry);
  const providerURL = await visit(`${piName}/providers/openai-codex`, adapterEntry);
  const providerPath = fileURLToPath(providerURL);
  const lazyURL = await visit('../api/openai-codex-responses.lazy.js', providerPath);
  const lazyPath = fileURLToPath(lazyURL);
  assert(literalImports(await readFile(lazyPath, 'utf8')).includes('./openai-codex-responses.js'));
  const implementationURL = await visit('./openai-codex-responses.js', lazyPath);
  const lazy = await import(lazyURL);
  const implementation = await import(implementationURL);
  assert.equal(typeof implementation.streamSimple, 'function');
  const providerModule = await import(providerURL);
  const provider = providerModule.openaiCodexProvider();
  // A fake token and a payload hook terminate before transport/auth discovery.
  // Exercise the actual provider lazy path, not a text-only patch assertion.
  const apiKey = `test.${Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-offline-proof' },
  })).toString('base64url')}.test`;
  const model = {
    id: 'gpt-6.1-sol', name: 'Synthetic Codex', api: 'openai-codex-responses',
    provider: 'openai-codex', baseUrl: 'https://invalid.example.test', reasoning: true,
    input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 4096,
  };
  const oldFetch = globalThis.fetch;
  const oldWebSocket = globalThis.WebSocket;
  let networkAttempts = 0;
  globalThis.fetch = async () => { networkAttempts++; throw new Error('Network forbidden in offline proof'); };
  globalThis.WebSocket = class { constructor() { networkAttempts++; throw new Error('WebSocket forbidden in offline proof'); } };
  let payloads = 0;
  try {
    for (const api of [lazy.openAICodexResponsesApi(), provider]) {
      for (const method of ['stream', 'streamSimple']) {
        let observed;
        const events = api[method](model, { messages: [{ role: 'user', content: 'offline proof', timestamp: 0 }] }, {
          apiKey, transport: 'sse', onPayload(payload) {
            observed = payload;
            throw new Error('OFFLINE_PAYLOAD_PROOF_COMPLETE');
          },
        });
        const result = await events.result();
        assert(observed, 'Lazy Codex did not reach the implementation payload hook');
        assert.equal(observed.reasoning?.effort, undefined, 'Implicit Codex effort is still present');
        assert.equal(result.stopReason, 'error');
        assert.match(result.errorMessage, /OFFLINE_PAYLOAD_PROOF_COMPLETE/);
        payloads++;
      }
    }
    assert.equal(networkAttempts, 0, 'Offline proof attempted a network call');
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.WebSocket = oldWebSocket;
  }
  return { adapterURL, peers, adapterPiImports, graph, piModuleCount: visited.size,
    codex: { providerURL, lazyURL, implementationURL, payloads, networkAttempts } };
}

async function profileForProof(info, profileInput) {
  const actualProfile = profileInput !== undefined;
  const profileDir = actualProfile ? await realpath(resolve(profileInput)) : join(info.runtime, 'synthetic-profile');
  const manifestPath = join(profileDir, 'package.json');
  const adapterRoot = join(info.runtime, 'node_modules', adapterName);
  const link = join(profileDir, 'node_modules', adapterName);
  if (!actualProfile) {
    const manifest = { name: 'synthetic-pi-ai-resolution-proof', private: true,
      dependencies: { [adapterName]: `link:${adapterRoot}` } };
    await mkdir(profileDir, { recursive: true });
    if (await exists(manifestPath)) assert.deepEqual(await readJson(manifestPath), manifest);
    else await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    if (!await exists(link)) {
      await mkdir(dirname(link), { recursive: true });
      await symlink(adapterRoot, link, 'dir');
    }
  }
  // Real-profile verification is strictly read-only: no initializer or repair.
  const manifestBytes = await readFile(manifestPath);
  const dependency = JSON.parse(manifestBytes).dependencies?.[adapterName];
  assert.equal(typeof dependency, 'string', 'Profile has no direct adapter dependency');
  assert(dependency.startsWith('link:'), 'Profile adapter dependency must be a link');
  assert.equal(await realpath(resolve(profileDir, dependency.slice('link:'.length))), await realpath(adapterRoot),
    'Profile dependency links a different adapter runtime');
  assert((await lstat(link)).isSymbolicLink());
  assert.equal(await realpath(link), await realpath(adapterRoot), 'Profile installed adapter link does not match dependency');
  return { profileDir, actualProfile, manifestHash: sha256(manifestBytes),
    home: actualProfile ? dirname(dirname(profileDir)) : join(info.runtime, 'synthetic-home') };
}

async function routerProof(info, profileInput) {
  const profileProof = await profileForProof(info, profileInput);
  const { profileDir } = profileProof;
  const bootURL = resolveFrom('@deepseek-ai/dsh-app-boot', join(info.officialRoot, adapterName, 'package.json'));
  const boot = await import(bootURL);
  const resolution = await boot.createRuntimeResolution({
    installAnchor: join(info.officialRoot, '@deepseek-ai/dsh/package.json'),
    profile: { dir: profileDir, layers: [], skippedBundles: [] },
    home: profileProof.home,
  });
  assert(resolution.localPackageNames.includes(adapterName));
  assert(resolution.linkedRoots.some((root) => root.name === adapterName && root.realPath === resolve(info.runtime, 'node_modules', adapterName)));
  for (const name of Object.keys(info.officialAdapter.peerDependencies)) {
    const entry = resolution.entries.find((candidate) => candidate.name === name);
    assert(entry, `Official router has no installation entry for peer ${name}`);
    assert.equal(entry.scope, 'installation');
    assert.equal(await realpath(entry.packageDir), await realpath(join(info.officialRoot, name)));
  }
  const bootstrap = resolveFrom('@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap',
    join(info.officialRoot, adapterName, 'package.json'));
  const key = '@deepseek-ai/dsh-app-boot/profile-resolution';
  const previous = getEnvironmentData(key);
  setEnvironmentData(key, { resolution });
  let worker;
  try {
    worker = new Worker(new URL(import.meta.url), {
      workerData: { mode: 'official-router', info, profileDir, bootstrap },
      execArgv: ['--experimental-import-meta-resolve'],
    });
  } finally { setEnvironmentData(key, previous); }
  const proof = await new Promise((accept, reject) => {
    let result;
    worker.on('message', (message) => { result = message; });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Official router worker exited ${code}`));
      else if (!result) reject(new Error('Official router worker produced no proof'));
      else accept({ ...profileProof, bootstrap, localPackageNames: resolution.localPackageNames,
        linkedRoots: resolution.linkedRoots, ...result });
    });
  });
  assert.equal(sha256(await readFile(join(profileDir, 'package.json'))), profileProof.manifestHash,
    'Profile manifest changed while verifying resolution');
  return proof;
}

export async function verifyRuntime(artifact, officialRoot, profileDir) {
  const info = await describeArtifact(artifact, officialRoot);
  assert.deepEqual(await readJson(join(info.runtime, 'package.json')), runtimeManifest(info));
  const receipt = await readJson(join(info.runtime, 'runtime.json'));
  assert.equal(receipt.runtimeHash, info.runtimeHash);
  assert.equal(receipt.artifactHash, info.artifactHash);
  const adapterRoot = join(info.runtime, 'node_modules', adapterName);
  const installedAdapter = await readJson(join(adapterRoot, 'package.json'));
  assert.equal(installedAdapter.version, adapterVersion);
  assert.deepEqual(installedAdapter, info.officialAdapter, 'Official adapter manifest changed');
  const adapterFiles = await adapterBytesProof(adapterRoot, join(info.officialRoot, adapterName));
  const lockBytes = await readFile(join(info.runtime, 'package-lock.json'));
  const lock = JSON.parse(lockBytes);
  const piLock = lock.packages[`node_modules/${piName}`];
  assert(piLock, 'Lockfile has no patched pi-ai root package');
  assert.equal(piLock.integrity, info.provenance.integrity);
  assert.equal(piLock.version, info.provenance.version);
  const peers = new Set(Object.keys(info.officialAdapter.peerDependencies));
  for (const [path, entry] of Object.entries(lock.packages)) {
    const peer = [...peers].find((name) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`);
    assert(!peer || entry.link, `npm downloaded a host peer: ${path}`);
    if (path.endsWith(`/node_modules/${piName}`)) assert.fail(`Nested pi-ai package: ${path}`);
  }
  const packages = await noDuplicatePeers(join(info.runtime, 'node_modules'), peers, info.officialRoot);
  const artifactFiles = await artifactBytesProof(info, join(info.runtime, 'node_modules', piName));
  const native = await resolutionProof(info);
  const router = await routerProof(info, profileDir);
  const report = {
    runtime: info.runtime, artifact: info.artifact, artifactHash: info.artifactHash,
    lockHash: sha256(lockBytes), adapterUnchanged: true, adapterFiles, artifactFiles, packages,
    native, router, actualProfileVerified: router.actualProfile,
    limitations: [router.actualProfile
      ? 'Read-only actual-profile resolution/payload proof; no plugin boot, live request, or compaction. Live evidence is recorded separately.'
      : 'Offline synthetic-profile resolution/payload proof only; no live request, compaction, or real profile activation.'],
  };
  const proofPath = join(info.runtime, router.actualProfile ? 'actual-profile-verification.json' : 'verification.json');
  await writeFile(proofPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ runtime: info.runtime, adapterUnchanged: true, artifactFiles,
    piModuleCount: native.piModuleCount, peers: native.peers.length,
    officialRouter: true, offlinePayloads: native.codex.payloads + router.codex.payloads,
    adapterFiles, actualProfileVerified: router.actualProfile, profileDir: router.profileDir,
    proof: proofPath }, null, 2));
  return report;
}

async function selfTest() {
  const { test } = await import('node:test');
  await test('literal ESM imports include static, lazy, side-effect, and export forms', () => {
    assert.deepEqual(literalImports(`import { a } from 'pi/a'; import('pi/lazy'); import 'pi/side'; export { b } from 'pi/b';`),
      ['pi/a', 'pi/lazy', 'pi/side', 'pi/b']);
  });
  await test('package containment rejects traversal and prefix collisions', () => {
    assertInside('/runtime/pi', '/runtime/pi/dist/a.js');
    assert.throws(() => assertInside('/runtime/pi', '/runtime/pi-other/a.js'), /escaped/);
    assert.throws(() => assertInside('/runtime/pi', '/runtime/a.js'), /escaped/);
  });
  const scratchRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dumps/pi-ai-fork');
  await mkdir(scratchRoot, { recursive: true });
  const scratch = await mkdtemp(join(scratchRoot, 'verify-self-test-'));
  const peer = 'synthetic-host-peer';
  const official = join(scratch, 'official');
  const copied = join(scratch, 'copied');
  const linked = join(scratch, 'linked');
  for (const root of [official, copied]) {
    await mkdir(join(root, peer), { recursive: true });
    await writeFile(join(root, peer, 'package.json'), JSON.stringify({ name: peer, version: '1.0.0' }));
  }
  await mkdir(linked);
  await symlink(join(official, peer), join(linked, peer), 'dir');
  await test('identical peer bytes do not excuse a duplicate module installation', async () => {
    await assert.rejects(noDuplicatePeers(copied, new Set([peer]), official), /Duplicate host peer/);
  });
  await test('peer realpath symlink passes identity topology check', async () => {
    assert.equal(await noDuplicatePeers(linked, new Set([peer]), official), 1);
  });
  await test('adapter proof rejects even a non-entrypoint byte change', async () => {
    await writeFile(join(official, peer, 'types.d.ts'), 'export class Host {}');
    await writeFile(join(copied, peer, 'types.d.ts'), 'export class Copy {}');
    await assert.rejects(adapterBytesProof(join(copied, peer), join(official, peer)), /byte drift/);
  });
  const fixtureRuntime = join(scratch, 'runtime');
  const fixtureAdapter = join(fixtureRuntime, 'node_modules', adapterName);
  await mkdir(fixtureAdapter, { recursive: true });
  await test('missing actual profile is rejected without creating it', async () => {
    const missing = join(scratch, 'missing-profile');
    await assert.rejects(profileForProof({ runtime: fixtureRuntime }, missing), { code: 'ENOENT' });
    assert.equal(await exists(missing), false);
  });
  const actualFixture = join(scratch, 'profiles/fixture');
  const actualManifest = join(actualFixture, 'package.json');
  await mkdir(dirname(join(actualFixture, 'node_modules', adapterName)), { recursive: true });
  await symlink(fixtureAdapter, join(actualFixture, 'node_modules', adapterName), 'dir');
  const manifestBytes = Buffer.from(JSON.stringify({ dependencies: { [adapterName]: `link:${relative(actualFixture, fixtureAdapter)}` } }));
  await writeFile(actualManifest, manifestBytes);
  await test('actual-profile proof accepts relative links without changing manifest or topology', async () => {
    const before = await lstat(actualManifest);
    const proof = await profileForProof({ runtime: fixtureRuntime }, actualFixture);
    assert.equal(proof.actualProfile, true);
    assert.equal(proof.profileDir, actualFixture);
    assert.equal(proof.home, scratch);
    assert.equal(proof.manifestHash, sha256(manifestBytes));
    assert.deepEqual(await readFile(actualManifest), manifestBytes);
    assert.equal((await lstat(actualManifest)).mtimeMs, before.mtimeMs);
    assert.deepEqual((await readdir(actualFixture)).sort(), ['node_modules', 'package.json']);
  });
  await test('actual-profile proof rejects an unactivated registry dependency without repairing it', async () => {
    const unactivated = join(scratch, 'profiles/unactivated');
    await mkdir(unactivated);
    const bytes = Buffer.from(JSON.stringify({ dependencies: { [adapterName]: adapterVersion } }));
    await writeFile(join(unactivated, 'package.json'), bytes);
    await assert.rejects(profileForProof({ runtime: fixtureRuntime }, unactivated), /must be a link/);
    assert.deepEqual(await readFile(join(unactivated, 'package.json')), bytes);
    assert.equal(await exists(join(unactivated, 'node_modules')), false);
  });
}

if (!isMainThread && workerData?.mode === 'official-router') {
  await import(workerData.bootstrap);
  parentPort.postMessage(await resolutionProof(workerData.info, workerData.profileDir));
} else if (process.argv[1] && url(resolve(process.argv[1])) === import.meta.url) {
  if (process.argv[2] === '--self-test') await selfTest();
  else await verifyRuntime(process.argv[2], process.argv[3], process.argv[4]);
}
