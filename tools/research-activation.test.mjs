import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYaml, makeCodec, compose, planActivation, applyPlan, rollback, PROFILES, hash } from './research-activation.mjs';

const YAML = loadYaml();
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = resolve(HERE, '../.dumps');
const WEB = '@deepseek-ai/dsh-tool-web';
const PRESET = '@deepseek-ai/dsh-agent-preset';
const INCLUDE = '@deepseek-ai/cordis-plugin-include';
const codec = makeCodec(YAML);
const parse = text => codec.parse(text).toJS();

function fixture(t) {
  mkdirSync(SCRATCH, { recursive: true });
  const root = mkdtempSync(join(SCRATCH, 'research-activation-test-'));
  // Only remove the exact directory created here, never a supplied/computed root.
  t.after(() => { assert.ok(root.startsWith(join(SCRATCH, 'research-activation-test-'))); rmSync(root, { recursive: true, force: true }); });
  const profilesDir = join(root, 'profiles'), packages = join(root, 'packages');
  const put = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data)); return path; };
  const yput = (path, value) => put(path, YAML.stringify(value));
  const packageDirs = {
    base: join(packages, 'base'),
    surface: join(packages, 'surface'),
    '@deepseek-ai/dsh-web-app': join(packages, 'web-app'),
    '@deepseek-harness-tui/dsh-tui': join(packages, 'dsh-tui'),
  };
  const web = { id: 'tool-web', name: WEB, config: { fetch: true, searchTimeoutMs: 60000 } };
  const preset = id => ({ id: `preset-${id}`, name: PRESET, config: { id, order: 3, plugins: id === 'minimal' ? [] : [{ ...web, config: { fetch: true, searchTimeoutMs: 8123 } }] } });
  for (const [name, dir] of Object.entries(packageDirs)) put(join(dir, 'package.json'), { name, dsh: { bundle: { patch: name === '@deepseek-ai/dsh-web-app' ? ['cordis.patch.yml', ...['standard', 'minimal', 'ptc', 'cordis'].map(id => `presets/${id}.patch.yml`)] : 'cordis.patch.yml' } } });
  yput(join(packageDirs.base, 'cordis.patch.yml'), [{ insert: [web, { id: 'web', name: '@deepseek-ai/dsh-web', config: { searchProvider: 'keep-backend', fetchProvider: 'http' } }, { id: 'unrelated', name: 'other' }] }]);
  yput(join(packageDirs.surface, 'cordis.patch.yml'), [{ id: 'tool-web', disabled: true }]);
  yput(join(packageDirs['@deepseek-ai/dsh-web-app'], 'cordis.patch.yml'), []);
  for (const id of ['standard', 'minimal', 'ptc', 'cordis']) yput(join(packageDirs['@deepseek-ai/dsh-web-app'], `presets/${id}.patch.yml`), [{ insert: [preset(id)] }]);
  const liang = join(packageDirs['@deepseek-harness-tui/dsh-tui'], 'presets/liangshen');
  yput(join(liang, 'preset.yml'), { name: 'Liang', description: 'Keep', order: 7 });
  put(join(liang, 'agent.cordis.yml'), YAML.stringify([web, { id: 'relative', name: './tool-bootstrap.mjs' }]) + '- id: platform\n  name: other\n  disabled: !!js process.platform === "win32"\n');
  const originals = new Map();
  for (const name of PROFILES) {
    const dir = join(profilesDir, name);
    const bundles = ['base', ...(['web', 'dsh-tui', 'companion'].includes(name) ? ['surface'] : []), ...(['web', 'companion'].includes(name) ? ['@deepseek-ai/dsh-web-app'] : [])];
    put(join(dir, 'package.json'), { dsh: { profile: { bundles } } });
    put(join(dir, 'cordis.yml'), '# empty\n[]\n');
    let text = '# owner comment + two separate alex runs\n- insert:\n    - id: alex-first\n      name: /keep/first.mjs\n      config:\n        expr: !!js process.cwd()\n- id: unrelated\n  config: { drift: owner }\n- insert:\n    - id: alex-second\n      name: /keep/second.mjs\n';
    if (name === 'dsh-tui') {
      const local = join(dir, 'standard-managed-plugins.yml');
      yput(local, [web, { id: 'scoped', name: 'cordis:group', group: true, isolate: { custom: true }, config: [{ id: 'custom', name: 'other' }] }]);
      text += YAML.stringify([{ insert: [{ ...preset('standard'), config: { id: 'standard', order: 99, plugins: [{ id: 'standard-managed-plugins', name: INCLUDE, config: { path: local } }] } }] }]);
    }
    if (name === 'companion') text += YAML.stringify([...['standard', 'minimal', 'ptc', 'cordis'].map(id => ({ id: `preset-${id}`, disabled: true })), { insert: [{ id: 'preset-companion', name: PRESET, config: { id: 'companion', plugins: [{ id: 'private', name: '/keep/private.mjs' }] } }] }]);
    originals.set(name, text); put(join(dir, 'cordis.patch.yml'), text);
  }
  const options = { root, profilesDir, YAML, resolvePackage: (_profile, name) => join(packageDirs[name], 'package.json') };
  return { ...options, options, put, yput, packageDirs, originals, plan: () => planActivation(options) };
}

