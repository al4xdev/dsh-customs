#!/usr/bin/env node
// Metadata-only by default. Builders are deliberately fixed, not manifest-supplied shell code.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { inspectRecipe, reserveDestination, resolvePaths, validateManifest } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hash = data => createHash('sha256').update(data).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value, flag = 'wx') => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag, mode: 0o600 });
const inside = (path, root) => path === root || path.startsWith(root + sep);
const fail = message => { throw new Error(message); };
const strategies = { tui: 'frontend-recipe', 'pi-ai': 'pi-ai-recipe', antigravity: 'committed-prebuilt' };
const bindings = { tui: ['@deepseek-harness-tui/dsh-tui', '0.14.0', 'pnpm', '11.21.0'], 'pi-ai': ['@earendil-works/pi-ai', '0.87.1', 'npm', '12.2.0'], antigravity: ['@deepseek-ai/dsh-llm-pi-ai-antigravity', '0.1.0-rc.5', 'npm', '12.2.0'] };
const installArgs = ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
export const nativeRunner = (command, args, options) => execFileSync(command, args, {
  ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false,
});

export function parseArgs(args) {
  const result = { mode: 'doctor', json: false, allowNetwork: false, allowBuild: false };
  let mode;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail(`Duplicate flag: ${arg}`);
    seen.add(arg);
    if (['--doctor', '--plan', '--prepare', '--bootstrap', '--help'].includes(arg)) {
      if (mode) fail('Choose one mode');
      mode = arg.slice(2); result.mode = mode;
    } else if (arg === '--json') result.json = true;
    else if (arg === '--allow-network') result.allowNetwork = true;
    else if (arg === '--allow-build') result.allowBuild = true;
    else if (arg === '--destination') {
      if (!args[i + 1] || !isAbsolute(args[i + 1]) || args[i + 1].split(sep).includes('..')) fail('Destination must be absolute without traversal');
      result.destination = args[++i];
    } else fail(`Unknown flag or positional target: ${arg}`);
  }
  if (['plan', 'prepare', 'bootstrap'].includes(result.mode) && !result.destination) fail('--destination ABS is required');
  if (['doctor', 'help'].includes(result.mode) && result.destination) fail('This mode does not accept a destination');
  if (result.mode !== 'bootstrap' && (result.allowNetwork || result.allowBuild)) fail('Consent flags are only valid with --bootstrap');
  if (result.mode === 'bootstrap' && !(result.allowNetwork && result.allowBuild)) fail('--bootstrap requires --allow-network and --allow-build');
  return result;
}

