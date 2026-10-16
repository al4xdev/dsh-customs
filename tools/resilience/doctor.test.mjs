import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { doctor } from './doctor.mjs';
import { RESILIENCE_MODULES } from './profile.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const realRepo = resolve(here, '../..');
const dumpRoot = join(realRepo, '.dumps');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const profiles = ['web', 'dsh-tui'];

async function fixture({ bridge = true } = {}) {
  await mkdir(dumpRoot, { recursive: true, mode: 0o700 });
  const base = await mkdtemp(join(dumpRoot, 'recovery-doctor-test-'));
  const repoRoot = join(base, 'repo'), runtimeRoot = join(base, 'runtime'), dshHome = join(base, 'home/.dsh');
  const put = async (path, bytes) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); };
  // Hermetic repo: only the manifest and the two reviewed artifacts with records.
  await put(join(repoRoot, 'plugins/activation.json'), JSON.stringify({ managedIdPrefix: 'alex-', profiles, plugins: [
    { id: 'alex-llm-resilience', module: RESILIENCE_MODULES['alex-llm-resilience'], profiles },
    { id: 'alex-agent-self-heal', module: RESILIENCE_MODULES['alex-agent-self-heal'], profiles },
  ] }));
  for (const module of Object.values(RESILIENCE_MODULES)) {
    const bytes = `// reviewed fixture ${module}\n`;
    await put(join(repoRoot, 'plugins', module), bytes);
    await put(join(repoRoot, 'plugins', module.replace(/\.mjs$/, '.build.json')), JSON.stringify({ schema: 1, sha256: sha(bytes), sourceHashes: {} }));
  }
  await symlink(join(realRepo, 'node_modules'), join(repoRoot, 'node_modules'), 'dir');
  // Fake runtime SDK faces: the catalog bytes and a validator that mirrors the bridge.
  const session = join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-session');
  await put(join(runtimeRoot, 'package.json'), '{"private":true}');
  await put(join(session, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', type: 'module', main: 'lib/index.js' }));
  await put(join(session, 'lib/index.js'), `export const KNOWN = [${bridge ? '"agent/self-heal", ' : ''}"turn/start"];\n`);
  await put(join(session, 'lib/types/known-event-types.js'), `export const KNOWN = new Set([${bridge ? "'agent/self-heal', " : ''}'turn/start']);\n`);
  const persistence = join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-session-persistence');
  await put(join(persistence, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-persistence', type: 'module', main: 'lib/index.js' }));
  await put(join(persistence, 'lib/index.js'), `const known = new Set([${bridge ? "'agent/self-heal', " : ''}'turn/start']);\nexport function validateStoredEvents(_header, events) { for (const event of events) if (!known.has(event.type)) throw new Error('unsupported'); }\n`);
  const row = (profile, id, module) => `    - id: ${id}\n      name: ${relative(join(dshHome, 'profiles', profile), join(repoRoot, 'plugins', module))}\n      config: {}\n`;
  await put(join(repoRoot, 'plugins/codex-transient-close/index.mjs'), '// bridge fixture\n');
  const writeProfile = async (profile, { controller = RESILIENCE_MODULES['alex-llm-resilience'], owner = RESILIENCE_MODULES['alex-agent-self-heal'], native = 'true', bridge = true, ownerFirst = false, nativeRows = 1, controllerConfig = '{}' } = {}) => {
    const rows = [row(profile, 'alex-llm-resilience', controller).replace('config: {}', `config: ${controllerConfig}`), ...(bridge ? [row(profile, 'alex-codex-transient-close', 'codex-transient-close/index.mjs').replace('      config: {}\n', '')] : []), row(profile, 'alex-agent-self-heal', owner)];
    if (ownerFirst) rows.reverse();
    return put(join(dshHome, 'profiles', profile, 'cordis.patch.yml'), `- id: llm-retry\n  disabled: ${native}\n`.repeat(nativeRows) + `- insert:\n${rows.join('')}`);
  };
  for (const profile of profiles) await writeProfile(profile);
  return { base, repoRoot, runtimeRoot, dshHome, writeProfile, put };
}
async function tree(root) {
  const out = {};
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name), info = await stat(path);
    out[path] = [info.mtimeMs, sha(await readFile(path))];
  }
  return out;
}
const byId = report => Object.fromEntries(report.checks.map(check => [check.id, check]));

test('healthy install: bridge, reviewed artifacts and every managed profile on the contract-3 pair', async () => {
  const f = await fixture(), before = await tree(f.base);
  const report = await doctor(f);
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(check => !check.ok)));
  assert.equal(report.writes, 0); assert.equal(report.sessionsRead, false); assert.equal(report.credentialsRead, false);
  assert.deepEqual(Object.keys(byId(report)).sort(), ['artifact:alex-agent-self-heal', 'artifact:alex-llm-resilience', 'profile:dsh-tui', 'profile:web', 'sdk-persistence-bridge']);
  assert.deepEqual(await tree(f.base), before, 'the doctor never writes');
  const cli = await exec(process.execPath, [join(here, 'doctor.mjs'), '--repo', f.repoRoot, '--runtime', f.runtimeRoot, '--dsh-home', f.dshHome]);
  assert.equal(JSON.parse(cli.stdout).ok, true);
});

