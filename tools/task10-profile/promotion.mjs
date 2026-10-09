#!/usr/bin/env node
// Machine-scoped promotion, not a deploy framework. Checks never invoke DSH boot
// or dump-config: both may normalize/rewrite a live profile even without mounting.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

export const TUI = '@deepseek-harness-tui/dsh-tui';
const RUNTIME = '0.2.0-rc.2';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = data => createHash('sha256').update(data).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const pretty = value => JSON.stringify(value, null, 2) + '\n';
const digest = path => existsSync(path) ? hash(readFileSync(path)) : null;
const fail = message => { throw Error(message); };
const within = (a, b) => a === b || a.startsWith(b + sep);
const writeNew = (path, bytes) => writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });

export function defaultPaths(overrides = {}) {
  const home = overrides.home ?? process.env.HOME ?? '/home/alex';
  const dshHome = resolve(overrides.dshHome ?? process.env.DSH_HOME ?? join(home, '.dsh'));
  const repo = resolve(overrides.repo ?? REPO);
  return {
    home, dshHome, repo, profile: join(dshHome, 'profiles/dsh-tui'),
    manifest: join(repo, 'plugins/activation.json'), activate: join(repo, 'tools/activate.mjs'),
    recipe: join(repo, 'tools/task10-frontend/recipe.json'),
    cli: '/home/alex/.local/share/dsh-cli/node_modules/.bin/dsh',
    pnpm: '/home/alex/.local/share/dsh-cli/node_modules/.bin/pnpm',
    cliAnchor: '/home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh/package.json',
    launchers: [join(home, '.config/fish/functions/dsh.fish'), join(home, '.local/share/dsh-cli/local-model-launch.mjs')],
    preference: join(home, '.dsh-tui/agent-preset.json'),
    ...overrides,
  };
}

function realDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) fail(`Refusing symlink/noncanonical directory: ${path}`);
}
function statePath(path, p) {
  if (!path || !isAbsolute(path)) fail('--state must be an absolute, absent durable directory');
  const state = resolve(path);
  if (state.split(sep).includes('.dumps') || within(state, p.profile) || within(p.profile, state) || within(state, join(p.repo, 'plugins'))) fail('State must be outside .dumps, the live profile, and plugins');
  realDirectory(dirname(state));
  return state;
}
function libraries(p) {
  const require = createRequire(p.cliAnchor);
  let YAML;
  for (const anchor of [join(p.profile, 'package.json'), p.cliAnchor]) {
    try { YAML = createRequire(anchor)('yaml'); break; } catch {}
  }
  if (!YAML) fail('Existing yaml dependency not found; preparation never installs one');
  return { YAML, require };
}
const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) };
function parse(YAML, source) {
  const doc = YAML.parseDocument(source, { customTags: [jsTag], keepSourceTokens: true });
  if (doc.errors.length) fail(`Invalid YAML: ${doc.errors[0].message}`);
  return doc;
}
function yamlValue(YAML, source) { return parse(YAML, source).toJS(); }
function allRows(rows) {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? allRows(row.config) : [])]);
}

// Extract the original plugin list as literal text: expressions and complete
// non-planning rows must survive, not a hand-maintained approximation of tools.
export function filterPreset(source, id, YAML) {
  const doc = parse(YAML, source);
  const rows = doc.contents?.items?.[0]?.get?.('insert');
  if (doc.contents?.items?.length !== 1 || rows?.items?.length !== 1) fail(`Unsupported official ${id} declaration shape`);
  const row = rows.items[0], config = row.get('config'), plugins = config?.get?.('plugins');
  if (row.get('name') !== '@deepseek-ai/dsh-agent-preset' || config?.get?.('id') !== id || !plugins?.items?.length) fail(`Invalid official preset: ${id}`);
  const original = plugins.toJSON();
  const planning = plugins.items.filter(item => item.get?.('id') === 'planning');
  if (id === 'minimal') {
    if (planning.length || allRows(original).some(row => row.name === '@deepseek-ai/dsh-plan-mode')) fail('Minimal unexpectedly owns native planning');
    return { id, untouched: true, originalSha256: hash(source) };
  }
  if (planning.length !== 1) fail(`Expected one planning group in ${id}`);
  const group = planning[0].toJSON();
  if (group.group !== true || group.isolate?.planMode !== true || group.config?.length !== 1 || group.config[0].name !== '@deepseek-ai/dsh-plan-mode') fail(`Refusing mixed/unknown planning group in ${id}`);
  const startLine = offset => source.lastIndexOf('\n', offset) + 1;
  const endLine = offset => {
    let end = offset - 1;
    while (end > 0 && /[\r\n]/.test(source[end])) end--;
    const newline = source.indexOf('\n', end);
    return newline < 0 ? source.length : newline + 1;
  };
  const start = startLine(plugins.items[0].range[0]);
  const end = endLine(plugins.items.at(-1).range[2]);
  const cutStart = startLine(planning[0].range[0]), cutEnd = endLine(planning[0].range[2]);
  const indent = /^ */.exec(source.slice(start))[0].length;
  const content = (source.slice(start, cutStart) + source.slice(cutEnd, end)).split('\n').map(line => line.startsWith(' '.repeat(indent)) ? line.slice(indent) : line).join('\n');
  const retained = yamlValue(YAML, content);
  const expected = original.filter(row => row.id !== 'planning');
  if (JSON.stringify(retained) !== JSON.stringify(expected) || allRows(retained).some(row => row.name === '@deepseek-ai/dsh-plan-mode')) fail(`Preset filter changed non-planning data: ${id}`);
  return { id, content, order: config.get('order'), originalSha256: hash(source), sha256: hash(content), retainedRows: allRows(retained).length };
}