function executableAvailable(name, env) {
  return (env.PATH ?? '').split(sep === '/' ? ':' : ';').filter(Boolean).some(root => {
    try { const path = join(root, name); accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  });
}
export function doctor({ repo, manifest, env = process.env, nodeVersion = process.versions.node }) {
  validateManifest(manifest);
  const inspection = inspectRecipe({ repo, manifest });
  const issues = [...inspection.issues];
  if (manifest.runtime.version !== '0.2.0-rc.2') issues.push('Unsupported reviewed runtime pin');
  if (Number(nodeVersion.split('.')[0]) < manifest.prerequisites.nodeMajorMinimum) issues.push(`Node >=${manifest.prerequisites.nodeMajorMinimum} required`);
  for (const name of ['git', 'npm']) if (!executableAvailable(name, env)) issues.push(`${name} executable missing from PATH`);
  if (manifest.components.length !== 3 || Object.keys(strategies).some(id => !manifest.components.some(c => c.id === id))) issues.push('Exactly tui, pi-ai and antigravity are required');
  for (const c of manifest.components) {
    if (strategies[c.id] !== c.build.strategy) issues.push(`${c.id}: unsupported reviewed strategy`);
    if (JSON.stringify([c.package, c.version, c.packageManager.name, c.packageManager.version]) !== JSON.stringify(bindings[c.id])) issues.push(`${c.id}: unsupported reviewed package/package-manager binding`);
  }
  for (const path of ['tools/task10-frontend/bootstrap.mjs', 'tools/task10-frontend/recipe.json', 'tools/pi-ai-fork/prepare.mjs']) {
    if (!existsSync(join(repo, path))) issues.push(`Missing reviewed builder: ${path}`);
  }
  try {
    const recipe = json(join(repo, 'tools/task10-frontend/recipe.json'));
    const tui = manifest.components.find(c => c.id === 'tui');
    if (recipe.base !== tui?.commit || recipe.url !== tui?.repository || recipe.pnpm !== '11.21.0' || recipe.patchSha256 !== tui?.patch?.sha256) issues.push('Frontend recipe does not match manifest pins');
    if (recipe.package !== tui?.package || recipe.version !== tui?.version || tui?.submodules?.length !== 1 || tui.submodules[0].path !== 'vendor/dsh-std' || tui.submodules[0].commit !== recipe.vendorDshStd) issues.push('Frontend package/vendor binding does not match manifest');
  } catch (error) { issues.push(`Frontend recipe: ${error.message}`); }
  return { ready: issues.length === 0, issues, components: inspection.components, prerequisites: { nodeVersion, minimum: manifest.prerequisites.nodeMajorMinimum }, limitations: ['Antigravity packages committed prebuilt lib; no standalone rebuild.', 'AG browser-client integration is not verified; obsolete type-only client peer is optional.', 'TUI artifact is not activated in any profile.', 'Initial npm transitive resolution is mutable; resulting lockfile is sealed in receipt.'] };
}

function checkDestination(paths, env = process.env) {
  const target = paths.destination;
  if (!target || !isAbsolute(target)) fail('Destination must be absolute');
  if (lstatSync(target, { throwIfNoEntry: false })) fail('Destination already exists');
  const parent = dirname(target);
  if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) fail('Destination parent must be canonical non-symlink directory');
  const repo = realpathSync(paths.repo);
  // Scratch under .dumps is allowed; source/plugin trees and their ancestors are not.
  if ((inside(target, repo) && !inside(target, join(repo, '.dumps'))) || inside(repo, target)) fail('Destination overlaps source/plugin repository');
  const envRoots = Object.entries(env).filter(([key, value]) => /^(?:XDG_(?:CONFIG|CACHE)_HOME|npm_config_(?:cache|prefix|userconfig|globalconfig)|PNPM_(?:HOME|STORE_DIR))$/i.test(key) && typeof value === 'string' && isAbsolute(value)).map(([, value]) => resolve(value));
  for (const root of [paths.dshHome, paths.runtime, paths.home, ...['.npm', '.config', '.cache'].map(name => join(paths.home, name)), ...envRoots]) {
    const canonical = existsSync(root) ? realpathSync(root) : root;
    if (inside(canonical, target) || (root !== paths.home && (inside(target, root) || inside(target, canonical)))) fail(`Destination overlaps protected root: ${root}`);
  }
  for (let cursor = parent;; cursor = dirname(cursor)) {
    if (cursor === repo && inside(target, join(repo, '.dumps'))) break;
    if (lstatSync(join(cursor, '.git'), { throwIfNoEntry: false })) fail('Destination is inside another Git tree');
    if (cursor === dirname(cursor)) break;
  }
  return target;
}

