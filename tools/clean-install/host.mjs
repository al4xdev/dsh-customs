#!/usr/bin/env node
// Host installation for a NEW machine whose ~/.dsh is restored by dotfiles. Same
// pinned pipeline as install.mjs (Docker), composed from its exported steps. Only
// these differences, all deliberate:
// - no /.dockerenv requirement, and the active Node (>=24) instead of exactly 24;
//   the runtime then runs on that same Node (node-pty is rebuilt against it);
// - node-pty headers come from the running Node's prefix (e.g. nvm), not /usr/local;
// - no profile seeding: dotfiles owns ~/.dsh. Profiles must already be portable
//   (tools/profile-portable.mjs). Only what dotfiles cannot carry is added, and only
//   where absent: fork dev checkouts that profile rows point at, the shared
//   node_modules links and the fish `dsh` launcher inside the runtime.
// Usage: node tools/clean-install/host.mjs --fresh   (network + build; no login/inference)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installationPaths, prepareUnifiedRecovery, runtimePackage, sharedGraph, snapshotDigest, versions } from './install.mjs';
import { buildForks, loadForkManifest } from './forks.mjs';
import { preparePi } from './pi.mjs';
import { installProtocol } from './protocol.mjs';

const repoDefault = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const statOrNull = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
// Dev checkouts referenced by profile rows (antigravity-tui-login, liangshen), at
// the same paths and branches as the lab; the runtime itself uses the packed pins.
const checkouts = [
  { id: 'tui', path: 'frontend/dsh-tui', branch: 'custom' },
  { id: 'antigravity', path: 'plugins/dsh-antigravity', branch: 'main' },
];