export function proposedManifest(source) {
  const next = JSON.parse(source);
  if (next.managedIdPrefix !== 'alex-' || !Array.isArray(next.plugins)) fail('Unsupported activation manifest');
  const proposals = [
    { id: 'alex-managed-plans', module: 'managed-plans/index.mjs', profiles: ['dsh-tui'], overlay: false, config: { wakeAgent: true } },
    { id: 'alex-managed-plans-tui', module: 'managed-plans/tui.mjs', profiles: ['dsh-tui'], overlay: false },
  ];
  for (const proposed of proposals) {
    const previous = next.plugins.find(row => row.id === proposed.id);
    if (!previous) next.plugins.push(proposed);
    else {
      if (previous.module !== proposed.module || previous.overlay !== false || JSON.stringify(previous.config ?? {}) !== JSON.stringify(proposed.config ?? {})) fail(`Conflicting existing manifest row: ${proposed.id}`);
      previous.profiles = [...new Set([...(previous.profiles ?? []), 'dsh-tui'])];
    }
  }
  if (!next.profiles?.includes('dsh-tui')) fail('Manifest does not manage dsh-tui');
  if (next.knownInactive) delete next.knownInactive['managed-plans'];
  return { content: pretty(next), proposedRows: next.plugins.filter(row => proposals.some(proposed => proposed.id === row.id)), removesKnownInactive: Boolean(JSON.parse(source).knownInactive?.['managed-plans']) };
}

// Reuse the generator's own CST surgery; never copy its plugin list. This
// isolated rendering evaluation has no writes, CLI main, or profile discovery.
function activationPreview(p, manifest, source, YAML) {
  const generator = readFileSync(p.activate, 'utf8');
  const start = generator.indexOf('// --- rendering'), end = generator.indexOf('// --- main');
  if (start < 0 || end <= start) fail('Activation generator layout changed; review helper');
  const context = vm.createContext({ resolve, join, existsSync: () => true, readFileSync: () => source, writeFileSync: () => fail('Preview attempted a write') });
  vm.runInContext(generator.slice(start, end), context);
  const entries = context.desiredEntries(manifest, 'dsh-tui', p.repo);
  const result = context.syncFile('/preview', 'dsh-tui', entries, { write: false }, YAML, manifest);
  if (result.error || result.current === undefined) fail(`Existing single managed activation block required: ${result.note}`);
  return source.replace(result.current, result.block);
}

function makePatch(source, presets, p, manifest, YAML) {
  const doc = parse(YAML, source);
  const rows = doc.toJS();
  if (!Array.isArray(rows)) fail('Profile patch is not a list');
  if (rows.some(row => row.insert?.some(entry => entry.name === '@deepseek-ai/dsh-agent-preset'))) fail('Existing custom preset declarations require owner review');
  const tuiNodes = doc.contents.items.filter(row => row.get?.('id') === 'dsh-tui');
  if (tuiNodes.length !== 1) fail('Expected exactly one profile dsh-tui config override');
  const tuiConfig = tuiNodes[0].get('config');
  if (!YAML.isMap(tuiConfig) || tuiConfig.tag) fail('TUI config must be a literal map to preserve custom settings');
  // Append one key in place, not YAML reserialization of custom provider config.
  let offset = tuiConfig.range[2];
  while (offset > 0 && /[\r\n]/.test(source[offset - 1])) offset--;
  const end = source.indexOf('\n', offset);
  const insertAt = end < 0 ? source.length : end + 1;
  let patch = source;
  let additions = '';
  if (!tuiConfig.has('externalPlanCommand')) additions += '    externalPlanCommand: true\n';
  else if (tuiConfig.get('externalPlanCommand') !== true) fail('Existing externalPlanCommand is not true; review explicitly');
  if (!tuiConfig.has('lang')) additions += '    lang: en\n';
  patch = source.slice(0, insertAt) + additions + source.slice(insertAt);
  if (tuiConfig.has('lang') && tuiConfig.get('lang') !== 'en') {
    const language = tuiConfig.get('lang', true);
    if (!YAML.isScalar(language) || language.tag) fail('TUI language must be a literal scalar');
    patch = patch.slice(0, language.range[0]) + 'en' + patch.slice(language.range[1]);
  }
  patch += `${patch.endsWith('\n') ? '' : '\n'}# Task10 promotion: root and official preset planning owners replaced.\n- id: plan-mode\n  disabled: true\n- insert:\n`;
  for (const preset of presets.filter(item => !item.untouched)) {
    patch += `    - id: preset-${preset.id}\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: ${preset.id}\n        order: ${preset.order}\n        plugins:\n          - id: ${preset.id}-managed-plugins\n            name: '@deepseek-ai/cordis-plugin-include'\n            config:\n              path: ${JSON.stringify(join(p.profile, 'task10-promotion/presets', preset.id + '.yml'))}\n`;
  }
  // The preview must agree exactly with the scoped activation tool run on apply.
  return { beforeActivation: patch, final: activationPreview(p, manifest, patch, YAML) };
}

