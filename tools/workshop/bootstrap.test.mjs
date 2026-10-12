import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createPlan, doctor, executePlan, main, parseArgs } from './bootstrap.mjs';
import { resolvePaths } from './core.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const put = (path, value) => writeFileSync(path, JSON.stringify(value));
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const piVersion = '0.87.1+alex.codex-default.123456789abc';
function fixture() {
  const scratch = resolve('.dumps/workshop-bootstrap-tests'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'case-'));
  const repo = join(root, 'repo'), home = join(root, 'home'); mkdirSync(repo); mkdirSync(home);
  for (const name of ['workshop', 'task10-frontend', 'pi-ai-fork']) mkdirSync(join(repo, 'tools', name), { recursive: true });
  writeFileSync(join(repo, 'tools/task10-frontend/bootstrap.mjs'), '// fixture only');
  writeFileSync(join(repo, 'tools/pi-ai-fork/prepare.mjs'), '// fixture only');
  const patch = 'reviewed patch'; writeFileSync(join(repo, 'tools/workshop/tui.patch'), patch);
  const manifest = {
    schemaVersion: 1, runtime: { package: '@deepseek-ai/dsh', version: '0.2.0-rc.2' }, prerequisites: { nodeMajorMinimum: 24 },
    components: [
      { id: 'tui', package: '@deepseek-harness-tui/dsh-tui', version: '0.14.0', submodules: [{ path: 'vendor/dsh-std', commit: '4'.repeat(40) }], build: { strategy: 'frontend-recipe', commands: [{ command: 'node', args: [], cwd: '.' }] } },
      { id: 'pi-ai', package: '@earendil-works/pi-ai', version: '0.87.1', build: { strategy: 'pi-ai-recipe', commands: [{ command: 'node', args: [], cwd: '.' }] } },
      { id: 'antigravity', package: '@deepseek-ai/dsh-llm-pi-ai-antigravity', version: '0.1.0-rc.5', build: { strategy: 'committed-prebuilt', commands: [{ command: 'npm', args: [], cwd: '.' }] } },
    ].map((c, i) => ({ ...c, role: 'fixture', repository: `https://github.com/fixture/${c.id}`, commit: String(i + 1).repeat(40), packageManager: { name: c.id === 'tui' ? 'pnpm' : 'npm', version: c.id === 'tui' ? '11.21.0' : '12.2.0' }, reproduction: { status: 'ready' }, ...(c.id === 'tui' ? { patch: { path: 'tools/workshop/tui.patch', sha256: digest(patch) } } : {}) })),
  };
  const agPatch = 'fixture reviewed optional client peer patch';
  writeFileSync(join(repo, 'tools/workshop/antigravity.patch'), agPatch);
  manifest.components[2].patch = { path: 'tools/workshop/antigravity.patch', sha256: digest(agPatch) };
  const tui = manifest.components[0];
  put(join(repo, 'tools/task10-frontend/recipe.json'), { base: tui.commit, url: tui.repository, pnpm: '11.21.0', patchSha256: tui.patch.sha256, package: tui.package, version: tui.version, vendorDshStd: tui.submodules[0].commit });
  put(join(repo, 'tools/workshop/manifest.json'), manifest);
  mkdirSync(join(repo, '.dumps'));
  const paths = resolvePaths({ repo, home, xdgDataHome: join(home, '.local/share'), dshHome: join(home, '.dsh'), destination: join(repo, '.dumps/stage') });
  return { root, repo, home, manifest, paths };
}
function tarball(path, pkg) {
  // Minimal USTAR fixture; no packaging executable or network is invoked.
  const data = Buffer.from(JSON.stringify(pkg)), header = Buffer.alloc(512);
  header.write('package/package.json'); header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  writeFileSync(path, gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)])));
}
function mockRunner(f, { failAt, wrongArtifact = false, duplicateCordis = false, clientRuntimeReference = false, symlinkLib = false } = {}) {
  const calls = [];
  const pkg = (root, name, version) => { const dir = join(root, name); mkdirSync(dir, { recursive: true }); put(join(dir, 'package.json'), { name, version }); };
  const runner = (command, args, options) => {
    calls.push({ command, args, ...options });
    if (failAt && args.includes(failAt)) throw Object.assign(new Error('secret-like stderr intentionally not persisted'), { status: 7 });
    const dst = f.paths.destination, modules = join(dst, 'runtime/node_modules');
    if (args[0] === '--version') return command === 'pnpm' ? '11.21.0' : '12.2.0';
    if (command === 'npm' && args[0] === 'install') {
      mkdirSync(modules, { recursive: true });
      pkg(modules, '@deepseek-ai/dsh', '0.2.0-rc.2'); pkg(modules, '@deepseek-ai/dsh-llm-pi-ai', '0.2.0-rc.2');
      pkg(modules, '@earendil-works/pi-ai', existsSync(join(dst, 'artifacts/pi-ai')) ? piVersion : '0.87.1');
      pkg(modules, '@deepseek-ai/cordis', '4.0.0'); pkg(modules, '@deepseek-ai/dsh-scope', '0.2.0-rc.2');
      pkg(modules, f.manifest.components[2].package, f.manifest.components[2].version);
      if (duplicateCordis) pkg(join(modules, '@deepseek-ai/dsh-llm-pi-ai/node_modules'), '@deepseek-ai/cordis', '4.0.0');
      put(join(dst, 'runtime/package-lock.json'), { fixture: true });
    }
    if (command === 'git') {
      if (args[0] === 'clone') {
        const source = args.at(-1); mkdirSync(source);
        if (source.endsWith('/antigravity')) {
          const c = f.manifest.components[2];
          put(join(source, 'package.json'), { name: c.package, version: c.version, peerDependencies: { '@deepseek-ai/dsh-client-runtime': '*' } });
          mkdirSync(join(source, 'lib'));
          writeFileSync(join(source, 'lib/index.js'), clientRuntimeReference ? "import '@deepseek-ai/dsh-client-runtime';" : 'export const fixture = true;');
          if (symlinkLib) symlinkSync(join(source, 'package.json'), join(source, 'lib/linked.js'));
        }
      }
      if (args[0] === 'apply' && !args.includes('--check')) {
        const manifestPath = join(options.cwd, 'package.json'), pkg = load(manifestPath);
        pkg.peerDependenciesMeta = { '@deepseek-ai/dsh-client-runtime': { optional: true } }; put(manifestPath, pkg);
      }
      if (args[0] === 'rev-parse') return f.manifest.components.find(c => options.cwd.endsWith('/' + c.id)).commit;
      if (args[0] === '-C') return f.manifest.components[0].submodules[0].commit;
      if (args[0] === 'status') return '';
      if (args[0] === 'ls-files') return 'lib/index.js';
    }
    if (command === 'node' && args.includes('--bootstrap')) {
      const source = args.at(-2), artifacts = args.at(-1), c = f.manifest.components[0]; mkdirSync(source); mkdirSync(artifacts);
      tarball(join(artifacts, 'tui.tgz'), { name: c.package, version: c.version });
      put(join(artifacts, 'receipt.json'), { tarball: 'tui.tgz', tarballSha256: digest(readFileSync(join(artifacts, 'tui.tgz'))), patchSha256: c.patch.sha256 });
    }
    if (command === 'node' && args[0].endsWith('prepare.mjs')) {
      const artifacts = join(args.at(-1), 'hash-catalog'); mkdirSync(artifacts, { recursive: true });
      const artifact = join(artifacts, 'pi.tgz'); tarball(artifact, { name: wrongArtifact ? '@evil/pi' : '@earendil-works/pi-ai', version: piVersion });
      put(join(artifacts, 'provenance.json'), { artifact, version: piVersion, sourceCommit: f.manifest.components[1].commit, catalogHash: 'a'.repeat(64) });
    }
    if (command === 'npm' && args[0] === 'pack') {
      tarball(join(args.at(-1), 'ag.tgz'), load(join(options.cwd, 'package.json')));
    }
    return '';
  };
  return { calls, runner };
}