function expandedPlugins(plugins) {
  return plugins.flatMap(row => {
    if (row.name === INCLUDE) return expandedPlugins(parse(readFileSync(row.config.path, 'utf8')));
    if (row.group) return [row, ...expandedPlugins(row.config)];
    return [row];
  });
}

test('five-profile plan is read-only, selective, expression-safe, and preserves scopes', t => {
  const f = fixture(t), plan = f.plan();
  assert.deepEqual(plan.reports.map(r => r.profile), PROFILES);
  assert.equal(existsSync(join(f.root, '.dumps')), false);
  for (const name of PROFILES) {
    const path = join(f.profilesDir, name, 'cordis.patch.yml');
    assert.equal(readFileSync(path, 'utf8'), f.originals.get(name));
    const change = plan.changes.find(c => c.path === path);
    assert.ok(change.after.startsWith(f.originals.get(name)));
    const patches = parse(change.after);
    const added = patches.flatMap(p => p.insert ?? []).filter(p => p.id === 'alex-research');
    assert.equal(added.length, 1); assert.equal(added[0].name, join(f.root, 'plugins/research/index.mjs'));
    assert.equal(patches.filter(p => p.id === 'web').length, 0);
  }
  const companion = plan.changes.find(c => c.path === join(f.profilesDir, 'companion/cordis.patch.yml'));
  assert.equal(parse(companion.after).filter(p => p.id?.startsWith('preset-')).length, 4);
  assert.equal(parse(companion.after).filter(p => p.id === 'tool-web').length, 0);
  assert.ok(plan.changes.some(c => c.after.includes('!!js')));
  assert.ok(plan.changes.some(c => c.after.includes('isolate:')));
});

test('apply fixtures, validate transformed trees, idempotence and exact rollback', t => {
  const f = fixture(t), plan = f.plan(), result = applyPlan(plan);
  assert.ok(result.receipt.includes('/.dumps/research-activation/'));
  const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'));
  for (const c of receipt.changes) assert.equal(hash(readFileSync(c.path)), c.afterHash);
  for (const profile of ['web', 'dsh-tui']) {
    const patches = parse(readFileSync(join(f.profilesDir, profile, 'cordis.patch.yml'), 'utf8'));
    for (const patch of patches.filter(p => p.id?.startsWith('preset-') && p.config?.plugins)) {
      for (const row of expandedPlugins(patch.config.plugins).filter(p => p.name === WEB)) {
        assert.equal(row.config.search, false); assert.equal(row.config.fetch, true);
        assert.ok([60000, 8123].includes(row.config.searchTimeoutMs));
      }
    }
    assert.equal(patches.filter(p => p.id === 'preset-minimal').length, 0);
  }
  assert.equal(f.plan().changes.length, 0);
  const dry = rollback(result.receipt, f.options);
  assert.ok(dry.every(r => r.state === 'would-restore'));
  assert.equal(readFileSync(plan.changes[0].path, 'utf8'), plan.changes[0].after);
  const undone = rollback(result.receipt, { ...f.options, write: true });
  assert.ok(undone.every(r => r.state === 'restored'));
  for (const c of plan.changes) assert.equal(existsSync(c.path) ? readFileSync(c.path, 'utf8') : null, c.before);
  assert.ok(rollback(result.receipt, { ...f.options, write: true }).every(r => r.state === 'already-restored'));
});

test('rollback preserves concurrent patch edits and all dependent artifacts', t => {
  const f = fixture(t), plan = f.plan(), { receipt } = applyPlan(plan);
  const path = join(f.profilesDir, 'web/cordis.patch.yml');
  const edit = readFileSync(path, 'utf8') + '# concurrently edited\n'; f.put(path, edit);
  const results = rollback(receipt, { ...f.options, write: true });
  assert.equal(readFileSync(path, 'utf8'), edit);
  assert.equal(results.find(r => r.path === path).state, 'conflict');
  for (const c of plan.changes.filter(c => c.before === null)) assert.ok(existsSync(c.path));
});

test('rollback preserves edited artifact and validates receipt snapshots/scope', t => {
  const f = fixture(t), plan = f.plan(), { receipt } = applyPlan(plan);
  const artifact = plan.changes.find(c => c.before === null), edit = artifact.after + '# edited\n'; f.put(artifact.path, edit);
  const results = rollback(receipt, { ...f.options, write: true });
  assert.equal(results.find(r => r.path === artifact.path).state, 'conflict');
  assert.equal(readFileSync(artifact.path, 'utf8'), edit);
  const data = JSON.parse(readFileSync(receipt, 'utf8')); data.changes[0].before = 'tampered'; f.put(receipt, data);
  assert.throws(() => rollback(receipt, f.options), /hash mismatch/);
  assert.throws(() => rollback(receipt, { ...f.options, profilesDir: f.root }), /scope/);
});