export function runtimeCandidates(proc = '/proc') {
  const result = [];
  for (const name of readdirSync(proc)) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (typeof process.getuid === 'function' && statSync(join(proc, name)).uid !== process.getuid()) continue;
      const args = readFileSync(join(proc, name, 'cmdline')).toString().split('\0').filter(Boolean);
      const executableAt = args.findIndex(arg => /(?:^|\/)(?:dsh|dsh-tui)(?:\.js)?$/.test(arg) || /\/\@deepseek-ai\/dsh\/.*bin\.js$/.test(arg) || /\/local-model-launch\.mjs$/.test(arg));
      if (executableAt < 0) continue;
      const executable = basename(args[executableAt]);
      const profileAt = args.indexOf('--profile');
      const equalsProfile = args.find(arg => arg.startsWith('--profile='))?.slice(10);
      const explicit = profileAt >= 0 ? args[profileAt + 1] : equalsProfile;
      const positional = args[executableAt + 1];
      // Legacy positional entry points are unrelated runtimes, not blockers for
      // this profile. Unknown CLI launches still require conservative review.
      const otherPositional = ['web', 'headless', 'tui', 'acp', 'desktop'].includes(positional);
      if ((explicit && explicit !== 'dsh-tui') || otherPositional) continue;
      result.push({ pid: Number(name), executable, profile: explicit ?? (executable === 'local-model-launch.mjs' || executable.startsWith('dsh-tui') ? 'dsh-tui (launcher default)' : 'unknown (conservative refusal)') });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) fail(`Cannot inspect own runtime PID ${name}: ${error.code ?? error.message}`); }
  }
  return result.sort((a, b) => a.pid - b.pid);
}
export function runtimePids(proc = '/proc') { return runtimeCandidates(proc).map(item => item.pid); }
function assertClosed(acknowledged, io, allowRunning = false) {
  if (!acknowledged) fail('Close Harness and all default dsh-tui runtimes first; --harness-closed is required');
  const candidates = io.runtimePids ? io.runtimePids().map(pid => ({ pid, executable: 'injected fixture', profile: 'dsh-tui' })) : runtimeCandidates();
  if (candidates.length && !allowRunning) fail(`Refusing active/ambiguous dsh-tui runtime PIDs: ${candidates.map(item => `${item.pid} (${item.executable}; ${item.profile})`).join(', ')}. Exit them yourself, or use --allow-running if this is intentional.`);
}
function bundleInfo(path, p, io) {
  const bundle = json(path), recipe = json(p.recipe);
  if (bundle.schemaVersion !== 1 || bundle.package !== TUI || bundle.version !== '0.14.0' || bundle.runtimeVersion !== RUNTIME || bundle.recipePatchSha256 !== recipe.patchSha256) fail('Bundle identity/runtime/current recipe patch does not match');
  if (!isAbsolute(bundle.tarball ?? '') || !/^[a-f0-9]{64}$/.test(bundle.tarballSha256 ?? '')) fail('Bundle needs absolute tarball and SHA256');
  if (digest(bundle.tarball) !== bundle.tarballSha256) fail('Sealed tarball SHA256 mismatch');
  const run = io.run ?? runCommand;
  const packed = JSON.parse(run('tar', ['-xOf', bundle.tarball, 'package/package.json']));
  if (packed.name !== TUI || packed.version !== bundle.version || !packed.exports?.['./ui'] || !packed.dsh?.bundle) fail('Tarball package/public UI/bundle identity is invalid');
  const ui = run('tar', ['-xOf', bundle.tarball, 'package/lib/types/ui.js']);
  if (!ui.includes('Markdown') || !ui.includes('markdownSourceRange') || !ui.includes('markdownSourceBlocks')) fail('Tarball lacks managed-plans public Markdown API');
  return bundle;
}
function runCommand(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
}

