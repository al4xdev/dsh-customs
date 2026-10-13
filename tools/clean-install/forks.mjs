import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

const manifestUrl = new URL('./forks-manifest.json', import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => target === root || target.startsWith(root + sep);
const legacyPeer = '@deepseek-ai/dsh-client-runtime';

export async function loadForkManifest() {
  return validateForkManifest(JSON.parse(await readFile(manifestUrl, 'utf8')));
}

export function validateForkManifest(manifest) {
  assert.equal(manifest?.schemaVersion, 1, 'Unsupported fork manifest');
  assert.equal(manifest.nodeMajorMinimum, 24);
  assert.deepEqual(manifest.tools, { pnpm: '11.21.0', esbuild: '0.28.2' });
  assert.equal(manifest.components?.length, 2);
  assert.deepEqual(manifest.components.map(component => component.id), ['tui', 'antigravity']);
  for (const component of manifest.components) {
    const url = new URL(component.repository);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'github.com');
    assert(!url.username && !url.password && !url.search && !url.hash, 'Public credential-free Git URL required');
    assert.match(component.commit, /^[a-f0-9]{40}$/, 'Full source pin required');
  }
  const [tui, ag] = manifest.components;
  assert.equal(tui.repository, 'https://github.com/al4xdev/dsh-TUI.git');
  assert.equal(tui.package, '@deepseek-harness-tui/dsh-tui');
  assert.equal(tui.version, '0.14.0');
  assert.equal(tui.strategy, 'source-compile');
  assert.deepEqual(tui.submodule, {
    path: 'vendor/dsh-std', repository: 'https://github.com/T-Auto/dsh-std.git',
    commit: '614dfa1ac168db79fcf4577cf0ebb34e2e3b944b',
  });
  assert.equal(ag.repository, 'https://github.com/al4xdev/dsh-antigravity.git');
  assert.equal(ag.package, '@deepseek-ai/dsh-llm-pi-ai-antigravity');
  assert.equal(ag.version, '0.1.0-rc.5');
  assert.equal(ag.strategy, 'host-source-compile-with-committed-auxiliary-faces');
  assert.equal(ag.sourceEntry, 'src/index.ts');
  assert.equal(ag.sourceOutput, 'lib/index.js');
  assert.equal(ag.target, 'node22');
  return manifest;
}

/** This metadata change does not claim to rebuild the legacy browser exports. */
export function antigravityHostPackage(metadata, compiledHost) {
  assert.equal(metadata.name, '@deepseek-ai/dsh-llm-pi-ai-antigravity');
  assert.equal(metadata.version, '0.1.0-rc.5');
  assert.equal(metadata.main, 'lib/index.js');
  assert.equal(metadata.exports?.['.']?.default, './lib/index.js');
  assert.equal(metadata.peerDependencies?.[legacyPeer], '*', 'Legacy peer context changed; review the packaging policy');
  assert(!compiledHost.includes(legacyPeer), 'Host bundle references legacy client-runtime; optional-peer patch refused');
  return {
    ...metadata,
    // Source is bundled only into the host entry. Consumers of the other export
    // faces still need their original optional/client dependencies and testing.
    scripts: {},
    peerDependenciesMeta: {
      ...metadata.peerDependenciesMeta,
      [legacyPeer]: { ...metadata.peerDependenciesMeta?.[legacyPeer], optional: true },
    },
  };
}

async function canonicalDirectory(path) {
  assert(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'Canonical absolute directory required');
  assert.equal(await realpath(path), path, 'Symlink directory refused');
  assert((await lstat(path)).isDirectory(), 'Directory required');
}

async function publicFiles(root) {
  const files = {};
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory)).sort()) {
      const file = join(directory, entry), relative = prefix + entry;
      const stat = await lstat(file);
      assert(!stat.isSymbolicLink(), 'Symlink public build input refused');
      if (stat.isDirectory()) await walk(file, relative + '/');
      else {
        assert(stat.isFile(), 'Special public build input refused');
        files[relative] = sha(await readFile(file));
      }
    }
  }
  await canonicalDirectory(root);
  await walk(root);
  return files;
}

