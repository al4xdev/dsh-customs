#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildForks } from './forks.mjs';
import { preparePi } from './pi.mjs';
import { installProtocol } from './protocol.mjs';

const repoDefault = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const snapshotDigest = 'e228f62a3176b980617656e94795518b467b32512da4f6044bea2c066fb6ae48';
export const versions = Object.freeze({ dsh: '0.2.0-rc.2', cordis: '4.0.4', npm: '12.2.0', pnpm: '11.21.0', esbuild: '0.28.2', nodePty: '1.2.0-beta.15' });

export function installationPaths(home, repo = repoDefault) {
  assert.equal(home, resolve(home), 'HOME must be absolute and normalized');
  assert.equal(repo, resolve(repo), 'Repository must be absolute and normalized');
  return { home, repo, install: join(home, '.local/share/dsh-cli'), build: join(home, '.local/share/dsh-build'), dshHome: join(home, '.dsh'), bin: join(home, '.local/bin') };
}
const statOrNull = async path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });

export async function assertFresh(paths, { docker = false } = {}) {
  assert(docker, 'Clean installation is Docker-only; refusing host execution');
  assert.equal(await realpath(paths.home), paths.home, 'HOME must be canonical');
  assert.equal(await realpath(paths.repo), paths.repo, 'Repository must be canonical');
  for (const path of [paths.install, paths.build, join(paths.repo, 'node_modules'), join(paths.bin, 'dsh')]) assert.equal(await statOrNull(path), null, `Fresh path already occupied: ${path}`);
  const dsh = await statOrNull(paths.dshHome);
  if (dsh) assert(dsh.isDirectory() && !dsh.isSymbolicLink() && (await readdir(paths.dshHome)).length === 0, 'DSH home must be absent or empty');
  for (const path of [join(paths.home, '.local'), join(paths.home, '.local/share'), paths.bin]) {
    const stat = await statOrNull(path);
    if (stat) assert(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(path) === path, 'Output parents must be canonical directories');
  }
}

export function runtimePackage({ tui, antigravity, pi }) {
  for (const artifact of [tui, antigravity, pi]) assert.equal(artifact, resolve(artifact), 'Absolute durable artifacts required');
  return { name: 'dsh-clean-runtime', version: '0.0.0', private: true,
    dependencies: { '@deepseek-ai/dsh': versions.dsh, '@deepseek-harness-tui/dsh-tui': `file:${tui}`, '@deepseek-ai/dsh-llm-pi-ai-antigravity': `file:${antigravity}`, '@earendil-works/pi-ai': `file:${pi}`, '@modelcontextprotocol/server': '2.3.1', yaml: '2.9.1', pnpm: versions.pnpm },
    // All callers, including AG's older ^0.82 range, must see this same public
    // SDK. A second physical copy would split terminal failure subscriptions.
    overrides: { '@earendil-works/pi-ai': '$@earendil-works/pi-ai',
      // AG pins cordis 4.0.4 exactly while dsh asks ~4.0.4; once 4.0.5 shipped,
      // npm nested a second copy under dsh and split the shared Cordis identity.
      '@deepseek-ai/cordis': versions.cordis } };
}

export async function sharedGraph(install) {
  const modules = join(install, 'node_modules');
  async function dependency(from, name) {
    for (let cursor = from; cursor.startsWith(install + '/'); cursor = dirname(cursor)) {
      const candidate = join(cursor, 'node_modules', name, 'package.json');
      if (await statOrNull(candidate)) return realpath(candidate);
    }
    const candidate = join(modules, name, 'package.json');
    assert(await statOrNull(candidate), `Missing dependency ${name}`);
    return realpath(candidate);
  }
  const consumers = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-harness-tui/dsh-tui', '@deepseek-ai/dsh-llm-pi-ai-antigravity'];
  const proof = {};
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-scope']) {
    const identities = await Promise.all(consumers.map(consumer => dependency(join(modules, consumer), name)));
    assert(identities.every(path => path === identities[0]), `Duplicate physical dependency: ${name}`);
    proof[name] = identities[0];
  }
  const piIdentities = await Promise.all(['@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai-antigravity'].map(consumer => dependency(join(modules, consumer), '@earendil-works/pi-ai')));
  assert(piIdentities.every(path => path === join(modules, '@earendil-works/pi-ai/package.json')), 'Pi terminal observer graph split');
  proof['@earendil-works/pi-ai'] = piIdentities[0];
  return proof;
}