test('CLI fails closed for unknown flags, targets, mixed modes and missing consent', () => {
  for (const args of [['--wat'], ['target'], ['--doctor', '--plan'], ['--prepare'], ['--bootstrap', '--destination', '/tmp/test'], ['--doctor', '--allow-build'], ['--destination', 'relative'], ['--json', '--json']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs([]).mode, 'doctor'); assert.equal(parseArgs(['--help']).mode, 'help');
});

test('doctor/default and plan are metadata-only and do not invoke runner or reserve target', () => {
  const f = fixture(), before = readdirSync(f.root), mock = mockRunner(f);
  assert.equal(main([], { repo: f.repo, runner: mock.runner }).ready, true);
  const plan = createPlan(f);
  assert(plan.steps.some(step => step.id === 'finalize-runtime'));
  assert.equal(mock.calls.length, 0); assert.equal(existsSync(f.paths.destination), false);
  assert.deepEqual(readdirSync(f.root), before);
  assert.match(plan.limitations.join(' '), /prebuilt/);
});

test('blocked, missing, corrupted recipes and unsupported builders fail before writes/processes', () => {
  for (const change of [f => { f.manifest.components[1].reproduction = { status: 'blocked', reason: 'not reviewed' }; }, f => { f.manifest.components[0].patch.sha256 = '0'.repeat(64); }, f => { f.manifest.components[2].build.strategy = 'bundle'; }]) {
    const f = fixture(); change(f); const mock = mockRunner(f);
    assert.throws(() => createPlan(f), /not ready/); assert.equal(existsSync(f.paths.destination), false); assert.equal(mock.calls.length, 0);
  }
  const f = fixture(); assert.throws(() => main([], { repo: join(f.root, 'absent') }));
  assert.equal(doctor({ ...f, nodeVersion: '22.0.0' }).ready, false);
});

test('prepare reserves private target and writes snapshots/seed/receipt but runs nothing', () => {
  const f = fixture(), mock = mockRunner(f), plan = createPlan(f);
  const receipt = executePlan({ ...f, plan, runner: mock.runner });
  assert.equal(receipt.status, 'prepared'); assert.equal(receipt.installed, false); assert.equal(mock.calls.length, 0);
  assert.deepEqual(load(join(f.paths.destination, 'manifest.json')), f.manifest);
  const seed = load(join(f.paths.destination, 'runtime/package.json'));
  assert.equal(seed.dependencies.pnpm, '11.21.0'); assert.equal(seed.dependencies.npm, '12.2.0');
  assert.equal(seed.dependencies['@earendil-works/pi-ai'], '0.87.1');
  assert.equal(receipt.manifestSha256, digest(readFileSync(join(f.paths.destination, 'manifest.json'))));
  assert.throws(() => executePlan({ ...f, plan }), /exists/);
});

test('plan protects existing/symlink/noncanonical/source/live runtime destinations', () => {
  const f = fixture();
  for (const destination of [f.repo, join(f.repo, 'new'), f.home, f.paths.runtime, f.paths.dshHome]) assert.throws(() => createPlan({ ...f, paths: { ...f.paths, destination } }));
  const alias = join(f.root, 'alias'); symlinkSync(f.home, alias);
  assert.throws(() => createPlan({ ...f, paths: { ...f.paths, destination: join(alias, 'new') } }), /canonical/);
  const dump = join(f.repo, '.dumps');
  assert.equal(createPlan({ ...f, paths: { ...f.paths, destination: join(dump, 'new') } }).destination, join(dump, 'new'));
});

test('mock bootstrap builds reviewed artifacts, scopes override, seals lock and leaves TUI inactive', () => {
  const f = fixture(), mock = mockRunner(f), plan = createPlan(f);
  const receipt = executePlan({ ...f, plan, bootstrap: true, runner: mock.runner });
  assert.equal(receipt.status, 'bootstrapped'); assert.equal(receipt.profileActivated, false);
  assert.equal(receipt.runtime.sharedIdentity, true); assert.match(receipt.lockSha256, /^[a-f0-9]{64}$/);
  const host = load(join(f.paths.destination, 'runtime/package.json'));
  assert.equal(host.overrides['@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2']['@earendil-works/pi-ai'], 'file:' + receipt.artifacts['pi-ai'].path);
  assert.equal(host.dependencies[f.manifest.components[0].package], undefined);
  assert(mock.calls.every(call => call.env.PATH.startsWith(join(f.paths.destination, 'runtime/node_modules/.bin'))));
  assert(!mock.calls.some(call => call.args.includes('bundle') || call.args.includes('--legacy-peer-deps')));
  assert.equal(receipt.commands.every(c => c.status === 'ok'), true);
  const ids = plan.steps.map(step => step.id);
  assert(ids.indexOf('antigravity-checkout') < ids.indexOf('antigravity-patch-check'));
  assert(ids.indexOf('antigravity-patch-check') < ids.indexOf('antigravity-patch'));
  assert(ids.indexOf('antigravity-patch') < ids.indexOf('antigravity'));
  assert(!ids.includes('tui-patch'));
  assert.deepEqual(receipt.sources.antigravity.patches, [{ ...f.manifest.components[2].patch, status: 'applied' }]);
  assert.equal(receipt.sources.antigravity.prebuilt.clientRuntimeReferenceAbsent, true);
  assert.equal(receipt.sources.antigravity.prebuilt.browserClientVerified, false);
  assert.match(receipt.sources.antigravity.prebuilt.libSha256, /^[a-f0-9]{64}$/);
});

test('command failure preserves partial staging and failed receipt without stderr/secrets', () => {
  const f = fixture(), mock = mockRunner(f, { failAt: 'ci' }), plan = createPlan(f);
  assert.throws(() => executePlan({ ...f, plan, bootstrap: true, runner: mock.runner }), /Command failed/);
  const receipt = load(join(f.paths.destination, 'receipt.json'));
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.installed, false);
  assert(existsSync(receipt.artifacts.tui.path)); assert(receipt.commands.some(c => c.status === 'failed' && c.exitCode === 7));
  assert(!JSON.stringify(receipt).includes('secret-like'));
});