export function createPlan({ paths, manifest, env, nodeVersion }) {
  const report = doctor({ repo: paths.repo, manifest, env, nodeVersion });
  if (!report.ready) fail(`Recipe not ready: ${report.issues.join('; ')}`);
  checkDestination(paths, env);
  const dst = paths.destination;
  const steps = [{ id: 'seed-runtime', command: 'npm', args: [...installArgs], cwd: join(dst, 'runtime') }];
  for (const c of manifest.components) {
    const source = join(dst, 'sources', c.id), artifacts = join(dst, 'artifacts', c.id);
    if (c.id === 'tui') steps.push({ id: 'tui', command: 'node', args: [join(paths.repo, 'tools/task10-frontend/bootstrap.mjs'), '--bootstrap', source, artifacts], cwd: paths.repo });
    else {
      steps.push({ id: `${c.id}-clone`, command: 'git', args: ['clone', '--no-checkout', c.repository, source], cwd: dst },
        { id: `${c.id}-checkout`, command: 'git', args: ['checkout', '--detach', c.commit], cwd: source });
      if (c.patch) steps.push(
        { id: `${c.id}-patch-check`, command: 'git', args: ['apply', '--check', join(paths.repo, c.patch.path)], cwd: source },
        { id: `${c.id}-patch`, command: 'git', args: ['apply', join(paths.repo, c.patch.path)], cwd: source });
      if (c.id === 'pi-ai') steps.push({ id: 'pi-ai-deps', command: 'npm', args: ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd: source },
        { id: 'pi-ai', command: 'node', args: [join(paths.repo, 'tools/pi-ai-fork/prepare.mjs'), source, join(dst, 'runtime/node_modules'), artifacts], cwd: paths.repo });
      else steps.push({ id: 'antigravity', command: 'npm', args: ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], cwd: source });
    }
  }
  steps.push({ id: 'finalize-runtime', command: 'npm', args: [...installArgs], cwd: join(dst, 'runtime') });
  return { schemaVersion: 1, destination: dst, runtime: manifest.runtime, steps, limitations: report.limitations };
}

function seed(manifest) {
  return { name: 'dsh-workshop-private-runtime', version: '0.0.0', private: true, dependencies: { [manifest.runtime.package]: manifest.runtime.version, '@earendil-works/pi-ai': '0.87.1', pnpm: '11.21.0', npm: '12.2.0' } };
}
function isolateEnvironment(dst, runtime, inherited) {
  const home = join(dst, 'home'), cache = join(dst, 'cache');
  const tmp = join(cache, 'tmp');
  for (const path of [home, cache, tmp]) mkdirSync(path, { mode: 0o700 });
  const userconfig = join(cache, 'npm-userconfig'), globalconfig = join(cache, 'npm-globalconfig'), gitconfig = join(home, 'gitconfig');
  for (const path of [userconfig, globalconfig, gitconfig]) writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  // Inherited package-manager/Git knobs can redirect otherwise safe commands into live trees.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(?:npm_config_|PNPM_|GIT_CONFIG|GIT_TEMPLATE_DIR$|GIT_DIR$|GIT_WORK_TREE$|GIT_INDEX_FILE$|GIT_COMMON_DIR$|GIT_OBJECT_DIRECTORY$|GIT_ALTERNATE_OBJECT_DIRECTORIES$|GIT_QUARANTINE_PATH$)/i.test(key)));
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: cache, DSH_HOME: join(home, '.dsh'), npm_config_cache: join(cache, 'npm'), npm_config_store_dir: join(cache, 'pnpm-store'), npm_config_state_dir: join(cache, 'pnpm-state'), npm_config_cache_dir: join(cache, 'pnpm'), npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', PATH: join(runtime, 'node_modules/.bin') + ':' + (inherited.PATH ?? '') });
  Object.assign(env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
  return { env, paths: { home, cache, tmp, userconfig, globalconfig, gitconfig } };
}
function packedManifest(path) {
  const tar = gunzipSync(readFileSync(path));
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/, '');
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, '').trim(), 8);
    if (!name) break;
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) fail('Invalid package tar archive');
    if (name === 'package/package.json') return JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  fail('Package tarball has no manifest');
}
function artifactProof(path, root) {
  const canonical = realpathSync(path);
  if (!inside(canonical, root) || !lstatSync(canonical).isFile() || !canonical.endsWith('.tgz')) fail('Artifact must be a regular tarball inside its staging root');
  return { path: canonical, sha256: hash(readFileSync(canonical)) };
}
function inspectPrebuilt(source) {
  const root = join(source, 'lib'), digest = createHash('sha256');
  let javascriptFiles = 0;
  const visit = path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || realpathSync(path) !== path || !inside(path, root)) fail('Antigravity lib must contain canonical non-symlink paths');
    if (stat.isDirectory()) { for (const name of readdirSync(path).sort()) visit(join(path, name)); }
    else if (stat.isFile()) {
      const bytes = readFileSync(path); digest.update(path.slice(root.length)).update(bytes);
      if (/\.(?:js|mjs|cjs)$/.test(path)) {
        javascriptFiles++;
        if (bytes.includes(Buffer.from('@deepseek-ai/dsh-client-runtime'))) fail('Antigravity prebuilt JavaScript references optional client runtime');
      }
    } else fail('Antigravity lib contains unsupported entry');
  };
  visit(root);
  if (!javascriptFiles) fail('Antigravity prebuilt JavaScript missing');
  return { javascriptFiles, libSha256: digest.digest('hex'), clientRuntimeReferenceAbsent: true, browserClientVerified: false };
}
function verifyRuntime(runtime, manifest, piVersion) {
  const modules = join(runtime, 'node_modules');
  const host = json(join(modules, '@deepseek-ai/dsh/package.json'));
  const adapterPath = join(modules, '@deepseek-ai/dsh-llm-pi-ai');
  const adapter = json(join(adapterPath, 'package.json'));
  if (host.name !== manifest.runtime.package || host.version !== manifest.runtime.version || adapter.name !== '@deepseek-ai/dsh-llm-pi-ai' || adapter.version !== '0.2.0-rc.2') fail('Runtime/adapter manifest identity mismatch');
  // Resolve dependency identities without importing providers or touching credentials.
  const dependencyPath = (from, name) => {
    for (let cursor = from; inside(cursor, runtime); cursor = dirname(cursor)) {
      const candidate = join(cursor, 'node_modules', name, 'package.json');
      if (existsSync(candidate)) return realpathSync(candidate);
      if (cursor === runtime) break;
    }
    fail(`Missing shared dependency: ${name}`);
  };
  const ag = manifest.components.find(c => c.id === 'antigravity');
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-scope']) {
    const hostIdentity = dependencyPath(join(modules, '@deepseek-ai/dsh'), name);
    for (const plugin of [adapterPath, join(modules, ag.package)]) {
      if (dependencyPath(plugin, name) !== hostIdentity) fail(`Plugin duplicate identity: ${name}`);
    }
  }
  const piManifestPath = dependencyPath(adapterPath, '@earendil-works/pi-ai');
  const pi = json(piManifestPath);
  if (pi.name !== '@earendil-works/pi-ai' || pi.version !== piVersion) fail('Adapter/pi manifest identity mismatch');
  const installedAg = json(dependencyPath(join(modules, '@deepseek-ai/dsh'), ag.package));
  if (installedAg.name !== ag.package || installedAg.version !== ag.version) fail('Antigravity manifest identity mismatch');
  return { host: host.version, adapter: adapter.version, pi: pi.version, piManifestPath, sharedIdentity: true };
}

