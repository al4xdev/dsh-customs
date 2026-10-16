import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { YAML } from './session-companion/profile.mjs';
import { RESILIENCE_PROFILES, RESILIENCE_MODULES } from './resilience/profile.mjs';

const script = fileURLToPath(new URL('./activate.mjs', import.meta.url));
const yamlRoot = dirname(createRequire(join(homedir(), '.local/share/dsh-cli/package.json')).resolve('yaml/package.json'));
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const parse = source => { const doc = YAML.parseDocument(source); assert.deepEqual(doc.errors, []); return doc.toJS(); };
const inserted = source => parse(source).flatMap(row => row.insert ?? []);
const controller = source => inserted(source).find(row => row.id === 'alex-llm-resilience');
const native = source => parse(source).find(row => row.id === 'llm-retry');

function fixture({ profiles = ['web'], global = true, extras = [], source = () => '[]\n', overlay, missing = [], globalConfig = {} } = {}) {
  // Synthetic profiles only; do not read/copy/write any owner's profile data.
  const dir = mkdtempSync(join(tmpdir(), 'resilience-activate-'));
  const root = join(dir, 'repo'), home = join(dir, '.dsh');
  const plugins = [...(global ? [{ id: 'alex-llm-resilience', module: RESILIENCE_MODULES['alex-llm-resilience'], config: globalConfig, profiles: RESILIENCE_PROFILES, overlay: false }] : []), ...extras];
  write(join(root, 'plugins/activation.json'), JSON.stringify({ managedIdPrefix: 'alex-', profiles, isolatedProfiles: ['companion'], plugins }));
  for (const module of [...plugins.map(plugin => plugin.module), ...Object.values(RESILIENCE_MODULES)].filter(module => !missing.includes(module))) {
    write(join(root, 'plugins', module), 'throw new Error("activation must never import configured plugin modules");\n');
  }
  mkdirSync(join(home, 'profiles/node_modules'), { recursive: true });
  symlinkSync(yamlRoot, join(home, 'profiles/node_modules/yaml'), 'dir');
  const patchPath = profile => join(home, 'profiles', profile, 'cordis.patch.yml');
  for (const profile of profiles) write(patchPath(profile), source(root, profile));
  if (overlay !== undefined) write(join(root, 'plugins/cordis.patch.yml'), overlay(root));
  const text = profile => readFileSync(patchPath(profile), 'utf8');
  const run = (args = [], executable = script) => {
    const result = spawnSync(process.execPath, [executable, '--root', root, '--json', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, DSH_HOME: home } });
    assert.equal(result.error, undefined);
    assert(result.stdout.trim(), result.stderr);
    return { status: result.status, report: JSON.parse(result.stdout), stderr: result.stderr };
  };
  return { dir, root, home, patchPath, text, run };
}
const protection = `# owner model and permissions must remain byte-identical
- id: agent-default-model
  config: { provider: owner-local, model: "custom-model", maxTokens: 8192 }
- id: sandbox-policy
  config: { mode: workspace-write, approval: ask, cwd: !!js process.cwd() }
`;
const fork = (root, cap = 86400000) => `- insert:
    - id: antigravity-quota-retry
      name: ${root}/plugins/antigravity-quota-retry/index.mjs
      config: { maxQuotaWaitMs: ${cap} }
`;
const optout = `# explicit native zero must survive both sync and migration
- id: dsh-tui-auth
  config:
    retryPolicies:
      openai-codex: { mode: normal, maxRetries: 0 }
`;

for (const profile of RESILIENCE_PROFILES) test(`${profile}: fresh controller activation disables native retry, removes fork, preserves owner config and is idempotent`, () => {
  const f = fixture({ profiles: [profile], source: root => protection + '- id: llm-retry\n  disabled: false\n' + fork(root) });
  const before = f.text(profile), check = f.run(['--check', '--profile', profile]);
  assert.equal(check.status, 1); assert.equal(f.text(profile), before, '--check never writes');
  assert(check.report.reports[0].resilience.reasons.includes('disable-native-retry-engine'));
  const applied = f.run(['--write', '--profile', profile]);
  assert.equal(applied.status, 0); assert.equal(applied.report.reports[0].written, true);
  const final = f.text(profile), rows = inserted(final);
  assert(final.includes(protection)); assert.equal(native(final).disabled, true);
  assert(!rows.some(row => row.id === 'antigravity-quota-retry'));
  for (const id of ['alex-llm-resilience', 'alex-codex-transient-close', 'alex-agent-self-heal']) assert.equal(rows.filter(row => row.id === id).length, 1);
  assert(rows.find(row => row.id === 'alex-agent-self-heal').name.endsWith('/lib/index-v7-unified.mjs'));
  assert(rows.find(row => row.id === 'alex-llm-resilience').name.endsWith('/lib/index-v6-unified.mjs'));
  assert.equal(f.run(['--check', '--profile', profile]).status, 0);
  assert.equal(f.text(profile), final);
});