test('wrong package tarball and duplicate Cordis identity are rejected with preserved receipts', () => {
  for (const options of [{ wrongArtifact: true }, { duplicateCordis: true }]) {
    const f = fixture(), mock = mockRunner(f, options), plan = createPlan(f);
    assert.throws(() => executePlan({ ...f, plan, bootstrap: true, runner: mock.runner }), /identity/);
    assert.equal(load(join(f.paths.destination, 'receipt.json')).status, 'failed');
  }
});

test('caller cannot inject custom command steps through the plan seam', () => {
  const f = fixture(), plan = createPlan(f), mock = mockRunner(f);
  plan.steps[0].args.push('--legacy-peer-deps');
  assert.throws(() => executePlan({ ...f, plan, bootstrap: true, runner: mock.runner }), /differs/);
  assert.equal(mock.calls.length, 0); assert.equal(existsSync(f.paths.destination), false);
});

test('AG runtime client reference or symlink fails before pack/final install and preserves receipt', () => {
  for (const options of [{ clientRuntimeReference: true }, { symlinkLib: true }]) {
    const f = fixture(), plan = createPlan(f), mock = mockRunner(f, options);
    assert.throws(() => executePlan({ ...f, plan, bootstrap: true, runner: mock.runner }), /JavaScript references|non-symlink/);
    const receipt = load(join(f.paths.destination, 'receipt.json'));
    assert.equal(receipt.status, 'failed');
    assert(!mock.calls.some(call => call.command === 'npm' && call.args[0] === 'pack'));
    assert.equal(mock.calls.filter(call => call.command === 'npm' && call.args[0] === 'install').length, 1);
    assert.equal(receipt.sources.antigravity.patches[0].status, 'applied');
  }
});