/** Both reviewed records are checked before the builder can publish the new
 * controller. The owner must already exist and is verified, never rebuilt;
 * this wrapper independently binds its result to the checked-in review records.
 */
export async function prepareUnifiedRecovery({ repo, esbuildModule }, { build } = {}) {
  assert.equal(repo, await realpath(repo), 'Recovery repository must be canonical');
  assert.equal(esbuildModule, resolve(esbuildModule), 'Explicit compiler module required');
  const compiler = await realpath(esbuildModule);
  const publicFile = async path => {
    assert.equal(await realpath(path), path, 'Recovery file must not redirect');
    assert((await lstat(path)).isFile(), 'Regular recovery file required');
    return readFile(path);
  };
  const specs = {
    controller: { entry: 'plugins/llm-resilience/index.mjs', output: 'plugins/llm-resilience/lib/index-v5-unified.mjs', rollback: 'plugins/llm-resilience/lib/index-v1-resilience.mjs' },
    selfHeal: { entry: 'plugins/agent-self-heal/index.mjs', output: 'plugins/agent-self-heal/lib/index-v6-unified.mjs', rollback: 'plugins/agent-self-heal/lib/index-v3-resilience.mjs' },
  };
  const historicPaths = ['plugins/agent-self-heal/lib/index-v2-persistence.mjs', ...Object.values(specs).map(spec => spec.rollback)];
  const historicHashes = Object.fromEntries(await Promise.all(historicPaths.map(async path => [path, sha(await publicFile(join(repo, path)))])));
  const checked = {};
  for (const [id, spec] of Object.entries(specs)) {
    const output = join(repo, spec.output), manifest = output.replace(/\.mjs$/, '.build.json');
    const manifestBytes = await publicFile(manifest), record = JSON.parse(manifestBytes);
    assert.equal(record.schema, 1, 'Reviewed recovery record schema required');
    assert.equal(record.output, basename(output), 'Recovery record output differs');
    assert.equal(record.compilerVersion, versions.esbuild, 'Recovery compiler record drift');
    assert.equal(record.target, 'node24', 'Recovery build target differs');
    assert.match(record.sha256, /^[a-f0-9]{64}$/, 'Recovery output hash required');
    assert.equal(record.rollbackSha256, historicHashes[spec.rollback], 'Recovery rollback bundle drift');
    assert(record.sourceHashes && Object.hasOwn(record.sourceHashes, spec.entry), 'Recovery entry source record missing');
    for (const [relative, expected] of Object.entries(record.sourceHashes)) {
      const path = resolve(repo, relative);
      assert((relative.startsWith('plugins/') || relative.startsWith('tools/resilience/')) && relative.endsWith('.mjs') && relative.split('/').every(part => part && !['.', '..', '.dsh', '.dumps'].includes(part)) && path.startsWith(repo + sep) && path === join(repo, relative), 'Recovery source record escaped public sources');
      assert.match(expected, /^[a-f0-9]{64}$/);
      assert.equal(sha(await publicFile(path)), expected, 'Recovery source record drift');
    }
    const outputBeforeHash = await statOrNull(output) ? sha(await publicFile(output)) : null;
    if (id === 'selfHeal') assert(outputBeforeHash !== null, 'Existing reviewed immutable owner required');
    if (outputBeforeHash !== null) assert.equal(outputBeforeHash, record.sha256, 'Versioned recovery output differs; refuse overwrite');
    checked[id] = { output, manifest, manifestSha256: sha(manifestBytes), record, outputBeforeHash };
  }
  // Lazy import keeps help/tests inert and never invokes the historical builder.
  const buildUnifiedRecovery = build ?? (await import(pathToFileURL(join(repo, 'tools/resilience/build-unified-recovery.mjs')).href)).buildUnifiedRecovery;
  const built = await buildUnifiedRecovery({ repoRoot: repo, esbuildModule });
  assert.equal(built.schema, 1); assert.equal(built.kind, 'unified-recovery-build');
  assert.equal(built.compiler, compiler, 'Unexpected recovery compiler');
  assert.equal(built.modelCalls, 0); assert.equal(built.profilesModified, false);
  assert.deepEqual(built.rollbackHashes, historicHashes, 'Historical recovery records differ');
  assert.deepEqual(Object.keys(built.artifacts).sort(), Object.keys(specs).sort(), 'Both recovery artifacts required');
  for (const [id, expected] of Object.entries(checked)) {
    const artifact = built.artifacts[id];
    if (id === 'selfHeal') assert.equal(artifact.reused, true, 'Owner must be reused without rebuilding');
    assert.equal(artifact.output, expected.output); assert.equal(artifact.manifest, expected.manifest);
    assert.equal(artifact.sha256, expected.record.sha256); assert.deepEqual(artifact.sourceHashes, expected.record.sourceHashes);
    assert.equal(artifact.rollbackSha256, expected.record.rollbackSha256);
    assert.equal(sha(await publicFile(expected.manifest)), expected.manifestSha256, 'Reviewed recovery manifest changed during build');
    assert.equal(sha(await publicFile(expected.output)), expected.record.sha256, 'Recovery compiler output differs from review');
    for (const [relative, hash] of Object.entries(expected.record.sourceHashes)) assert.equal(sha(await publicFile(join(repo, relative))), hash, 'Recovery source changed during build');
  }
  for (const [path, hash] of Object.entries(historicHashes)) assert.equal(sha(await publicFile(join(repo, path))), hash, 'Historical recovery bundle changed');
  return { ...built, reviewed: true, outputBeforeHashes: Object.fromEntries(Object.entries(checked).map(([id, value]) => [id, value.outputBeforeHash])) };
}