async function optionalNotice(source, target, name) {
  try {
    assert((await lstat(join(source, name))).isFile(), 'Notice must be a regular file');
    await cp(join(source, name), join(target, name), { errorOnExist: true, force: false });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * Build only inside caller-owned isolated roots, never a live checkout/donor.
 * The caller supplies a runner and isolated environment: this module has no CLI,
 * implicit subprocess runner, installation, authentication or provider imports.
 * A failed/partial source or artifact directory is retained and cannot be reused.
 */
export async function buildForks({ sourcesRoot, artifactsRoot, toolchainRoot, spawn, env,
  manifest, gitExecutable = 'git', npmExecutable = 'npm', pnpmExecutable, esbuildExecutable } = {}) {
  manifest = validateForkManifest(manifest ?? await loadForkManifest());
  assert.equal(typeof spawn, 'function', 'Explicit subprocess runner required');
  assert(env && typeof env === 'object' && !Array.isArray(env), 'Explicit isolated subprocess environment required');
  assert(Number(process.versions.node.split('.')[0]) >= manifest.nodeMajorMinimum, 'Node24 or newer required');
  await canonicalDirectory(sourcesRoot);
  await canonicalDirectory(artifactsRoot);
  await canonicalDirectory(toolchainRoot);
  assert(!inside(sourcesRoot, artifactsRoot) && !inside(artifactsRoot, sourcesRoot), 'Source/artifact roots must be disjoint');
  pnpmExecutable ??= join(toolchainRoot, 'node_modules/.bin/pnpm');
  esbuildExecutable ??= join(toolchainRoot, 'node_modules/.bin/esbuild');
  const commands = [];
  async function run(command, args, cwd) {
    assert.equal(typeof command, 'string');
    assert(command.length && !/[\r\n\0]/.test(command), 'Invalid executable');
    const result = await spawn(command, args, { cwd, env, encoding: 'utf8', shell: false });
    assert(result && !result.error && result.status === 0, `Fork subprocess failed: ${command} ${args[0] ?? ''}`);
    commands.push({ command, args, cwd });
    return String(result.stdout ?? '');
  }
  assert.equal((await run(pnpmExecutable, ['--version'], toolchainRoot)).trim(), manifest.tools.pnpm, 'Pinned pnpm required');
  assert.equal((await run(esbuildExecutable, ['--version'], toolchainRoot)).trim(), manifest.tools.esbuild, 'Pinned esbuild required');
  const results = {};
  for (const component of manifest.components) {
    const source = join(sourcesRoot, component.id), artifacts = join(artifactsRoot, component.id);
    // Reserve both before cloning: a partial failure cannot consume another
    // component's old output or overwrite a historical tarball.
    await mkdir(source, { mode: 0o700 });
    await mkdir(artifacts, { mode: 0o700 });
    await run(gitExecutable, ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-checkout', '--', component.repository, source], sourcesRoot);
    assert((await lstat(join(source, '.git'))).isDirectory(), 'Independent fork Git metadata required');
    await run(gitExecutable, ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', component.commit], source);
    assert.equal((await run(gitExecutable, ['rev-parse', 'HEAD'], source)).trim(), component.commit, 'Fork source pin differs');
    assert.equal((await run(gitExecutable, ['status', '--porcelain'], source)).trim(), '', 'Fresh source must be clean');
    const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    assert.equal(metadata.name, component.package);
    assert.equal(metadata.version, component.version);
    const metadataHash = sha(await readFile(join(source, 'package.json')));
    const buildInputFiles = component.id === 'tui'
      ? ['.gitmodules', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json']
      : ['tsconfig.standalone.json'];
    const buildInputHashes = {};
    for (const file of buildInputFiles) {
      const stat = await lstat(join(source, file));
      assert(stat.isFile() && !stat.isSymbolicLink(), 'Regular build configuration required');
      buildInputHashes[file] = sha(await readFile(join(source, file)));
    }
    let packageRoot = source, compiledFiles, prebuiltFiles = {}, sourceFiles;
    if (component.id === 'tui') {
      assert.equal(metadata.packageManager, `pnpm@${manifest.tools.pnpm}`);
      const gitmodules = await readFile(join(source, '.gitmodules'), 'utf8');
      assert.match(gitmodules, /path\s*=\s*vendor\/dsh-std/);
      assert.match(gitmodules, /url\s*=\s*https:\/\/github\.com\/T-Auto\/dsh-std\.git(?:\s|$)/);
      await run(gitExecutable, ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', 'submodule', 'update', '--init', '--recursive'], source);
      assert.equal((await run(gitExecutable, ['rev-parse', 'HEAD'], join(source, component.submodule.path))).trim(), component.submodule.commit, 'Vendored source pin differs');
      sourceFiles = await publicFiles(join(source, 'src'));
      await run(pnpmExecutable, ['install', '--frozen-lockfile', '--ignore-scripts'], source);
      await run(pnpmExecutable, ['compile'], source);
      await run(pnpmExecutable, ['verify:oauth'], source);
      compiledFiles = await publicFiles(join(source, 'lib'));
    } else {
      sourceFiles = await publicFiles(join(source, 'src'));
      const before = await publicFiles(join(source, 'lib'));
      assert(before[component.sourceOutput.slice(4)], 'Committed host output missing');
      packageRoot = join(artifacts, 'package');
      await mkdir(packageRoot);
      // No npm install in this fork: its legacy client peer is not required to
      // compile host JS with packages external. Every auxiliary lib face is
      // retained from the immutable fork, not copied from an installed runtime.
      await cp(join(source, 'lib'), join(packageRoot, 'lib'), { recursive: true, errorOnExist: true, force: false });
      await cp(join(source, 'src'), join(packageRoot, 'src'), { recursive: true, errorOnExist: true, force: false });
      assert((await lstat(join(source, 'cordis.patch.yml'))).isFile());
      await cp(join(source, 'cordis.patch.yml'), join(packageRoot, 'cordis.patch.yml'));
      for (const name of ['LICENSE', 'LICENSE.md', 'README.md']) await optionalNotice(source, packageRoot, name);
      await run(esbuildExecutable, [component.sourceEntry, '--bundle', '--platform=node', '--format=esm', '--packages=external',
        `--target=${component.target}`, '--tsconfig=tsconfig.standalone.json', `--outfile=${join(packageRoot, component.sourceOutput)}`], source);
      const host = await readFile(join(packageRoot, component.sourceOutput), 'utf8');
      const patched = antigravityHostPackage(metadata, host);
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify(patched, null, 2) + '\n', { flag: 'wx' });
      const after = await publicFiles(join(packageRoot, 'lib'));
      assert.deepEqual(Object.keys(after), Object.keys(before), 'Unexpected generated library faces');
      for (const [file, digest] of Object.entries(before)) if (file !== 'index.js') {
        assert.equal(after[file], digest, 'Committed auxiliary output changed');
        prebuiltFiles[`lib/${file}`] = digest;
      }
      compiledFiles = { 'index.js': after['index.js'] };
    }
    assert.deepEqual(await publicFiles(join(source, 'src')), sourceFiles, 'Source changed during compilation');
    assert.equal(sha(await readFile(join(source, 'package.json'))), metadataHash, 'Source metadata changed during compilation');
    for (const [file, digest] of Object.entries(buildInputHashes)) {
      assert.equal(sha(await readFile(join(source, file))), digest, 'Build configuration changed during compilation');
    }
    const packed = JSON.parse(await run(npmExecutable, ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], packageRoot));
    const pack = Array.isArray(packed) ? packed[0] : packed[component.package];
    assert.equal(pack?.name, component.package, 'Packed identity differs');
    assert.equal(pack.version, component.version);
    assert(typeof pack.filename === 'string' && pack.filename.endsWith('.tgz') && !pack.filename.includes('/') && !pack.filename.includes('\\') && !pack.filename.startsWith('.'), 'Unsafe tarball filename');
    const artifact = join(artifacts, pack.filename);
    assert((await lstat(artifact)).isFile() && !(await lstat(artifact)).isSymbolicLink(), 'Regular tarball required');
    const receipt = { schemaVersion: 1, id: component.id, repository: component.repository, sourceCommit: component.commit,
      strategy: component.strategy, qualification: component.qualification, package: component.package, version: component.version,
      source, artifact, artifactSha256: sha(await readFile(artifact)), sourceFiles, sourceMetadataSha256: metadataHash,
      buildInputHashes, compiledFiles, prebuiltFiles, submodule: component.submodule ?? null,
      recipeSha256: sha(await readFile(new URL('./forks.mjs', import.meta.url))), manifestSha256: sha(JSON.stringify(manifest)),
      tools: manifest.tools, liveCalls: 0, credentialsUsed: false, profileActivated: false };
    await writeFile(join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    results[component.id] = receipt;
  }
  return { components: results, commands, qualification: 'Source pins and build outputs only; caller owns runtime installation, Pi override and isolated profile wiring.' };
}
