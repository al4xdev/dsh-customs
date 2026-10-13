import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baselineCodexHash, patchCodexSource } from '../pi-ai-fork/codex-failure-categories.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
export const piVersion = '0.87.1+alex.codex-default.206545bfd51e';
export const oauthSeams = Object.freeze([
  'dist/auth/oauth/openai-codex.js', 'dist/auth/oauth/openai-codex.js.map',
  'dist/auth/oauth/openai-codex.d.ts', 'dist/auth/oauth/openai-codex.d.ts.map',
  'dist/oauth.js', 'dist/oauth.js.map',
]);

/** Digest public source, not dependencies, VCS metadata or generated outputs. */
export async function sourceInventory(root) {
  const files = [];
  async function visit(path, relative = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.dumps', 'dist'].includes(entry.name) || (relative === '' && entry.name === 'SOURCE-PROVENANCE.json')) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      assert(!entry.isSymbolicLink(), `Source symlink is not portable: ${name}`);
      if (entry.isDirectory()) await visit(join(path, entry.name), name);
      else if (entry.isFile()) files.push([name, sha(await readFile(join(path, entry.name)))]);
      else throw new Error(`Unsupported source entry: ${name}`);
    }
  }
  await visit(root);
  files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { files, sourceDigest: sha(JSON.stringify(files)) };
}

export async function verifySource(sourceRoot, { expectedSourceDigest, runner = execFileSync } = {}) {
  const inventory = await sourceInventory(sourceRoot);
  if (expectedSourceDigest) assert.equal(inventory.sourceDigest, expectedSourceDigest, 'Pi source inventory drift');
  assert.equal(sha(await readFile(join(sourceRoot, 'packages/ai/src/api/openai-codex-responses.ts'))), baselineCodexHash, 'Wrong reviewed Codex baseline');
  // Only an owned .git entry establishes Pi Git provenance; never ask Git in a
  // snapshot and accidentally report the containing central repository's HEAD.
  if (await lstat(join(sourceRoot, '.git')).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
    return { kind: 'git', sourceCommit: String(runner('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' })).trim(), sourceDigest: inventory.sourceDigest };
  }
  const proof = await json(join(sourceRoot, 'SOURCE-PROVENANCE.json'));
  assert.equal(proof.kind, 'verified-source-snapshot-not-a-git-checkout');
  assert.equal(proof.currentGitHead, null);
  assert.equal(proof.codexSourceHash, baselineCodexHash);
  assert.equal(proof.historicalSourceCommit, 'f5a24c96d72732ba63aeca9a02295c320db04c2d');
  // Publication must seal our documented digest, not guess the earlier ad-hoc
  // treeDigest serialization. The original historical proof remains untouched.
  const sealed = expectedSourceDigest ?? proof.sourceDigest;
  assert(sealed, 'Snapshot publication needs sourceDigest or explicit expectedSourceDigest');
  assert.equal(inventory.sourceDigest, sealed, 'Published snapshot source inventory drift');
  return { kind: proof.kind, historicalSourceCommit: proof.historicalSourceCommit, sourceDigest: inventory.sourceDigest, historicalTreeDigest: proof.treeDigest };
}

export function packResult(output, name) {
  const result = JSON.parse(output);
  const pack = Array.isArray(result) ? result[0] : result[name];
  assert(pack?.filename && pack.integrity && !pack.filename.includes('/'), 'Invalid npm pack result');
  return pack;
}

/** Compile the complete reviewed source against a fresh official catalog donor.
 * Caller installs locked dependencies in a separate fresh tree; never use host SDK
 * bytes as package templates. Importing this module performs no install or build.
 */