export async function inspect(p = defaultPaths(), io = {}) {
  realDirectory(p.profile);
  const { YAML, require } = libraries(p);
  const pkg = json(join(p.profile, 'package.json'));
  if (!pkg.dependencies?.[TUI] || pkg.dsh?.profile?.bundles?.filter(name => name === TUI).length !== 1) fail('Default profile must have one existing TUI dependency/bundle');
  for (const name of ['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml']) {
    if (!lstatSync(join(p.profile, name)).isFile()) fail(`Profile ${name} must be a regular file`);
  }
  if (JSON.stringify(yamlValue(YAML, readFileSync(join(p.profile, 'cordis.yml'), 'utf8'))) !== '[]') fail('Nonempty profile root requires owner review');
  if (existsSync(join(p.profile, 'task10-promotion'))) fail('Profile already contains task10-promotion; rollback/review before preparing again');
  const cliPackage = json(p.cliAnchor);
  const basePath = require.resolve('@deepseek-ai/dsh-base/package.json');
  if (cliPackage.version !== RUNTIME || json(basePath).version !== RUNTIME) fail(`Existing CLI/base must remain ${RUNTIME}; helper never changes base`);
  const presets = ['standard', 'ptc', 'cordis', 'minimal'].map(id => {
    const path = require.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`);
    return { ...filterPreset(readFileSync(path, 'utf8'), id, YAML), path };
  });
  const manifest = proposedManifest(readFileSync(p.manifest, 'utf8'));
  for (const row of JSON.parse(manifest.content).plugins) if (!existsSync(join(p.repo, 'plugins', row.module))) fail(`Activation module missing: ${row.module}`);
  const patch = makePatch(readFileSync(join(p.profile, 'cordis.patch.yml'), 'utf8'), presets, p, JSON.parse(manifest.content), YAML);
  const lock = yamlValue(YAML, readFileSync(join(p.profile, 'pnpm-lock.yaml'), 'utf8'));
  const imports = lock.importers?.['.']?.dependencies;
  if (!imports) fail('Expected pnpm lockfile root importer');
  const nonTui = Object.fromEntries(Object.entries(pkg.dependencies).filter(([name]) => name !== TUI));
  const resolution = Object.fromEntries(Object.keys(nonTui).map(name => {
    if (imports[name]?.specifier !== nonTui[name]) fail(`Existing lockfile does not match ${name}`);
    const path = createRequire(join(p.profile, 'package.json')).resolve(name + '/package.json');
    return [name, { importer: imports[name], manifestPath: realpathSync(path), manifestSha256: digest(path), version: json(path).version }];
  }));
  const observed = [...['package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map(name => join(p.profile, name)), p.manifest, p.activate, p.recipe, p.cliAnchor, p.cli, p.pnpm, basePath, ...presets.map(item => item.path), ...p.launchers, join(p.dshHome, 'cordis.patch.yml'), p.preference, ...JSON.parse(manifest.content).plugins.map(row => join(p.repo, 'plugins', row.module)), ...['managed-plans/store.mjs', 'managed-plans/mode.mjs', 'managed-plans/presentation.mjs', 'common.mjs'].map(name => join(p.repo, 'plugins', name)), join(p.repo, 'tools/task10-profile/promotion.mjs'), ...Object.values(resolution).map(item => item.manifestPath)];
  const inputs = Object.fromEntries([...new Set(observed)].map(path => [path, digest(path)]));
  let preference = null;
  if (existsSync(p.preference)) { try { preference = json(p.preference).preset ?? '(invalid)'; } catch { preference = '(invalid JSON)'; } }
  const configChoice = rowsConfigPreset(YAML, readFileSync(join(p.profile, 'cordis.patch.yml'), 'utf8'));
  return { schemaVersion: 1, paths: p, inputs, originalPackage: pkg, nonTui, resolution, presets, manifest, patch, selectedPreset: { environment: process.env.DSH_TUI_PRESET ?? null, profile: configChoice, preference }, activeRuntimePids: (io.runtimePids ?? runtimePids)(), runtimeVersion: RUNTIME };
}
function rowsConfigPreset(YAML, source) {
  const choice = yamlValue(YAML, source).find(row => row.id === 'dsh-tui')?.config?.preset;
  return typeof choice === 'string' ? choice : choice ? '(expression; not evaluated)' : null;
}

export async function prepare({ bundle: bundlePath, state: requested, paths: p = defaultPaths() }, io = {}) {
  const plan = await inspect(p, io);
  const bundle = bundleInfo(bundlePath, p, io);
  const state = statePath(requested, p);
  if (existsSync(state)) fail('Preparation directory already exists; choose a fresh path; nothing is deleted');
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(join(state, 'presets'), { mode: 0o700 });
  copyFileSync(bundle.tarball, join(state, 'bundle.tgz'));
  if (digest(join(state, 'bundle.tgz')) !== bundle.tarballSha256) fail('Copied tarball changed during preparation');
  for (const preset of plan.presets.filter(item => !item.untouched)) writeNew(join(state, 'presets', preset.id + '.yml'), preset.content);
  writeNew(join(state, 'activation.proposed.json'), plan.manifest.content);
  writeNew(join(state, 'cordis.before-activation.yml'), plan.patch.beforeActivation);
  writeNew(join(state, 'cordis.proposed.yml'), plan.patch.final);
  const next = structuredClone(plan.originalPackage);
  next.dependencies[TUI] = 'file:' + join(p.profile, 'task10-promotion/bundle.tgz');
  writeNew(join(state, 'package.proposed.json'), pretty(next));
  const artifacts = Object.fromEntries(['bundle.tgz', 'activation.proposed.json', 'cordis.before-activation.yml', 'cordis.proposed.yml', 'package.proposed.json', ...plan.presets.filter(item => !item.untouched).map(item => 'presets/' + item.id + '.yml')].map(name => [name, digest(join(state, name))]));
  // Keep generated YAML in private files, not JSON/stdout, which could disclose
  // inline provider secrets. The plan records only paths/hashes and package facts.
  const { patch, presets, manifest, ...safe } = plan;
  const prepared = { ...safe, state, bundle, artifacts, presets: presets.map(({ content, ...item }) => item), manifest: { proposedRows: manifest.proposedRows, removesKnownInactive: manifest.removesKnownInactive } };
  prepared.preparationValidation = await validateComposition(prepared, io, bundle);
  writeNew(join(state, 'plan.json'), pretty(prepared));
  return { state, plan: join(state, 'plan.json'), proposedManifest: plan.manifest.proposedRows, activeRuntimePids: plan.activeRuntimePids, preparationValidation: prepared.preparationValidation };
}
function verifyInputs(plan) {
  for (const [path, expected] of Object.entries(plan.inputs)) if (digest(path) !== expected) fail(`Preparation input drift: ${path}; prepare a new directory`);
  for (const [name, expected] of Object.entries(plan.artifacts)) if (digest(join(plan.state, name)) !== expected) fail(`Preparation artifact drift: ${name}`);
}
function treeInventory(root) {
  const entries = [];
  function walk(path, relative) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) entries.push({ path: relative, kind: 'link', target: readlinkSync(path), mode: stat.mode & 0o7777 });
    else if (stat.isDirectory()) {
      entries.push({ path: relative, kind: 'directory', mode: stat.mode & 0o7777 });
      for (const name of readdirSync(path).sort()) walk(join(path, name), relative ? relative + '/' + name : name);
    } else if (stat.isFile()) entries.push({ path: relative, kind: 'file', mode: stat.mode & 0o7777, sha256: digest(path), size: stat.size });
    else fail(`Cannot safely archive special profile file: ${path}`);
  }
  walk(root, '');
  return entries;
}
function syncPath(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function saveReceipt(path, value) {
  writeFileSync(path, pretty(value), { mode: 0o600 }); syncPath(path); syncPath(dirname(path));
}
function rollbackFingerprint(p) {
  const { YAML } = libraries(p);
  if (JSON.stringify(yamlValue(YAML, readFileSync(join(p.profile, 'cordis.yml'), 'utf8'))) !== '[]') fail('Post-apply root config has entries; owner-directed recovery required');
  // CLI normalizes the empty root and plugin-manager updates generated metadata.
  // Neither should prevent immediate recovery; both remain in the retired tree.
  const guarded = treeInventory(p.profile).filter(item => item.path !== 'cordis.yml' && item.path !== '.plugin-manager' && !item.path.startsWith('.plugin-manager/'));
  return hash(pretty(guarded));
}

async function validateComposition(plan, io, preparedBundle) {
  const p = plan.paths, { YAML, require } = libraries(p);
  const boot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href);
  // loadProfileDirectory is the read-only public API; loadProfile/CLI dump are not.
  const loaded = boot.loadProfileDirectory('promotion', p.profile, p.cliAnchor);
  if (loaded.skippedBundles.length) fail(`Composed bundle refused: ${loaded.skippedBundles.map(item => item.packageName).join(', ')}`);
  const layers = loaded.layers.map(layer => layer.patches);
  if (preparedBundle) {
    const index = loaded.layers.findIndex(layer => layer.packageName === TUI);
    if (index < 0) fail('TUI bundle missing from existing composition');
    const packed = JSON.parse((io.run ?? runCommand)('tar', ['-xOf', preparedBundle.tarball, 'package/package.json']));
    if (packed.dsh.bundle.patch !== './cordis.patch.yml') fail('Tarball bundle patch layout changed; review helper');
    layers[index] = yamlValue(YAML, (io.run ?? runCommand)('tar', ['-xOf', preparedBundle.tarball, 'package/cordis.patch.yml']));
  }
  layers.push(preparedBundle ? boot.loadOverlayPatches('promotion', join(plan.state, 'cordis.proposed.yml')) : loaded.patches);
  const homePatch = join(p.dshHome, 'cordis.patch.yml');
  if (existsSync(homePatch)) layers.push(boot.loadOverlayPatches('promotion', homePatch));
  const warnings = [], rows = boot.composeEntries(layers, warning => warnings.push(warning));
  if (warnings.length) fail(`Composed config has skipped patches (${warnings.length}); inspect privately`);
  if (allRows(rows).some(row => row.name === '@deepseek-ai/dsh-plan-mode' && row.disabled !== true)) fail('Native root planning remains enabled');
  const tui = rows.find(row => row.id === 'dsh-tui');
  if (tui?.config?.externalPlanCommand !== true || tui.config.lang !== 'en') fail('Composed TUI external plan command/English language not enabled');
  for (const id of ['standard', 'ptc', 'cordis']) {
    const declarations = rows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id === id && row.disabled !== true);
    if (declarations.length !== 1 || declarations[0].config.plugins?.length !== 1 || declarations[0].config.plugins[0].name !== '@deepseek-ai/cordis-plugin-include') fail(`Declarative preset seat invalid: ${id}`);
    const path = declarations[0].config.plugins[0].config.path;
    if (path !== join(p.profile, 'task10-promotion/presets', id + '.yml')) fail(`Unexpected preset include path: ${id}`);
    const actual = preparedBundle ? join(plan.state, 'presets', id + '.yml') : path;
    if (digest(actual) !== plan.artifacts['presets/' + id + '.yml'] || allRows(yamlValue(YAML, readFileSync(actual, 'utf8'))).some(row => row.name === '@deepseek-ai/dsh-plan-mode')) fail(`Durable preset differs or owns native planning: ${id}`);
  }
  for (const id of ['alex-managed-plans', 'alex-managed-plans-tui']) if (rows.filter(row => row.id === id && row.disabled !== true).length !== 1) fail(`Managed activation is invalid: ${id}`);
  return { composition: 'pass (public offline patch API; expressions retained, not evaluated)', planningOwners: 'root disabled; official standard/PTC/cordis planning filtered; minimal unchanged', packageUiSmoke: preparedBundle ? 'pending installed import smoke on --apply; tarball API shape checked' : 'checked separately after composition', interactiveAcceptance: 'pending owner launch; current mode/preset selections are not changed' };
}

async function validate(plan, io) {
  const p = plan.paths, { YAML, require } = libraries(p);
  const pkg = json(join(p.profile, 'package.json'));
  const expected = json(join(plan.state, 'package.proposed.json'));
  if (JSON.stringify(pkg) !== JSON.stringify(expected)) fail('Installer changed profile package beyond the TUI dependency');
  const lock = yamlValue(YAML, readFileSync(join(p.profile, 'pnpm-lock.yaml'), 'utf8'));
  for (const [name, before] of Object.entries(plan.resolution)) {
    if (JSON.stringify(lock.importers?.['.']?.dependencies?.[name]) !== JSON.stringify(before.importer)) fail(`Non-TUI dependency resolution changed: ${name}`);
    const after = createRequire(join(p.profile, 'package.json')).resolve(name + '/package.json');
    if (digest(after) !== before.manifestSha256) fail(`Non-TUI installed package changed: ${name}`);
  }
  if (digest(join(p.profile, 'cordis.patch.yml')) !== plan.artifacts['cordis.proposed.yml']) fail('Scoped activation differs from reviewed preview');
  for (const launcher of p.launchers) if (digest(launcher) !== plan.inputs[launcher]) fail(`Launcher changed: ${launcher}`);
  if (json(p.cliAnchor).version !== RUNTIME || json(require.resolve('@deepseek-ai/dsh-base/package.json')).version !== RUNTIME) fail('Runtime/base version changed');
  await validateComposition(plan, io);
  // This child imports public package APIs with the CLI's existing in-memory
  // resolution hook. It does not boot, mount plugins, start agents or call models.
  const smoke = `import{createRequire}from'node:module';import{pathToFileURL}from'node:url';import{setEnvironmentData}from'node:worker_threads';const r=createRequire(${JSON.stringify(p.cliAnchor)});const b=await import(pathToFileURL(r.resolve('@deepseek-ai/dsh-app-boot')).href);const profile=b.loadProfileDirectory('promotion',${JSON.stringify(p.profile)},${JSON.stringify(p.cliAnchor)});const resolution=await b.createRuntimeResolution({installAnchor:${JSON.stringify(p.cliAnchor)},profile,home:${JSON.stringify(p.dshHome)}});setEnvironmentData('@deepseek-ai/dsh-app-boot/profile-resolution',{resolution});await import(pathToFileURL(r.resolve('@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap')).href);const q=createRequire(${JSON.stringify(join(p.profile, 'package.json'))});const ui=await import(pathToFileURL(q.resolve('${TUI}/ui')).href);if(!ui.Markdown||typeof ui.markdownSourceRange!=='function'||typeof ui.markdownSourceBlocks!=='function')throw Error('Missing public UI API');await import(pathToFileURL(q.resolve('${TUI}')).href);await import(${JSON.stringify(pathToFileURL(join(p.repo, 'plugins/managed-plans/index.mjs')).href)});await import(${JSON.stringify(pathToFileURL(join(p.repo, 'plugins/managed-plans/tui.mjs')).href)});`;
  (io.run ?? runCommand)(process.execPath, ['--input-type=module', '-e', smoke], { cwd: p.profile, env: { ...process.env, DSH_HOME: p.dshHome, NODE_ENV: 'production', DSH_TELEMETRY_DISABLED: '1' } });
  return { composition: 'pass (public offline patch API; no expression evaluation)', publicPackageUiSmoke: 'pass (imports only; no plugin mount/model calls)', nonTuiResolution: 'unchanged', interactiveAcceptance: 'pending owner launch', customPresetWarning: 'Official standard/PTC/cordis replaced; minimal unchanged. User/custom and packaged liangshen presets were not rewritten; inspect them before using managed planning.' };
}

export async function apply({ state: requested, harnessClosed = false, allowRunning = false }, io = {}) {
  const state = resolve(requested ?? fail('--apply requires --state'));
  const plan = json(join(state, 'plan.json')), p = plan.paths;
  if (plan.schemaVersion !== 1 || plan.state !== state) fail('Invalid preparation plan');
  statePath(state, p); realDirectory(state); realDirectory(p.profile);
  assertClosed(harnessClosed, io, allowRunning); verifyInputs(plan);
  if (existsSync(join(state, 'receipt.json'))) fail('Receipt already exists; inspect/rollback instead of applying twice');
  if (statSync(dirname(p.profile)).dev !== statSync(state).dev) fail('State and profile must share filesystem for recoverable rollback quarantine');
  const run = io.run ?? runCommand;
  const backup = join(state, 'backup'); mkdirSync(backup, { mode: 0o700 });
  const inventory = treeInventory(p.profile);
  writeNew(join(backup, 'profile.inventory.json'), pretty(inventory));
  run('tar', ['-cpf', join(backup, 'profile.tar'), '-C', p.profile, '.']);
  run('tar', ['-df', join(backup, 'profile.tar'), '-C', p.profile]);
  if (JSON.stringify(treeInventory(p.profile)) !== JSON.stringify(inventory)) fail('Profile changed while backing up; no live writes performed');
  copyFileSync(p.manifest, join(backup, 'activation.json'));
  if (digest(join(backup, 'activation.json')) !== plan.inputs[p.manifest]) fail('Manifest changed while backing up');
  for (const name of ['profile.tar', 'profile.inventory.json', 'activation.json']) syncPath(join(backup, name));
  syncPath(backup);
  const receiptPath = join(state, 'receipt.json');
  const receipt = { schemaVersion: 1, status: 'backed-up', state, profile: p.profile, manifest: p.manifest, createdAt: new Date().toISOString(), backup: { archive: join(backup, 'profile.tar'), archiveSha256: digest(join(backup, 'profile.tar')), inventory: join(backup, 'profile.inventory.json'), inventorySha256: digest(join(backup, 'profile.inventory.json')), manifest: join(backup, 'activation.json'), manifestSha256: digest(join(backup, 'activation.json')) }, bundle: plan.bundle, priorDependencyResolution: plan.resolution, proposedManifest: plan.manifest, validation: null, rollback: null };
  saveReceipt(receiptPath, receipt);
  try {
    // Last drift/process check after the potentially long full node_modules backup.
    verifyInputs(plan); assertClosed(harnessClosed, io, allowRunning);
    receipt.status = 'applying'; saveReceipt(receiptPath, receipt);
    const durable = join(p.profile, 'task10-promotion'); mkdirSync(durable, { mode: 0o700 });
    mkdirSync(join(durable, 'presets'), { mode: 0o700 });
    copyFileSync(join(state, 'bundle.tgz'), join(durable, 'bundle.tgz'));
    for (const preset of plan.presets.filter(item => !item.untouched)) copyFileSync(join(state, 'presets', preset.id + '.yml'), join(durable, 'presets', preset.id + '.yml'));
    copyFileSync(join(state, 'package.proposed.json'), join(p.profile, 'package.json'));
    // Absolute existing pnpm; no fish launcher, global npm, build scripts or base
    // installation. The original lock is retained as pnpm's resolution input.
    run(p.pnpm, ['--dir', p.profile, 'install', '--ignore-workspace', '--prod', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: p.profile, env: { ...process.env, NODE_ENV: 'production' } });
    copyFileSync(join(state, 'activation.proposed.json'), p.manifest);
    copyFileSync(join(state, 'cordis.before-activation.yml'), join(p.profile, 'cordis.patch.yml'));
    run(process.execPath, [p.activate, '--write', '--profile', 'dsh-tui', '--root', p.repo], { cwd: p.repo, env: { ...process.env, DSH_HOME: p.dshHome } });
    receipt.validation = await (io.validate ?? validate)(plan, io);
    receipt.status = 'applied'; receipt.appliedAt = new Date().toISOString();
    receipt.installed = { tarball: join(durable, 'bundle.tgz'), tarballSha256: digest(join(durable, 'bundle.tgz')), lockfileSha256: digest(join(p.profile, 'pnpm-lock.yaml')), profileInventorySha256: hash(pretty(treeInventory(p.profile))), rollbackFingerprint: rollbackFingerprint(p), manifestSha256: digest(p.manifest), rollbackDriftPolicy: 'Ignore only generated .plugin-manager metadata and normalized empty cordis.yml; retain everything in quarantine' };
    saveReceipt(receiptPath, receipt);
    return { receipt: receiptPath, status: receipt.status, validation: receipt.validation };
  } catch (error) {
    receipt.status = 'apply-failed'; receipt.error = 'Apply/validation failed; see command diagnostics (not copied here to avoid secrets)'; saveReceipt(receiptPath, receipt);
    if (existsSync(join(p.profile, 'task10-promotion'))) {
      try { await rollback({ receipt: receiptPath, harnessClosed, automatic: true }, io); }
      catch (recovery) { fail(`Apply failed (${error.message}); rollback also failed (${recovery.message}). Backup/receipt retained at ${state}. Multi-file changes are NOT atomic; inspect before launching.`); }
    }
    fail(`Apply failed (${error.message}); ${existsSync(join(p.profile, 'task10-promotion')) ? 'manual recovery required' : 'original profile/manifest restored or no live writes occurred'}. Receipt: ${receiptPath}`);
  }
}

export async function rollback({ receipt: receiptPath, harnessClosed = false, automatic = false }, io = {}) {
  const receipt = json(receiptPath), state = dirname(resolve(receiptPath));
  const plan = json(join(state, 'plan.json')), p = plan.paths;
  if (receipt.schemaVersion !== 1 || receipt.state !== state || receipt.profile !== p.profile || receipt.manifest !== p.manifest || plan.state !== state) fail('Receipt/plan paths disagree');
  statePath(state, p); realDirectory(state); realDirectory(p.profile); assertClosed(harnessClosed, io);
  if (receipt.status === 'rolled-back') fail('Already rolled back; nothing changed');
  if (!automatic && receipt.status !== 'applied') fail('Incomplete/failed receipt: inspect before manual recovery');
  for (const [path, expected] of [[receipt.backup.archive, receipt.backup.archiveSha256], [receipt.backup.inventory, receipt.backup.inventorySha256], [receipt.backup.manifest, receipt.backup.manifestSha256]]) {
    if (!within(path, join(state, 'backup')) || digest(path) !== expected) fail('Rollback backup path/hash is invalid');
  }
  if (!automatic && (rollbackFingerprint(p) !== receipt.installed.rollbackFingerprint || digest(p.manifest) !== receipt.installed.manifestSha256)) fail('Post-apply profile/manifest edits detected; refusing to overwrite. Backup retained for owner-directed recovery.');
  const quarantine = join(state, 'retired-profile');
  if (existsSync(quarantine)) fail('Rollback quarantine already exists; inspect partial recovery manually');
  // No deletion/reinstallation: keep every failed/new file as a quarantined tree
  // and restore the byte-exact profile, node_modules and original lock together.
  renameSync(p.profile, quarantine);
  receipt.status = 'rolling-back'; receipt.rollback = { quarantine, startedAt: new Date().toISOString() }; saveReceipt(receiptPath, receipt);
  mkdirSync(p.profile);
  (io.run ?? runCommand)('tar', ['-xpf', receipt.backup.archive, '-C', p.profile]);
  copyFileSync(receipt.backup.manifest, p.manifest);
  if (JSON.stringify(treeInventory(p.profile)) !== JSON.stringify(json(receipt.backup.inventory)) || digest(p.manifest) !== receipt.backup.manifestSha256) fail('Rollback restore verification failed; keep backup and retired tree for manual recovery');
  receipt.status = 'rolled-back'; receipt.rollback.finishedAt = new Date().toISOString(); receipt.rollback.verified = true;
  saveReceipt(receiptPath, receipt);
  return { receipt: resolve(receiptPath), status: receipt.status, quarantine };
}

const USAGE = `Usage (from this repo; preparation never installs/builds or writes the live profile):
  node tools/task10-profile/promotion.mjs --check [--bundle ABSOLUTE_BUNDLE_JSON]
  node tools/task10-profile/promotion.mjs --prepare --bundle ABSOLUTE_BUNDLE_JSON --state ABSENT_ABSOLUTE_DURABLE_DIR
  # ONLY after exiting Harness and every default dsh-tui runtime:
  node /home/alex/git/my/dsh-customs/tools/task10-profile/promotion.mjs --apply --state PREPARED_DIR --harness-closed
  node /home/alex/git/my/dsh-customs/tools/task10-profile/promotion.mjs --rollback --receipt PREPARED_DIR/receipt.json --harness-closed
No atomic multi-file guarantee. Full backup, failed/new profile and artifacts are retained; nothing is automatically deleted.`;
export async function main(argv = process.argv.slice(2)) {
  let mode = '--check'; const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['--check', '--prepare', '--apply', '--rollback'].includes(arg)) { if (options.mode) fail('Choose exactly one operation'); mode = arg; options.mode = true; }
    else if (['--bundle', '--state', '--receipt'].includes(arg) && argv[index + 1] && !argv[index + 1].startsWith('--')) options[arg.slice(2)] = argv[++index];
    else if (arg === '--harness-closed') options.harnessClosed = true;
    else if (arg === '--allow-running') options.allowRunning = true;
    else if (arg === '--help') { console.log(USAGE); return; }
    else fail(USAGE);
  }
  const p = defaultPaths(); let result;
  if (mode === '--check') {
    const plan = await inspect(p);
    if (options.bundle) bundleInfo(resolve(options.bundle), p, {});
    result = { mode: 'read-only', profile: p.profile, runtime: plan.runtimeVersion, currentTui: plan.originalPackage.dependencies[TUI], nonTuiDependencies: plan.nonTui, proposedManifest: plan.manifest, presets: plan.presets.map(({ id, untouched, retainedRows }) => ({ id, untouched: Boolean(untouched), retainedRows })), selectedPreset: plan.selectedPreset, activeRuntimePids: plan.activeRuntimePids, warning: 'Exit Harness before apply. Custom/packaged presets and persisted session selections are not rewritten. UI modes using native planMode need owner acceptance; no real interactive/model acceptance is claimed.' };
  } else if (mode === '--prepare') {
    if (!options.bundle) fail('--prepare requires --bundle');
    result = await prepare({ ...options, bundle: resolve(options.bundle), paths: p });
  } else if (mode === '--apply') result = await apply(options);
  else result = await rollback(options);
  console.log(pretty(result));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