test('an empty flow-list patch becomes one valid root and remains in sync', () => {
  const f = fixture({ source: () => '# retain empty-profile comment\n[]\n' });
  assert.equal(f.run(['--write', '--profile', 'web']).status, 0);
  const final = f.text('web');
  assert(final.startsWith('# retain empty-profile comment\n'));
  assert.equal(native(final).disabled, true); assert(controller(final));
  assert.equal(f.run(['--check', '--profile', 'web']).status, 0);
  assert.equal(f.text('web'), final);
});

test('post-sync migration preserves an existing explicit zero and its native source on every check', () => {
  const f = fixture({ profiles: ['dsh-tui'], source: root => protection + optout + `- insert:
    - id: alex-llm-resilience
      name: ${root}/plugins/llm-resilience/index.mjs
      config: { providers: { openai-codex: { maxRetries: 0 } } }
` });
  assert.equal(f.run(['--write', '--profile', 'dsh-tui']).status, 0);
  const final = f.text('dsh-tui');
  assert(final.includes(protection)); assert(final.includes(optout));
  assert.deepEqual(controller(final).config.providers['openai-codex'], { maxRetries: 0 });
  assert.equal(f.run(['--check', '--profile', 'dsh-tui']).status, 0);
  assert.equal(f.text('dsh-tui'), final);
});

test('explicit finite native policy fields are migrated without native resolved defaults', () => {
  const source = `- id: dsh-tui-auth
  config:
    retryPolicies:
      custom-provider:
        mode: normal
        maxRetries: 4
        retryableCodes: [SERVER]
        backoff: { initialDelayMs: 17, maxDelayMs: 99, jitterRatio: 0 }
`;
  const f = fixture({ source: () => protection + source });
  assert.equal(f.run(['--write', '--profile', 'web']).status, 0);
  const final = f.text('web');
  assert(final.includes(source));
  assert.deepEqual(controller(final).config.providers['custom-provider'], { maxRetries: 4, retryableCodes: ['SERVER'], initialDelayMs: 17, maxDelayMs: 99, jitterRatio: 0 });
  assert.equal(f.run(['--check', '--profile', 'web']).status, 0);
});

test('a controller-free manifest leaves native engines/custom policies untouched and needs no helper deployment', () => {
  const f = fixture({ global: false, extras: [{ id: 'alex-example', module: 'example/index.mjs' }], source: root => protection + '- id: llm-retry\n  disabled: false\n' + '- id: dsh-tui-auth\n  config: { retryPolicies: { custom: { mode: always } } }\n' + fork(root, 123) });
  // Match legacy consumers that copy only activate + its selector into a repo.
  const copied = join(f.root, 'tools/activate.mjs');
  write(copied, readFileSync(script, 'utf8'));
  write(join(f.root, 'tools/activation-selection.mjs'), readFileSync(new URL('./activation-selection.mjs', import.meta.url), 'utf8'));
  write(join(f.root, 'tools/profile-paths.mjs'), readFileSync(new URL('./profile-paths.mjs', import.meta.url), 'utf8'));
  const original = f.text('web');
  assert.equal(f.run(['--write', '--profile', 'web'], copied).status, 0);
  const final = f.text('web');
  assert.equal(native(final).disabled, false); assert(!controller(final));
  assert(final.includes('mode: always')); assert(final.includes('maxQuotaWaitMs: 123'));
  assert(original.includes(protection) && final.includes(protection));
  assert.equal(f.run(['--check', '--profile', 'web'], copied).status, 0);
});