test('AG patch command failure is durable and never packs its source', () => {
  const f = fixture(), plan = createPlan(f), mock = mockRunner(f, { failAt: '--check' });
  assert.throws(() => executePlan({ ...f, plan, bootstrap: true, runner: mock.runner }), /antigravity-patch-check/);
  const receipt = load(join(f.paths.destination, 'receipt.json'));
  assert.equal(receipt.status, 'failed'); assert.deepEqual(receipt.sources.antigravity.patches, []);
  assert(!mock.calls.some(call => call.command === 'npm' && call.args[0] === 'pack'));
});

test('reviewed package-manager/runtime/frontend vendor bindings fail closed before writes', () => {
  const mutations = [f => { f.manifest.runtime.version = '0.2.1'; }, ...[0, 1, 2].flatMap(index => [
    f => { f.manifest.components[index].packageManager.version = '99.0.0'; },
    f => { f.manifest.components[index].package = '@unreviewed/package'; },
    f => { f.manifest.components[index].version = '99.0.0'; },
  ]), f => { f.manifest.components[0].submodules[0].commit = '5'.repeat(40); }];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f); const mock = mockRunner(f);
    assert.throws(() => createPlan(f), /not ready/);
    assert.equal(existsSync(f.paths.destination), false); assert.equal(mock.calls.length, 0);
  }
});

