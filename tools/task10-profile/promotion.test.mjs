#!/usr/bin/env node
// Synthetic throwaway profiles only. No production writes, real installation,
// builds, mounted Harness plugins, model calls, process kills or cleanup.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, defaultPaths, filterPreset, inspect, prepare, proposedManifest, rollback, runtimeCandidates, TUI } from './promotion.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliRequire = createRequire('/home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh/package.json');
const profileRequire = createRequire('/home/alex/.dsh/profiles/dsh-tui/package.json');
const YAML = profileRequire('yaml');
const bootRoot = dirname(cliRequire.resolve('@deepseek-ai/dsh-app-boot/package.json'));
const yamlRoot = dirname(profileRequire.resolve('yaml/package.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const text = path => readFileSync(path, 'utf8');
const realRun = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options });
const root = mkdtempSync('/tmp/task10-promotion-test-');
function write(path, data) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'); }
function link(target, path) { mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path); }
function snapshot(path) {
  const entries = [];
  function walk(full, relative) {
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) entries.push([relative, 'link', readlinkSync(full), stat.mode & 0o7777]);
    else if (stat.isDirectory()) {
      entries.push([relative, 'dir', stat.mode & 0o7777]);
      for (const name of readdirSync(full).sort()) walk(join(full, name), relative + '/' + name);
    } else entries.push([relative, 'file', hash(readFileSync(full)), stat.mode & 0o7777]);
  }
  walk(path, ''); return entries;
}