/** No implicit installs at import/default CLI. --fresh requires an actual Docker
 * filesystem marker and refuses all occupied canonical runtime/profile roots.
 */
export async function installFresh({ home = process.env.HOME, repo = repoDefault } = {}, io = {}) {
  const paths = installationPaths(home, repo);
  const docker = await access('/.dockerenv').then(() => true, () => false);
  await assertFresh(paths, { docker });
  assert.equal(Number(process.versions.node.split('.')[0]), 24, 'Reviewed image requires Node24');
  await mkdir(dirname(paths.install), { recursive: true, mode: 0o700 });
  await mkdir(paths.install, { mode: 0o700 });
  await mkdir(paths.build, { mode: 0o700 });
  const toolchain = join(paths.build, 'toolchain'), seed = join(paths.build, 'seed');
  const sources = join(paths.build, 'sources'), artifacts = join(paths.install, 'artifacts');
  for (const path of [toolchain, seed, sources, artifacts]) await mkdir(path, { mode: 0o700 });
  const config = join(paths.build, 'empty-npmrc');
  const globalConfig = join(paths.build, 'empty-global-npmrc');
  // npm rejects loading one path twice under different configuration scopes.
  await writeFile(config, '', { flag: 'wx', mode: 0o600 });
  await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
  const env = { HOME: home, DSH_HOME: paths.dshHome, DSH_INSTALL_ROOT: paths.install, XDG_DATA_HOME: join(home, '.local/share'), XDG_CONFIG_HOME: join(paths.build, 'config'), XDG_CACHE_HOME: join(paths.build, 'cache'), PATH: process.env.PATH, NODE_ENV: 'development', DSH_TELEMETRY_DISABLED: '1', GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', npm_config_userconfig: config, npm_config_globalconfig: globalConfig, npm_config_cache: join(paths.build, 'npm-cache'), npm_config_nodedir: '/usr/local' };
  const commands = [];
  const spawn = io.spawn ?? spawnSync;
  function run(command, args, cwd) {
    const result = spawn(command, args, { cwd, env, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
    commands.push({ command, args, cwd, status: result.status ?? null });
    if (result.error || result.status !== 0) {
      // Container logs are explicit build diagnostics; never capture inherited
      // provider environment or credentials in a receipt.
      if (result.stderr) process.stderr.write(String(result.stderr));
      throw new Error(`Clean subprocess failed: ${command} ${args[0] ?? ''} (exit ${result.status})`);
    }
    return String(result.stdout ?? '');
  }
  const writePackage = async (root, pkg) => writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', { flag: 'wx' });
  await writePackage(toolchain, { private: true, dependencies: { npm: versions.npm, pnpm: versions.pnpm, esbuild: versions.esbuild } });
  const installArgs = ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
  run('npm', installArgs, toolchain);
  const npm = join(toolchain, 'node_modules/.bin/npm');
  const pnpm = join(toolchain, 'node_modules/.bin/pnpm');
  const esbuild = join(toolchain, 'node_modules/.bin/esbuild');
  env.PATH = join(toolchain, 'node_modules/.bin') + ':' + env.PATH;
  for (const [command, expected] of [[npm, versions.npm], [pnpm, versions.pnpm], [esbuild, versions.esbuild]]) assert.equal(run(command, ['--version'], toolchain).trim(), expected);
  await writePackage(seed, { private: true, dependencies: { '@deepseek-ai/dsh': versions.dsh, '@earendil-works/pi-ai': '0.87.1' } });
  run(npm, installArgs, seed);
  const forks = await (io.buildForks ?? buildForks)({ sourcesRoot: sources, artifactsRoot: artifacts, toolchainRoot: toolchain, env, npmExecutable: npm, spawn: (command, args, options) => {
    const output = run(command, args, options.cwd);
    return { status: 0, stdout: output };
  } });
  const piSource = join(repo, 'sources/pi-ai');
  // This is the disposable container clone, never the real host source snapshot.
  run(npm, ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], piSource);
  const catalog = join(repo, 'tools/clean-install/catalog');
  const pi = await (io.preparePi ?? preparePi)({ sourceRoot: piSource, dependencyRoot: join(piSource, 'node_modules'), seedNodeModules: join(seed, 'node_modules'), artifactsRoot: join(artifacts, 'pi-ai'), expectedSourceDigest: snapshotDigest, catalogOverlay: await statOrNull(catalog) ? catalog : undefined }, { runner: (command, args, options) => run(command === 'npm' ? npm : command, args, options.cwd) });
  // Frozen frontend/vendor builds require their devDependencies. Only the final
  // installed graph and later manual CLI sessions use production mode.
  env.NODE_ENV = 'production';
  const pkg = runtimePackage({ tui: forks.components.tui.artifact, antigravity: forks.components.antigravity.artifact, pi: pi.artifact });
  await writePackage(paths.install, pkg);
  run(npm, installArgs, paths.install);
  const ptyPath = join(paths.install, 'node_modules/node-pty/package.json');
  let native = { package: 'node-pty', installed: false };
  if (await statOrNull(ptyPath)) {
    const pty = JSON.parse(await readFile(ptyPath, 'utf8'));
    assert.equal(pty.version, versions.nodePty, 'Native node-pty rebuild requires reviewed exact baseline');
    run(npm, ['rebuild', 'node-pty', '--ignore-scripts=false', '--no-audit', '--no-fund'], paths.install);
    native = { package: 'node-pty', version: pty.version, rebuilt: true, nodeHeaders: '/usr/local' };
  }
  const protocol = await (io.installProtocol ?? installProtocol)({ sessionRoot: join(paths.install, 'node_modules/@deepseek-ai/dsh-session') });
  const unifiedRecovery = await prepareUnifiedRecovery({ repo, esbuildModule: join(toolchain, 'node_modules/esbuild/lib/main.js') }, { build: io.buildUnifiedRecovery });
  const graph = await sharedGraph(paths.install);
  await symlink(join(paths.install, 'node_modules'), join(repo, 'node_modules'), 'dir');
  // Lazy: profile.mjs loads yaml at import time, which a fresh machine only has
  // after the runtime install above; an eager import fails before any work.
  const seedProfile = io.seedProfile ?? (await import('./profile.mjs')).seedProfile;
  const profile = await seedProfile({ home, installRoot: paths.install, repo }, { run });
  await mkdir(paths.bin, { recursive: true, mode: 0o700 });
  await symlink(join(paths.install, 'node_modules/.bin/dsh'), join(paths.bin, 'dsh'));
  const receipt = { schemaVersion: 1, status: 'installed-not-booted', paths, tools: versions, node: process.version, platform: process.platform, arch: process.arch, forks, pi, protocol, unifiedRecovery, native, graph, profile, packageLockSha256: sha(await readFile(join(paths.install, 'package-lock.json'))), commands, accountsUsed: false, credentialsUsed: false, modelCalls: 0, qualification: 'AG host source-built; auxiliary faces committed-prebuilt. No CLI boot, OAuth login or inference acceptance.' };
  await writeFile(join(paths.install, 'clean-install-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) return { help: 'Usage: node tools/clean-install/install.mjs --fresh (Docker-only, absent runtime/build and empty DSH home; no automatic model/auth launch)' };
  assert.deepEqual(args, ['--fresh'], 'Only explicit --fresh is supported');
  return installFresh();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