test('apply refuses source and target changes before making any target write', t => {
  const f = fixture(t), plan = f.plan();
  const source = join(f.packageDirs.base, 'cordis.patch.yml'); f.put(source, readFileSync(source, 'utf8') + '# drift\n');
  assert.throws(() => applyPlan(plan), /source changed/);
  assert.ok(plan.changes.filter(c => c.before === null).every(c => !existsSync(c.path)));
  assert.equal(existsSync(join(f.root, '.dumps')), false);
});

test('ambiguous plugin ids, dynamic target configs and aliases refuse', t => {
  const f = fixture(t), path = join(f.profilesDir, 'headless/cordis.patch.yml'), original = readFileSync(path, 'utf8');
  for (const [suffix, error] of [
    ['- insert:\n    - id: alex-research\n      name: /someone/else.mjs\n', /conflicting research/],
    ['- insert:\n    - id: tool-web\n      name: other\n', /duplicate entry/],
    ['- id: tool-web\n  config: !!js process.env.CONFIG\n', /static mapping/],
    ['- id: tool-web\n  config: &cfg {search: true}\n- id: unrelated\n  config: *cfg\n', /aliases/],
  ]) { f.put(path, original + suffix); assert.throws(() => f.plan(), error); }
});

test('managed artifacts fail closed on non-search drift; symlink targets refuse', t => {
  const f = fixture(t), plan = f.plan(), { receipt } = applyPlan(plan);
  const artifact = plan.changes.find(c => c.before === null); f.put(artifact.path, artifact.after + '# drift\n');
  assert.throws(() => f.plan(), /managed artifact drift/);
  rollback(receipt, { ...f.options, write: true });
  assert.throws(() => f.plan(), /collision\/drift/);
  const fresh = fixture(t), next = fresh.plan(), target = next.changes.find(c => c.before === null);
  symlinkSync(join(fresh.profilesDir, 'web/cordis.patch.yml'), target.path);
  assert.throws(() => applyPlan(next), /non-regular target/);
});

test('receipt recovers a partial commit without touching still-original files', t => {
  const f = fixture(t), plan = f.plan(), { receipt } = applyPlan(plan);
  const patch = plan.changes.find(c => c.path.endsWith('/cordis.patch.yml'));
  f.put(patch.path, patch.before);
  const results = rollback(receipt, { ...f.options, write: true });
  assert.equal(results.find(r => r.path === patch.path).state, 'already-restored');
  assert.ok(results.every(r => ['restored', 'already-restored'].includes(r.state)));
  for (const c of plan.changes) assert.equal(existsSync(c.path) ? readFileSync(c.path, 'utf8') : null, c.before);
});

test('duplicate preset identity and conflicting include patches refuse', t => {
  const f = fixture(t), path = join(f.profilesDir, 'dsh-tui/cordis.patch.yml'), original = readFileSync(path, 'utf8');
  f.put(path, original + YAML.stringify([{ insert: [{ id: 'foreign-seat', name: PRESET, config: { id: 'standard', plugins: [] } }] }]));
  assert.throws(() => f.plan(), /ambiguous preset identity/);
  f.put(path, original + YAML.stringify([{ id: 'preset-standard', config: { id: 'standard', plugins: [{ id: 'included', name: INCLUDE, config: { path: join(f.profilesDir, 'dsh-tui/standard-managed-plugins.yml'), patches: [{ id: 'missing', config: {} }] } }] } }]));
  assert.throws(() => f.plan(), /missing patch target/);
});

test('compose matches shallow replacement and preserves group isolation and !!js tags', () => {
  const entries = codec.parse('- id: g\n  name: cordis:group\n  group: true\n  isolate: {web: true}\n  config:\n    - id: tool-web\n      name: "@deepseek-ai/dsh-tool-web"\n      config: {fetch: false, search: true}\n- id: expr\n  disabled: !!js process.cwd()\n').contents;
  const patches = codec.parse('- id: tool-web\n  config: {search: false}\n').contents;
  const result = compose(entries, patches, codec);
  const js = parse(codec.render(result));
  assert.deepEqual(js[0].config[0].config, { search: false });
  assert.deepEqual(js[0].isolate, { web: true });
  assert.match(codec.render(result), /!!js/);
});

test('explicit fetch:false stays false and search-only change retains extra keys', t => {
  const f = fixture(t), path = join(f.profilesDir, 'tui/cordis.patch.yml');
  f.put(path, readFileSync(path, 'utf8') + '- id: tool-web\n  config: {fetch: false, search: true, searchMaxQueries: 2}\n');
  const c = f.plan().changes.find(c => c.path === path), patches = parse(c.after);
  assert.deepEqual(patches.filter(p => p.id === 'tool-web').at(-1).config, { fetch: false, search: false, searchMaxQueries: 2 });
});