export async function preparePi({ sourceRoot, dependencyRoot, seedNodeModules, artifactsRoot, expectedSourceDigest, catalogOverlay }, { runner = execFileSync } = {}) {
  for (const [name, path] of Object.entries({ sourceRoot, dependencyRoot, seedNodeModules, artifactsRoot })) {
    assert.equal(path, resolve(path), `${name} must be absolute and normalized`);
  }
  for (const root of [sourceRoot, dependencyRoot, seedNodeModules]) assert.equal(await realpath(root), root, 'Inputs must be canonical');
  for (const root of [sourceRoot, dependencyRoot, seedNodeModules]) assert(!artifactsRoot.startsWith(root + '/') && !root.startsWith(artifactsRoot + '/') && root !== artifactsRoot, 'Artifact/input overlap');
  const source = await verifySource(sourceRoot, { expectedSourceDigest, runner });
  const manifest = await json(join(sourceRoot, 'packages/ai/package.json'));
  assert.equal(manifest.name, '@earendil-works/pi-ai'); assert.equal(manifest.version, '0.87.1');
  const donor = await json(join(seedNodeModules, '@earendil-works/pi-ai/package.json'));
  assert.equal(donor.version, '0.87.1', 'Use a fresh official published donor, not host fork');
  const compiler = await json(join(dependencyRoot, '@typescript/native-preview/package.json'));
  const lock = await json(join(sourceRoot, 'package-lock.json'));
  assert.equal(compiler.version, lock.packages['node_modules/@typescript/native-preview'].version, 'Compiler differs from source lock');
  const helper = await readFile(join(repo, 'tools/pi-ai-fork/provider-failure.ts'));
  await mkdir(artifactsRoot, { mode: 0o700 }); // Exclusive, including failed builds.
  const build = join(artifactsRoot, 'build');
  await cp(sourceRoot, build, { recursive: true, filter: path => !['.git', 'node_modules', '.dumps', 'dist'].includes(path.split('/').at(-1)) && path !== join(sourceRoot, 'packages/ai/src/providers/data') });
  const modules = join(build, 'node_modules');
  await mkdir(modules);
  for (const entry of await readdir(dependencyRoot)) {
    if (entry === '@earendil-works') continue;
    await symlink(join(dependencyRoot, entry), join(modules, entry));
  }
  const scope = join(modules, '@earendil-works');
  await mkdir(scope);
  for (const entry of await readdir(join(dependencyRoot, '@earendil-works'))) {
    await symlink(entry === 'pi-telemetry' ? join(build, 'packages/telemetry') : join(dependencyRoot, '@earendil-works', entry), join(scope, entry));
  }
  const ai = join(build, 'packages/ai');
  const codexPath = join(ai, 'src/api/openai-codex-responses.ts');
  await writeFile(codexPath, patchCodexSource(await readFile(codexPath, 'utf8')));
  await writeFile(join(ai, 'src/utils/provider-failure.ts'), helper);
  const indexPath = join(ai, 'src/index.ts');
  await writeFile(indexPath, await readFile(indexPath, 'utf8') + '\nexport * from "./utils/provider-failure.ts";\n');
  const catalog = join(ai, 'src/providers/data');
  // cp cannot remove obsolete files: the fresh source copy excluded this catalog.
  // Verify names below so any unexpected source catalog refuses rather than hides.
  const donorCatalog = join(seedNodeModules, '@earendil-works/pi-ai/dist/providers/data');
  await cp(donorCatalog, catalog, { recursive: true });
  if (catalogOverlay) {
    assert.equal(catalogOverlay, resolve(catalogOverlay));
    assert.equal(await realpath(catalogOverlay), catalogOverlay);
    for (const name of await readdir(catalogOverlay)) {
      // The exported public catalog may include its stale historical stamp. Its
      // hashes are regenerated below; never copy that stamp into the new build.
      if (name === '.manifest.json') continue;
      assert(/^[a-z0-9-]+\.json$/.test(name), 'Only explicit public model JSON overlays are allowed');
      assert((await lstat(join(catalogOverlay, name))).isFile(), 'Catalog overlay must contain regular files');
      await cp(join(catalogOverlay, name), join(catalog, name));
    }
  }
  const modelData = await import(pathToFileURL(join(ai, 'scripts/model-data.ts')).href);
  const stamp = await json(join(donorCatalog, '.manifest.json'));
  const contents = {};
  for (const name of (await readdir(catalog)).sort()) if (name.endsWith('.json') && name !== '.manifest.json') contents[name] = await readFile(join(catalog, name), 'utf8');
  await writeFile(join(catalog, '.manifest.json'), JSON.stringify(modelData.createModelDataManifest(modelData.readModelDataStructure(ai), contents, stamp.generatedAt)) + '\n');
  const run = (command, args, cwd) => runner(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run(process.execPath, [join(ai, 'scripts/check-model-data.ts')], ai);
  const tsgo = join(dependencyRoot, '@typescript/native-preview/bin/tsgo.js');
  run(process.execPath, [tsgo, '-p', 'tsconfig.build.json'], join(build, 'packages/telemetry'));
  run(process.execPath, [tsgo, '-p', 'tsconfig.build.json'], ai);
  const staged = join(artifactsRoot, 'package');
  await mkdir(staged);
  await cp(join(ai, 'dist'), join(staged, 'dist'), { recursive: true, filter: path => path !== join(ai, 'dist/providers/data') });
  await cp(catalog, join(staged, 'dist/providers/data'), { recursive: true });
  await cp(join(sourceRoot, 'LICENSE'), join(staged, 'LICENSE'));
  await cp(join(ai, 'README.md'), join(staged, 'README.md'));
  const telemetry = await json(join(seedNodeModules, '@earendil-works/pi-telemetry/package.json'));
  await writeFile(join(staged, 'package.json'), JSON.stringify({ ...manifest, version: piVersion, scripts: {}, devDependencies: {}, dependencies: { ...manifest.dependencies, '@earendil-works/pi-telemetry': telemetry.version } }, null, 2) + '\n');
  const pack = packResult(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', artifactsRoot], staged), manifest.name);
  const artifact = join(artifactsRoot, pack.filename);
  const fingerprints = {};
  for (const name of [...oauthSeams, 'dist/index.js', 'dist/api/openai-codex-responses.js', 'dist/utils/provider-failure.js']) fingerprints[name] = sha(await readFile(join(staged, name)));
  const proof = { source, version: piVersion, observerVersion: 1, compilerVersion: compiler.version, artifact, integrity: pack.integrity, artifactSha256: sha(await readFile(artifact)), catalogDigest: sha(JSON.stringify(contents)), helperSourceHash: sha(helper), compiledFingerprints: fingerprints, telemetrySourceCompiled: true, hostSdkCopied: false };
  await writeFile(join(artifactsRoot, 'provenance.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  return proof;
}