export async function installHost({ home = process.env.HOME, repo = repoDefault } = {}) {
  const paths = installationPaths(home, repo);
  assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node24 or newer required');
  assert.equal(await realpath(home), home, 'HOME must be canonical');
  assert.equal(await realpath(repo), repo, 'Repository must be canonical');
  for (const path of [paths.install, paths.build, join(repo, 'node_modules'), join(repo, 'sources/pi-ai/node_modules')]) {
    assert.equal(await statOrNull(path), null, `Fresh path already occupied: ${path}`);
  }
  const nodePrefix = dirname(dirname(process.execPath));
  assert(await statOrNull(join(nodePrefix, 'include/node/node.h')), 'Node headers missing next to the running Node');

  await mkdir(dirname(paths.install), { recursive: true, mode: 0o700 });
  await mkdir(paths.install, { mode: 0o700 });
  await mkdir(paths.build, { mode: 0o700 });
  const toolchain = join(paths.build, 'toolchain'), seed = join(paths.build, 'seed');
  const sources = join(paths.build, 'sources'), artifacts = join(paths.install, 'artifacts');
  for (const path of [toolchain, seed, sources, artifacts]) await mkdir(path, { mode: 0o700 });
  const config = join(paths.build, 'empty-npmrc'), globalConfig = join(paths.build, 'empty-global-npmrc');
  await writeFile(config, '', { flag: 'wx', mode: 0o600 });
  await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
  const env = { HOME: home, DSH_HOME: paths.dshHome, DSH_INSTALL_ROOT: paths.install, XDG_DATA_HOME: join(home, '.local/share'), XDG_CONFIG_HOME: join(paths.build, 'config'), XDG_CACHE_HOME: join(paths.build, 'cache'), PATH: process.env.PATH, NODE_ENV: 'development', DSH_TELEMETRY_DISABLED: '1', GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', npm_config_userconfig: config, npm_config_globalconfig: globalConfig, npm_config_cache: join(paths.build, 'npm-cache'), npm_config_nodedir: nodePrefix };

  const commands = [];
  function run(command, args, cwd) {
    process.stderr.write(`[host] ${command.split('/').pop()} ${args.join(' ')}  (in ${cwd})\n`);
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
    commands.push({ command, args, cwd, status: result.status ?? null });
    if (result.error || result.status !== 0) {
      if (result.stderr) process.stderr.write(String(result.stderr));
      throw new Error(`Host subprocess failed: ${command} ${args[0] ?? ''} (exit ${result.status})`);
    }
    return String(result.stdout ?? '');
  }
  const writePackage = (root, pkg) => writeFile(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', { flag: 'wx' });
  const installArgs = ['install', '--ignore-scripts', '--no-audit', '--no-fund'];

  await writePackage(toolchain, { private: true, dependencies: { npm: versions.npm, pnpm: versions.pnpm, esbuild: versions.esbuild } });
  run('npm', installArgs, toolchain);
  const npm = join(toolchain, 'node_modules/.bin/npm');
  env.PATH = join(toolchain, 'node_modules/.bin') + ':' + env.PATH;
  for (const [command, expected] of [[npm, versions.npm], [join(toolchain, 'node_modules/.bin/pnpm'), versions.pnpm], [join(toolchain, 'node_modules/.bin/esbuild'), versions.esbuild]]) {
    assert.equal(run(command, ['--version'], toolchain).trim(), expected);
  }
  await writePackage(seed, { private: true, dependencies: { '@deepseek-ai/dsh': versions.dsh, '@earendil-works/pi-ai': '0.87.1' } });
  run(npm, installArgs, seed);
  const manifest = await loadForkManifest();
  const forks = await buildForks({ sourcesRoot: sources, artifactsRoot: artifacts, toolchainRoot: toolchain, env, manifest, npmExecutable: npm,
    spawn: (command, args, options) => ({ status: 0, stdout: run(command, args, options.cwd) }) });

  // npm ci only adds the gitignored sources/pi-ai/node_modules; preparePi copies the
  // source into artifacts before patching/compiling, so the snapshot stays untouched.
  const piSource = join(repo, 'sources/pi-ai');
  run(npm, ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], piSource);
  const catalog = join(repo, 'tools/clean-install/catalog');
  const pi = await preparePi({ sourceRoot: piSource, dependencyRoot: join(piSource, 'node_modules'), seedNodeModules: join(seed, 'node_modules'), artifactsRoot: join(artifacts, 'pi-ai'), expectedSourceDigest: snapshotDigest, catalogOverlay: await statOrNull(catalog) ? catalog : undefined },
    { runner: (command, args, options) => run(command === 'npm' ? npm : command, args, options.cwd) });

  env.NODE_ENV = 'production';
  await writePackage(paths.install, runtimePackage({ tui: forks.components.tui.artifact, antigravity: forks.components.antigravity.artifact, pi: pi.artifact }));
  run(npm, installArgs, paths.install);
  const ptyPath = join(paths.install, 'node_modules/node-pty/package.json');
  let native = { package: 'node-pty', installed: false };
  if (await statOrNull(ptyPath)) {
    const pty = JSON.parse(await readFile(ptyPath, 'utf8'));
    assert.equal(pty.version, versions.nodePty, 'Native node-pty rebuild requires reviewed exact baseline');
    run(npm, ['rebuild', 'node-pty', '--ignore-scripts=false', '--no-audit', '--no-fund'], paths.install);
    native = { package: 'node-pty', version: pty.version, rebuilt: true, nodeHeaders: nodePrefix };
  }
  const protocol = await installProtocol({ sessionRoot: join(paths.install, 'node_modules/@deepseek-ai/dsh-session') });
  const unifiedRecovery = await prepareUnifiedRecovery({ repo, esbuildModule: join(toolchain, 'node_modules/esbuild/lib/main.js') });
  const graph = await sharedGraph(paths.install);
  await symlink(join(paths.install, 'node_modules'), join(repo, 'node_modules'), 'dir');

  const wiring = [];
  for (const checkout of checkouts) {
    const component = manifest.components.find(item => item.id === checkout.id);
    const target = join(repo, checkout.path);
    if (await statOrNull(target)) { wiring.push({ checkout: checkout.path, state: 'kept-existing' }); continue; }
    run('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--branch', checkout.branch, '--', component.repository, target], repo);
    const head = run('git', ['rev-parse', 'HEAD'], target).trim();
    // A branch that moved past the pin is reported, not silently reset.
    wiring.push({ checkout: checkout.path, branch: checkout.branch, head, matchesPin: head === component.commit });
  }
  await copyFile(join(repo, 'tools/dsh-launcher/local-model-launch.mjs'), join(paths.install, 'local-model-launch.mjs'));
  wiring.push({ launcher: join(paths.install, 'local-model-launch.mjs') });
  const profiles = join(paths.dshHome, 'profiles');
  for (const link of [join(profiles, 'node_modules'), join(profiles, 'dsh-tui', 'node_modules')]) {
    if (!await statOrNull(dirname(link))) { wiring.push({ link, state: 'skipped-no-profile' }); continue; }
    if (await statOrNull(link)) { wiring.push({ link, state: 'kept-existing' }); continue; }
    await symlink(join(paths.install, 'node_modules'), link, 'dir');
    wiring.push({ link, state: 'linked' });
  }

  const receipt = { schemaVersion: 1, status: 'installed-not-booted', variant: 'host (dotfiles-owned ~/.dsh)', paths, tools: versions, node: process.version, platform: process.platform, arch: process.arch, forks, pi, protocol, unifiedRecovery, native, graph, wiring, packageLockSha256: sha(await readFile(join(paths.install, 'package-lock.json'))), commands, accountsUsed: false, credentialsUsed: false, modelCalls: 0 };
  await writeFile(join(paths.install, 'host-install-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: receipt.status, node: receipt.node, native, graph, wiring };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--fresh') {
    console.log('Usage: node tools/clean-install/host.mjs --fresh (new host with dotfiles-restored ~/.dsh; network and build, no login or inference)');
    process.exitCode = args.length ? 2 : 0;
  } else {
    try { console.log(JSON.stringify(await installHost(), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