test('generic overlay synchronization never applies root resilience migration or adds global parents', () => {
  const f = fixture({ profiles: [], extras: [{ id: 'alex-example', module: 'example/index.mjs' }], overlay: root => '- id: llm-retry\n  disabled: false\n' + fork(root) });
  assert.equal(f.run(['--write']).status, 0);
  const final = readFileSync(join(f.root, 'plugins/cordis.patch.yml'), 'utf8');
  assert.equal(native(final).disabled, false);
  assert(inserted(final).some(row => row.id === 'antigravity-quota-retry'));
  assert(!inserted(final).some(row => ['alex-llm-resilience', 'alex-codex-transient-close', 'alex-agent-self-heal'].includes(row.id)));
  assert.equal(f.run(['--check']).status, 0);
});

for (const [name, invalid] of [
  ['custom always policy', () => '- id: dsh-tui-auth\n  config: { retryPolicies: { custom: { mode: always } } }\n'],
  ['custom fork cap', root => fork(root, 123)],
]) test(`${name} refuses every selected write before any file changes`, () => {
  const f = fixture({ profiles: ['web', 'tui'], source: (root, profile) => profile === 'web' ? '[]\n' : protection + invalid(root) });
  const before = Object.fromEntries(['web', 'tui'].map(profile => [profile, f.text(profile)]));
  const result = f.run(['--write']);
  assert.equal(result.status, 3);
  assert(result.report.reports.find(row => row.label === 'tui').error);
  for (const profile of ['web', 'tui']) assert.equal(f.text(profile), before[profile]);
  assert(result.report.reports.every(row => !row.written));
});

test('existing central opt-outs and explicit self-heal cap survive default manifest synchronization', () => {
  const f = fixture({ source: root => protection + `- insert:
    - id: alex-llm-resilience
      name: ${root}/plugins/llm-resilience/index.mjs
      config: { policy: { maxRetries: 2 }, providers: { private-route: { maxRetries: 0 } } }
    - id: alex-agent-self-heal
      name: ${root}/plugins/agent-self-heal/lib/index-v3-resilience.mjs
      config: { maxCycles: 3 }
` });
  assert.equal(f.run(['--write', '--profile', 'web']).status, 0);
  const final = f.text('web');
  assert(final.includes(protection));
  assert.equal(controller(final).config.policy.maxRetries, 2);
  assert.equal(controller(final).config.providers['private-route'].maxRetries, 0);
  assert.equal(inserted(final).find(row => row.id === 'alex-agent-self-heal').config.maxCycles, 3);
  assert.equal(f.run(['--check', '--profile', 'web']).status, 0);
});

test('contradicting native and central opt-downs are refused before normal sync can hide the conflict', () => {
  const f = fixture({ source: root => optout + `- insert:
    - id: alex-llm-resilience
      name: ${root}/plugins/llm-resilience/index.mjs
      config: { providers: { openai-codex: { maxRetries: 7 } } }
` });
  const before = f.text('web'), result = f.run(['--write', '--profile', 'web']);
  assert.equal(result.status, 3); assert.equal(f.text('web'), before);
  assert.match(result.report.reports[0].note, /conflicting-central-provider-policy/);
});

test('missing immutable compiled recovery artifacts prevent every activation write', () => {
  const f = fixture({ profiles: ['web', 'tui'], missing: [RESILIENCE_MODULES['alex-agent-self-heal']] });
  const before = f.text('web');
  assert.equal(f.run(['--write']).status, 3);
  assert.equal(f.text('web'), before); assert.equal(f.text('tui'), before);
});

for (const globalConfig of [false, 0, '']) test(`invalid falsy recovery manifest config ${JSON.stringify(globalConfig)} cannot silently enable defaults`, () => {
  const f = fixture({ globalConfig }), before = f.text('web');
  const result = f.run(['--write', '--profile', 'web']);
  assert.equal(result.status, 3); assert.equal(f.text('web'), before);
  assert.match(result.report.reports[0].note, /Invalid recovery activation config/);
});

test('manifest disagreement with an existing explicit central cap is refused rather than widened', () => {
  const f = fixture({ globalConfig: { policy: { maxRetries: 10 } }, source: root => `- insert:
    - id: alex-llm-resilience
      name: ${root}/plugins/llm-resilience/index.mjs
      config: { policy: { maxRetries: 2 } }
` });
  const before = f.text('web'), result = f.run(['--write', '--profile', 'web']);
  assert.equal(result.status, 3); assert.equal(f.text('web'), before);
  assert.match(result.report.reports[0].note, /conflicting-activation-recovery-config/);
});