export function executePlan({ paths, manifest, plan, bootstrap = false, runner = nativeRunner, env = process.env }) {
  // Revalidate immediately before exclusive reservation, even for caller-supplied plans.
  const fresh = createPlan({ paths, manifest, env });
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) fail('Plan differs from reviewed recipe');
  checkDestination(paths, env);
  const dst = reserveDestination(paths.destination, [paths.dshHome, paths.runtime]);
  const receiptPath = join(dst, 'receipt.json');
  const receipt = { schemaVersion: 1, status: 'preparing', installed: false, destination: dst, manifestSha256: hash(JSON.stringify(manifest)), commands: [], artifacts: {}, sources: {}, limitations: plan.limitations };
  save(receiptPath, receipt);
  const persist = () => save(receiptPath, receipt, 'w');
  try {
    save(join(dst, 'manifest.json'), manifest); save(join(dst, 'plan.json'), plan);
    receipt.manifestSha256 = hash(readFileSync(join(dst, 'manifest.json'))); persist();
    const runtime = join(dst, 'runtime'); mkdirSync(runtime, { mode: 0o700 }); save(join(runtime, 'package.json'), seed(manifest));
    if (!bootstrap) { receipt.status = 'prepared'; persist(); return receipt; }
    mkdirSync(join(dst, 'sources'), { mode: 0o700 }); mkdirSync(join(dst, 'artifacts'), { mode: 0o700 });
    const isolation = isolateEnvironment(dst, runtime, env);
    const childEnv = isolation.env; receipt.isolation = isolation.paths; persist();
    const run = (command, args, cwd, id) => {
      const entry = { id, command, args, cwd, status: 'running' }; receipt.commands.push(entry); persist();
      try { const output = runner(command, args, { cwd, env: childEnv }); entry.status = 'ok'; persist(); return String(output ?? '').trim(); }
      catch (error) { entry.status = 'failed'; entry.exitCode = Number.isInteger(error.status) ? error.status : null; persist(); throw new Error(`Command failed: ${id}`); }
    };
    receipt.tools = { node: process.versions.node, seedNpm: run('npm', ['--version'], dst, 'seed-npm-version') }; persist();
    const sourceCheck = c => {
      const source = join(dst, 'sources', c.id);
      if (run('git', ['rev-parse', 'HEAD'], source, `${c.id}-pin`) !== c.commit) fail(`${c.id}: source pin mismatch`);
      if (c.id !== 'tui' && run('git', ['status', '--porcelain'], source, `${c.id}-clean`)) fail(`${c.id}: source is not clean`);
      for (const submodule of c.submodules ?? []) if (run('git', ['-C', submodule.path, 'rev-parse', 'HEAD'], source, `${c.id}-submodule`) !== submodule.commit) fail(`${c.id}: submodule pin mismatch`);
      receipt.sources[c.id] = { repository: c.repository, commit: c.commit, patch: c.patch ?? null, patches: c.id === 'tui' && c.patch ? [{ ...c.patch, status: 'applied-by-reviewed-recipe' }] : [] }; persist();
    };
    for (const step of plan.steps) {
      const patchComponent = manifest.components.find(c => step.id === `${c.id}-patch-check` || step.id === `${c.id}-patch`);
      if (patchComponent && hash(readFileSync(join(paths.repo, patchComponent.patch.path))) !== patchComponent.patch.sha256) fail('Source patch integrity changed');
      if (step.id === 'antigravity') {
        const c = manifest.components.find(c => c.id === 'antigravity');
        if (!run('git', ['ls-files', 'lib'], step.cwd, 'antigravity-prebuilt').trim()) fail('Antigravity committed lib missing');
        run('git', ['diff', '--exit-code', 'HEAD', '--', 'lib'], step.cwd, 'antigravity-prebuilt-unchanged');
        receipt.sources.antigravity.prebuilt = inspectPrebuilt(step.cwd);
        if (c.patch && json(join(step.cwd, 'package.json')).peerDependenciesMeta?.['@deepseek-ai/dsh-client-runtime']?.optional !== true) fail('Antigravity client peer patch was not applied');
        persist();
        mkdirSync(join(dst, 'artifacts/antigravity'), { mode: 0o700 });
        if (c.build.strategy !== 'committed-prebuilt') fail('Unsupported Antigravity builder');
      }
      if (step.id === 'finalize-runtime') {
        const pkg = json(join(runtime, 'package.json'));
        // Donor is needed only while preparing pi; final override remains adapter-scoped.
        delete pkg.dependencies['@earendil-works/pi-ai'];
        pkg.overrides = { '@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2': { '@earendil-works/pi-ai': `file:${receipt.artifacts['pi-ai'].path}` } };
        const ag = manifest.components.find(c => c.id === 'antigravity');
        pkg.dependencies[ag.package] = `file:${receipt.artifacts.antigravity.path}`;
        save(join(runtime, 'package.json'), pkg, 'w');
      }
      run(step.command, step.args, step.cwd, step.id);
      if (patchComponent && step.id === `${patchComponent.id}-patch`) {
        receipt.sources[patchComponent.id].patches.push({ ...patchComponent.patch, status: 'applied' }); persist();
      }
      if (step.id === 'seed-runtime') {
        receipt.tools.npm = run('npm', ['--version'], runtime, 'staged-npm-version');
        receipt.tools.pnpm = run('pnpm', ['--version'], runtime, 'staged-pnpm-version');
        if (receipt.tools.npm !== '12.2.0' || receipt.tools.pnpm !== '11.21.0') fail('Staged package manager pin mismatch');
        persist();
      }
      const component = manifest.components.find(c => step.id === `${c.id}-checkout` || (c.id === 'tui' && step.id === 'tui'));
      if (component) sourceCheck(component);
      if (['tui', 'pi-ai', 'antigravity'].includes(step.id)) {
        const expectedRoot = join(dst, 'artifacts', step.id);
        const root = realpathSync(expectedRoot);
        if (root !== expectedRoot) fail('Artifact staging root must not be a symlink');
        let artifact;
        if (step.id === 'tui') {
          const proof = json(join(root, 'receipt.json'));
          artifact = artifactProof(join(root, proof.tarball), root);
          if (artifact.sha256 !== proof.tarballSha256 || proof.patchSha256 !== manifest.components.find(c => c.id === 'tui').patch.sha256) fail('Frontend receipt proof mismatch');
        } else if (step.id === 'pi-ai') {
          const children = readdirSync(root).filter(name => existsSync(join(root, name, 'provenance.json')));
          if (children.length !== 1) fail('Expected one pi-ai provenance directory');
          const proof = json(join(root, children[0], 'provenance.json'));
          if (proof.sourceCommit !== manifest.components.find(c => c.id === 'pi-ai').commit) fail('pi-ai provenance pin mismatch');
          artifact = { ...artifactProof(proof.artifact, root), version: proof.version, catalogHash: proof.catalogHash };
        } else {
          const names = readdirSync(root).filter(name => name.endsWith('.tgz'));
          if (names.length !== 1) fail('Expected one Antigravity tarball');
          artifact = artifactProof(join(root, names[0]), root);
        }
        const packed = packedManifest(artifact.path);
        const expected = manifest.components.find(c => c.id === step.id);
        const expectedVersion = step.id === 'pi-ai' ? artifact.version : expected.version;
        if (packed.name !== expected.package || packed.version !== expectedVersion) fail(`${step.id}: artifact package identity mismatch`);
        if (step.id === 'pi-ai' && !/^0\.87\.1\+alex\.codex-default\.[a-f0-9]{12}$/.test(packed.version)) fail('Invalid pi-ai fork version');
        if (step.id === 'antigravity' && expected.patch && packed.peerDependenciesMeta?.['@deepseek-ai/dsh-client-runtime']?.optional !== true) fail('Packed Antigravity client peer is not optional');
        artifact.package = packed.name; artifact.version = packed.version;
        receipt.artifacts[step.id] = artifact; persist();
      }
    }
    receipt.runtime = verifyRuntime(runtime, manifest, receipt.artifacts['pi-ai'].version);
    receipt.lockSha256 = hash(readFileSync(join(runtime, 'package-lock.json')));
    receipt.status = 'bootstrapped'; receipt.installed = true; receipt.profileActivated = false; persist(); return receipt;
  } catch (error) {
    receipt.status = 'failed'; receipt.error = error.message; persist(); throw error;
  }
}

export function main(args = process.argv.slice(2), options = {}) {
  const flags = parseArgs(args);
  if (flags.mode === 'help') return { help: 'Usage: bootstrap.mjs [--doctor [--json] | --plan --destination ABS | --prepare --destination ABS | --bootstrap --destination ABS --allow-network --allow-build] [--json]' };
  const paths = resolvePaths({ repo: options.repo ?? resolve(here, '../..'), ...options.paths, destination: flags.destination });
  const manifest = options.manifest ?? json(join(paths.repo, 'tools/workshop/manifest.json'));
  if (flags.mode === 'doctor') return doctor({ repo: paths.repo, manifest, env: options.env });
  const plan = createPlan({ paths, manifest, env: options.env });
  return flags.mode === 'plan' ? plan : executePlan({ paths, manifest, plan, bootstrap: flags.mode === 'bootstrap', runner: options.runner, env: options.env });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const output = main(); console.log(output.help ?? JSON.stringify(output, null, 2)); if (output.ready === false) process.exitCode = 1; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