test('destination guards metadata-only protect caches/configs and any other Git tree', () => {
  const f = fixture();
  for (const name of ['.npm', '.config', '.cache']) {
    const root = join(f.home, name); mkdirSync(root);
    assert.throws(() => createPlan({ ...f, paths: { ...f.paths, destination: join(root, 'new') } }), /protected root/);
  }
  const customCache = join(f.repo, '.dumps/custom-cache'); mkdirSync(customCache);
  assert.throws(() => createPlan({ ...f, env: { ...process.env, npm_config_cache: customCache }, paths: { ...f.paths, destination: join(customCache, 'new') } }), /protected root/);
  for (const kind of ['directory', 'file', 'symlink']) {
    const tree = join(f.repo, '.dumps', 'other-git-' + kind); mkdirSync(tree);
    const git = join(tree, '.git');
    if (kind === 'directory') mkdirSync(git);
    else if (kind === 'file') writeFileSync(git, 'gitdir: elsewhere');
    else symlinkSync(join(tree, 'missing'), git);
    const target = join(tree, 'stage');
    assert.throws(() => createPlan({ ...f, paths: { ...f.paths, destination: target } }), /another Git tree/);
    assert.equal(existsSync(target), false);
  }
});

test('all commands use private home/cache and strip inherited npm/pnpm/Git redirects', () => {
  const f = fixture(), mock = mockRunner(f);
  const env = { ...process.env, npm_config_global: 'true', NPM_CONFIG_PREFIX: f.home, npm_config_userconfig: join(f.home, '.npmrc'), npm_config_cache: join(f.home, '.npm'), PNPM_HOME: f.home, PNPM_STORE_DIR: f.home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: f.home, GIT_TEMPLATE_DIR: f.home, GIT_DIR: join(f.repo, '.git'), GIT_OBJECT_DIRECTORY: f.home, GIT_ALTERNATE_OBJECT_DIRECTORIES: f.home, GIT_QUARANTINE_PATH: f.home, TMPDIR: f.home, HTTP_PROXY: 'http://fixture.proxy', PRIVATE_TEST_SECRET: 'never-in-receipt' };
  const plan = createPlan({ ...f, env });
  const receipt = executePlan({ ...f, plan, bootstrap: true, runner: mock.runner, env });
  for (const call of mock.calls) {
    assert.equal(call.env.HOME, join(f.paths.destination, 'home'));
    assert.equal(call.env.npm_config_cache, join(f.paths.destination, 'cache/npm'));
    assert.equal(call.env.npm_config_store_dir, join(f.paths.destination, 'cache/pnpm-store'));
    assert.equal(call.env.GIT_TERMINAL_PROMPT, '0'); assert.equal(call.env.GIT_CONFIG_NOSYSTEM, '1');
    for (const key of ['NPM_CONFIG_PREFIX', 'npm_config_global', 'PNPM_HOME', 'PNPM_STORE_DIR', 'GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_TEMPLATE_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH']) assert.equal(call.env[key], undefined);
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) assert.equal(call.env[key], join(f.paths.destination, 'cache/tmp'));
    assert.equal(call.env.HTTP_PROXY, 'http://fixture.proxy');
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DSH_HOME', 'npm_config_userconfig', 'npm_config_globalconfig', 'GIT_CONFIG_GLOBAL']) assert(call.env[key].startsWith(f.paths.destination + '/'));
  }
  for (const key of ['userconfig', 'globalconfig', 'gitconfig']) assert.equal(readFileSync(receipt.isolation[key], 'utf8'), '');
  assert(!JSON.stringify(receipt).includes('never-in-receipt'));
});