function fixture(name) {
  const dir = join(root, name), home = join(dir, 'home'), work = join(dir, 'repo');
  mkdirSync(dir); mkdirSync(home); mkdirSync(work);
  const p = defaultPaths({ home, dshHome: join(home, '.dsh'), repo: work, cli: join(dir, 'cli/bin/dsh'), pnpm: join(dir, 'cli/bin/pnpm'), cliAnchor: join(dir, 'cli/node_modules/@deepseek-ai/dsh/package.json') });
  write(p.cliAnchor, { name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', dependencies: { '@deepseek-ai/dsh-base': '0.2.0-rc.2' } });
  link(bootRoot, join(dir, 'cli/node_modules/@deepseek-ai/dsh-app-boot'));
  const base = join(dir, 'cli/node_modules/@deepseek-ai/dsh-base');
  write(join(base, 'package.json'), { name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2', dsh: { bundle: { patch: './cordis.patch.yml' } } });
  write(join(base, 'cordis.patch.yml'), "- insert:\n    - id: plan-mode\n      name: '@deepseek-ai/dsh-plan-mode'\n");
  const web = join(dir, 'cli/node_modules/@deepseek-ai/dsh-web-app');
  write(join(web, 'package.json'), { name: '@deepseek-ai/dsh-web-app', version: '0.2.0-rc.2', exports: { './presets/*': './presets/*' } });
  for (const id of ['standard', 'ptc', 'cordis', 'minimal']) write(join(web, 'presets', id + '.patch.yml'), text(cliRequire.resolve('@deepseek-ai/dsh-web-app/presets/' + id + '.patch.yml')));
  const packageManifest = { name: TUI, version: '0.14.0', type: 'module', exports: { '.': './lib/types/index.js', './ui': './lib/types/ui.js', './package.json': './package.json' }, dsh: { bundle: { patch: './cordis.patch.yml' } } };
  const tuiPatch = "- insert:\n    - id: dsh-tui\n      name: '@deepseek-harness-tui/dsh-tui'\n      config: { fullscreen: true }\n- id: plan-mode\n  disabled: true\n";
  const packed = join(dir, 'pack/package');
  write(join(packed, 'package.json'), packageManifest);
  write(join(packed, 'cordis.patch.yml'), tuiPatch);
  write(join(packed, 'lib/types/ui.js'), 'export const Markdown=()=>null; export const markdownSourceRange=()=>null; export const markdownSourceBlocks=()=>[];\n');
  write(join(packed, 'lib/types/index.js'), 'export const fixture=true;\n');
  const installed = join(p.profile, 'node_modules', TUI);
  for (const relative of ['package.json', 'cordis.patch.yml', 'lib/types/ui.js', 'lib/types/index.js']) write(join(installed, relative), text(join(packed, relative)));
  const provider = join(dir, 'provider');
  write(join(provider, 'package.json'), { name: '@local/provider', version: '7.4.2', exports: { './package.json': './package.json' } });
  link(provider, join(p.profile, 'node_modules/@local/provider'));
  link(yamlRoot, join(p.profile, 'node_modules/yaml'));
  write(join(p.profile, 'package.json'), { name: 'dsh-profile-dsh-tui', private: true, dependencies: { '@local/provider': 'link:' + provider, [TUI]: '0.14.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', TUI] } }, customMetadata: { preserved: true } });
  write(join(p.profile, 'cordis.yml'), '# original root bytes\n[]\n');
  const custom = "# private fixture values (NOT real secrets)\n- id: dsh-tui\n  config:\n    lang: pt\n    fullscreen: true\n    modes:\n      - id: custom\n        plan: false\n        approval: ask\n    shortcuts:\n      editor: ctrl+shift+g\n# retain this exact comment\n- insert:\n    - id: alex-existing\n      name: /old/location.mjs\n    - id: custom-provider\n      name: /local/provider.mjs\n      config:\n        apiKey: synthetic-fixture-not-a-real-key\n        model: owner-selected\n";
  write(join(p.profile, 'cordis.patch.yml'), custom);
  write(join(p.profile, 'pnpm-lock.yaml'), YAML.stringify({ lockfileVersion: '9.0', importers: { '.': { dependencies: { '@local/provider': { specifier: 'link:' + provider, version: 'link:../../../../provider' }, [TUI]: { specifier: '0.14.0', version: '0.14.0' } } } }, packages: { 'preserved@7.4.2': { resolution: { integrity: 'fixture-only' } } }, snapshots: { 'preserved@7.4.2': {} } }));
  write(join(p.profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  write(join(p.profile, '.plugin-manager/prior-state.json'), { exact: 'retained' });
  write(p.manifest, { managedIdPrefix: 'alex-', profiles: ['dsh-tui', 'web'], plugins: [{ id: 'alex-existing', module: 'existing/index.mjs' }], knownInactive: { 'managed-plans': 'prior exact explanation' } });
  write(join(work, 'plugins/existing/index.mjs'), 'export const fixture=true;\n');
  for (const module of ['index.mjs', 'tui.mjs']) write(join(work, 'plugins/managed-plans', module), 'export const fixture=true;\n');
  write(p.activate, text(join(repo, 'tools/activate.mjs')));
  for (const launcher of p.launchers) write(launcher, '# exact synthetic launcher bytes\n');
  write(p.preference, { preset: 'ptc' });
  write(p.recipe, { patchSha256: 'a'.repeat(64) });
  const tarball = join(dir, 'fixture.tgz');
  realRun('tar', ['-czf', tarball, '-C', join(dir, 'pack'), 'package']);
  const bundle = join(dir, 'bundle.json');
  write(bundle, { schemaVersion: 1, package: TUI, version: '0.14.0', runtimeVersion: '0.2.0-rc.2', tarball, tarballSha256: hash(readFileSync(tarball)), recipePatchSha256: 'a'.repeat(64) });
  const commands = [];
  const io = {
    runtimePids: () => [],
    run(command, args, options) {
      commands.push([command, args]);
      if (command === p.pnpm) {
        assert.equal(options.cwd, p.profile);
        assert.deepEqual(args, ['--dir', p.profile, 'install', '--ignore-workspace', '--prod', '--ignore-scripts', '--no-frozen-lockfile']);
        const pkg = json(join(p.profile, 'package.json'));
        const lock = YAML.parse(text(join(p.profile, 'pnpm-lock.yaml')));
        lock.importers['.'].dependencies[TUI] = { specifier: pkg.dependencies[TUI], version: pkg.dependencies[TUI].slice(5) };
        write(join(p.profile, 'pnpm-lock.yaml'), YAML.stringify(lock));
        write(join(p.profile, 'node_modules/added-by-fixture-installer.txt'), 'quarantine on rollback, never delete\n');
        return '';
      }
      return realRun(command, args, options);
    },
  };
  return { p, dir, bundle, io, commands, custom, state: join(dir, 'prepared') };
}

const fakeProc = join(root, 'proc');
for (const [pid, args] of [
  [10001, ['node', '/cli/node_modules/.bin/dsh', '--profile', 'dsh-tui', 'synthetic-private-argument']],
  [10002, ['node', '/cli/node_modules/.bin/dsh', 'web']],
  [10003, ['node', '/cli/node_modules/.bin/dsh', '--profile', 'headless']],
  [10004, ['node', '/strata/server.mjs']],
  [10005, ['node', '/cli/node_modules/.bin/dsh']],
  [10006, ['node', '/cli/local-model-launch.mjs']],
  [10007, ['node', '/cli/node_modules/.bin/dsh', '--profile=web']],
]) write(join(fakeProc, String(pid), 'cmdline'), args.join('\0') + '\0');
const candidates = runtimeCandidates(fakeProc);
assert.deepEqual(candidates.map(item => item.pid), [10001, 10005, 10006]);
assert.ok(!JSON.stringify(candidates).includes('synthetic-private-argument'));

// The full official definitions, including all !!js/reference expressions, are
// consumed rather than rebuilding a narrow guessed tool subset.
for (const id of ['standard', 'ptc', 'cordis']) {
  const source = text(cliRequire.resolve('@deepseek-ai/dsh-web-app/presets/' + id + '.patch.yml'));
  const result = filterPreset(source, id, YAML);
  assert.ok(!result.content.includes("name: '@deepseek-ai/dsh-plan-mode'"));
  assert.ok(result.content.includes('process.platform'));
  assert.ok(result.content.includes('tool-goal') && result.content.includes('tool-subagent'));
  if (id === 'cordis') assert.ok(result.content.includes("createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')"));
  assert.throws(() => filterPreset(source.replace("name: '@deepseek-ai/dsh-plan-mode'", "name: '@local/mixed-group'"), id, YAML), /mixed\/unknown/);
}
assert.equal(filterPreset(text(cliRequire.resolve('@deepseek-ai/dsh-web-app/presets/minimal.patch.yml')), 'minimal', YAML).untouched, true);
const manifest = proposedManifest(JSON.stringify({ managedIdPrefix: 'alex-', profiles: ['dsh-tui'], plugins: [{ id: 'alex-first', module: 'first/index.mjs' }], knownInactive: { 'managed-plans': 'before' } }));
assert.deepEqual(JSON.parse(manifest.content).plugins[0], { id: 'alex-first', module: 'first/index.mjs' });
assert.ok(manifest.proposedRows.every(row => row.overlay === false && row.profiles.join() === 'dsh-tui'));
assert.equal(proposedManifest(manifest.content).content, manifest.content, 'manifest proposal is idempotent');

const f = fixture('success');
const original = snapshot(f.p.profile), originalManifest = text(f.p.manifest);
const checked = await inspect(f.p, f.io);
assert.deepEqual(snapshot(f.p.profile), original);
assert.equal(checked.selectedPreset.preference, 'ptc');
assert.ok(checked.patch.final.includes('lang: en'));
assert.ok(checked.patch.final.includes('    modes:\n      - id: custom\n        plan: false\n        approval: ask'));
assert.ok(checked.patch.final.includes(f.custom.slice(f.custom.indexOf('    - id: custom-provider'))));
assert.equal(text(f.p.manifest), originalManifest);
await prepare({ paths: f.p, state: f.state, bundle: f.bundle }, f.io);
assert.deepEqual(snapshot(f.p.profile), original, 'prepare never writes profile');
assert.equal(text(f.p.manifest), originalManifest, 'prepare never writes manifest');
assert.equal(f.commands.filter(([command]) => command === f.p.pnpm).length, 0);
assert.equal(json(join(f.state, 'plan.json')).preparationValidation.planningOwners, 'root disabled; official standard/PTC/cordis planning filtered; minimal unchanged');
assert.equal(lstatSync(f.state).mode & 0o777, 0o700);
await assert.rejects(apply({ state: f.state }, f.io), /Close Harness/);
await assert.rejects(apply({ state: f.state, harnessClosed: true }, { ...f.io, runtimePids: () => [12345] }), /12345/);
assert.equal(existsSync(join(f.state, 'backup')), false, 'active runtime refuses before backup/live writes');
write(f.p.manifest, originalManifest + '\n');
await assert.rejects(apply({ state: f.state, harnessClosed: true }, f.io), /input drift/);
write(f.p.manifest, originalManifest);
const proposed = text(join(f.state, 'cordis.proposed.yml'));
write(join(f.state, 'cordis.proposed.yml'), proposed + '# tampered\n');
await assert.rejects(apply({ state: f.state, harnessClosed: true }, f.io), /artifact drift/);
write(join(f.state, 'cordis.proposed.yml'), proposed);
const applied = await apply({ state: f.state, harnessClosed: true }, f.io);
assert.equal(applied.status, 'applied');
assert.equal(applied.validation.nonTuiResolution, 'unchanged');
assert.equal(applied.validation.interactiveAcceptance, 'pending owner launch');
assert.equal(json(join(f.p.profile, 'package.json')).dependencies['@local/provider'], checked.nonTui['@local/provider']);
assert.equal(text(join(f.p.profile, 'cordis.patch.yml')), proposed);
assert.ok(existsSync(join(f.p.profile, 'task10-promotion/bundle.tgz')));
assert.ok(existsSync(join(f.state, 'backup/profile.tar')));
assert.equal(json(join(f.state, 'receipt.json')).priorDependencyResolution['@local/provider'].version, '7.4.2');
assert.equal(f.commands.filter(([command]) => command === f.p.pnpm).length, 1);
write(join(f.p.profile, 'cordis.patch.yml'), proposed + '# newer owner edit\n');
await assert.rejects(rollback({ receipt: applied.receipt, harnessClosed: true }, f.io), /Post-apply/);
write(join(f.p.profile, 'cordis.patch.yml'), proposed);
await assert.rejects(rollback({ receipt: applied.receipt, harnessClosed: true }, { ...f.io, runtimePids: () => [67890] }), /67890/);
write(join(f.p.profile, '.plugin-manager/new-runtime-log.json'), { generated: true });
write(join(f.p.profile, 'cordis.yml'), '# CLI normalized empty root, not an owner config change\n[]\n');
const restored = await rollback({ receipt: applied.receipt, harnessClosed: true }, f.io);
assert.equal(restored.status, 'rolled-back');
assert.deepEqual(snapshot(f.p.profile), original, 'rollback restores full exact profile/lock/node_modules/symlinks');
assert.equal(text(f.p.manifest), originalManifest, 'rollback restores exact manifest bytes');
assert.ok(existsSync(join(restored.quarantine, 'node_modules/added-by-fixture-installer.txt')), 'new files kept, not deleted');
assert.ok(existsSync(join(restored.quarantine, '.plugin-manager/new-runtime-log.json')), 'runtime-generated metadata permits recovery and is quarantined');
assert.equal(json(applied.receipt).rollback.verified, true);
await assert.rejects(rollback({ receipt: applied.receipt, harnessClosed: true }, f.io), /Already rolled back/);

for (const failure of ['validation', 'installation']) {
  const broken = fixture(failure), before = snapshot(broken.p.profile), beforeManifest = text(broken.p.manifest);
  await prepare({ paths: broken.p, state: broken.state, bundle: broken.bundle }, broken.io);
  const failingIo = failure === 'validation' ? { ...broken.io, validate: () => { throw Error('deliberate fixture validation failure'); } } : { ...broken.io, run(command, args, options) { if (command === broken.p.pnpm) throw Error('deliberate fixture installer failure'); return broken.io.run(command, args, options); } };
  await assert.rejects(apply({ state: broken.state, harnessClosed: true }, failingIo), /Apply failed/);
  assert.deepEqual(snapshot(broken.p.profile), before, `${failure} failure restores full profile`);
  assert.equal(text(broken.p.manifest), beforeManifest);
  assert.equal(json(join(broken.state, 'receipt.json')).status, 'rolled-back');
  assert.ok(existsSync(join(broken.state, 'retired-profile/task10-promotion/bundle.tgz')));
}
const bad = fixture('bad-seal');
write(bad.bundle, { ...json(bad.bundle), tarballSha256: '0'.repeat(64) });
await assert.rejects(prepare({ paths: bad.p, state: bad.state, bundle: bad.bundle }, bad.io), /SHA256 mismatch/);
assert.equal(existsSync(bad.state), false);
console.log('PASS: planning-only CST filter + expressions; minimal untouched; manifest single-source/idempotence; read-only prepare + offline config validation; exact non-TUI/mode/provider/launcher preservation; active-runtime/drift/seal refusal; scoped mocked install; real public package/UI imports; exact rollback on success and failures.');
console.log(`Synthetic fixtures retained (no automatic deletion): ${root}`);