test('profile rows are written relative to the profile, so another HOME with the same layout stays current', () => {
  const { root, home, text, run } = fixture({ profiles: ['web'], source: root => `- insert:
    - id: alex-llm-resilience
      name: ${root}/plugins/llm-resilience/lib/index-v5-unified.mjs
      config: {}
    - id: alex-codex-transient-close
      name: ${root}/plugins/codex-transient-close/index.mjs
    - id: alex-agent-self-heal
      name: ${root}/plugins/agent-self-heal/lib/index-v6-unified.mjs
      config: {}
` });
  assert.equal(run(['--write']).status, 0);
  const profileDir = join(home, 'profiles/web');
  const rows = inserted(text('web')).filter(row => row.id.startsWith('alex-'));
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert(row.name.startsWith('../'), row.name);
    assert(resolve(profileDir, row.name).startsWith(join(root, 'plugins') + '/'), row.name);
  }
  assert.equal(rows.find(row => row.id === 'alex-llm-resilience').name, '../../../repo/plugins/llm-resilience/lib/index-v6-unified.mjs');
  assert.equal(rows.find(row => row.id === 'alex-agent-self-heal').name, '../../../repo/plugins/agent-self-heal/lib/index-v7-unified.mjs');
  const second = run(['--check']);
  assert.equal(second.status, 0);
  assert(second.report.reports.every(report => !report.changed), JSON.stringify(second.report.reports));
});

test('a standalone managed insert is folded and research-activation rows stay its own', () => {
  const research = { id: 'alex-research', module: 'research/index.mjs', profiles: ['dsh-tui'], overlay: false };
  const other = { id: 'alex-other', module: 'other/index.mjs', profiles: ['dsh-tui'] };
  const { text, run } = fixture({ profiles: ['dsh-tui'], extras: [research, other], source: root => `- insert:
    - id: alex-other
      name: ${root}/plugins/other/index.mjs
    - id: hand-written
      name: /keep/local.mjs
- insert:
    - id: alex-llm-resilience
      name: ${root}/plugins/llm-resilience/lib/index-v5-unified.mjs
      config: {}
# BEGIN alex-research activation v1
- insert:
    - id: alex-research
      name: ${root}/plugins/research/index.mjs
    - id: preset-owned
      name: '@deepseek-ai/dsh-agent-preset'
# END alex-research activation v1
` });
  const first = run(['--write', '--profile', 'dsh-tui']);
  assert.equal(first.status, 0, JSON.stringify(first.report.reports));
  const final = text('dsh-tui');
  const rows = inserted(final);
  for (const id of ['alex-llm-resilience', 'alex-other', 'alex-research']) assert.equal(rows.filter(row => row.id === id).length, 1, id);
  assert.equal(parse(final).filter(patch => patch.insert?.length === 1 && patch.insert[0].id === 'alex-llm-resilience').length, 0, 'standalone insert folded');
  assert(final.includes(`# BEGIN alex-research activation v1\n- insert:\n    - id: alex-research\n`), 'research block untouched');
  assert(rows.find(row => row.id === 'hand-written'));
  assert.equal(run(['--check', '--profile', 'dsh-tui']).status, 0);
  assert.equal(text('dsh-tui'), final);
});

test('a loader-reformatted managed block is current and is not rewritten', () => {
  const { text, run, root } = fixture({ profiles: ['web'] });
  assert.equal(run(['--write', '--profile', 'web']).status, 0);
  // Same rows in the Cordis Loader's write-back style (`config: {}` inline).
  const restyled = text('web').replace(/config:\n\s+\{\}/g, 'config: {}');
  assert.notEqual(restyled, text('web'));
  write(join(dirname(join(root, '..', '.dsh/profiles/web/cordis.patch.yml')), 'cordis.patch.yml'), restyled);
  const check = run(['--check', '--profile', 'web']);
  assert.equal(check.status, 0, JSON.stringify(check.report.reports));
  assert.equal(run(['--write', '--profile', 'web']).status, 0);
  assert.equal(text('web'), restyled, 'equivalent YAML keeps the existing bytes');
});