test('an SDK without the agent/self-heal persistence bridge is reported', async () => {
  const f = await fixture({ bridge: false });
  const check = byId(await doctor(f))['sdk-persistence-bridge'];
  assert.equal(check.ok, false); assert.equal(check.reason, 'bridge-absent-or-incomplete');
  assert.equal(check.details.validatorAcceptsOwnerAudit, false);
  await assert.rejects(exec(process.execPath, [join(here, 'doctor.mjs'), '--repo', f.repoRoot, '--runtime', f.runtimeRoot, '--dsh-home', f.dshHome]), error => error.code === 1);
});

test('outdated, mismatched and foreign profile rows are distinguished', async () => {
  const f = await fixture();
  await f.writeProfile('web', { controller: 'llm-resilience/lib/index-v5-unified.mjs', owner: 'agent-self-heal/lib/index-v6-unified.mjs' });
  await f.writeProfile('dsh-tui', { controller: 'llm-resilience/lib/index-v5-unified.mjs' });
  let checks = byId(await doctor(f));
  assert.equal(checks['profile:web'].reason, 'outdated-pair');
  assert.equal(checks['profile:dsh-tui'].reason, 'mismatched-owner-controller-pair');
  assert.deepEqual(checks['profile:dsh-tui'].rows['alex-llm-resilience'].status, 'outdated');
  await f.writeProfile('web', { owner: 'other/unknown.mjs' });
  await f.writeProfile('dsh-tui', { native: 'false' });
  checks = byId(await doctor(f));
  assert.equal(checks['profile:web'].rows['alex-agent-self-heal'].status, 'foreign');
  assert.equal(checks['profile:dsh-tui'].reason, 'native-retry-not-disabled');
});

test('a tampered reviewed artifact or a missing profile fails the report', async () => {
  const f = await fixture();
  await f.put(join(f.repoRoot, 'plugins', RESILIENCE_MODULES['alex-agent-self-heal']), '// tampered\n');
  await f.put(join(f.dshHome, 'profiles/web/cordis.patch.yml.moved'), '');
  const report = await doctor(f);
  assert.equal(report.ok, false);
  assert.equal(byId(report)['artifact:alex-agent-self-heal'].reason, 'artifact-differs-from-record');
  const g = await fixture();
  const { rename } = await import('node:fs/promises');
  await rename(join(g.dshHome, 'profiles/web/cordis.patch.yml'), join(g.base, 'web-profile-moved-aside.yml'));
  assert.equal(byId(await doctor(g))['profile:web'].reason, 'profile-missing');
});

test('false negatives closed: owner before controller, missing bridge, duplicate native retry; finite caps only warn', async () => {
  const f = await fixture();
  await f.writeProfile('web', { ownerFirst: true });
  await f.writeProfile('dsh-tui', { bridge: false, nativeRows: 2 });
  let checks = byId(await doctor(f));
  assert.deepEqual(checks['profile:web'].problems, ['owner-before-controller']);
  assert.deepEqual(checks['profile:dsh-tui'].problems, ['missing-typed-failure-bridge', 'duplicate-native-retry']);
  await f.writeProfile('web', { controllerConfig: '{ policy: { maxRetries: 10 }, providers: { local: { maxRetries: 0 } }, selfHeal: { maxCycles: 4 } }' });
  await f.writeProfile('dsh-tui');
  const report = await doctor(f); checks = byId(report);
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(check => !check.ok)));
  assert.deepEqual(checks['profile:web'].warnings, ['explicit-finite-cap:alex-llm-resilience.policy.maxRetries=10', 'explicit-opt-out:alex-llm-resilience.providers.local.maxRetries=0', 'explicit-finite-cap:alex-llm-resilience.selfHeal.maxCycles=4']);
  assert.equal(report.warnings.length, 3);
});
