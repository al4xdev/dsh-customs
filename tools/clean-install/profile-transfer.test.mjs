import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, lstat, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { exportProfile, sanitizeYaml, main } from './profile-transfer.mjs';
const YAML = createRequire(join(homedir(), '.local/share/dsh-cli/package.json'))('yaml');
const options = { sourceProfile: '/home/alex/.dsh/profiles/dsh-tui', targetProfile: '/home/alex/.dsh/profiles/host-test', repoRoot: '/home/alex/git/my/dsh-customs', pathRemaps: { '/home/alex/git/my/dsh-customs/plugins/dsh-antigravity': '/home/alex/.local/share/dsh-build/sources/antigravity' } };

test('preserves ordered provider/model IDs policies JS tags and include remapping without evaluation', () => {
  const text = `- id: llm-retry\n  disabled: true\n- id: llm-pi-ai-antigravity\n  config:\n    quotaResetRetry:\n      enabled: true\n      maxWaitMs: 86400000\n    maxTokens: 8192\n    provider: gemini\n    model: gemini-3-pro\n- id: auth\n  config:\n    retryPolicies:\n      openai-codex:\n        maxRetries: 9\n        backoff:\n          maxDelayMs: 1200000\n- id: persona\n  config:\n    prefix: !js '(agent) => agent.id + " static"'\n    environmentReference: !js process.env.PUBLIC_MODE\n- id: include\n  config:\n    path: /home/alex/.dsh/profiles/dsh-tui/standard-managed-plugins.yml\n- id: antigravity-tui-login\n  name: /home/alex/git/my/dsh-customs/plugins/dsh-antigravity/tui-login.mjs\n`;
  const result = sanitizeYaml(text, options);
  assert.equal(result.redactions.length, 0);
  assert.equal(result.jsTags.length, 2);
  assert(result.content.includes('!js'));
  assert(result.content.includes('/profiles/host-test/standard-managed-plugins.yml'));
  assert(result.content.includes('/dsh-build/sources/antigravity/tui-login.mjs'));
  const rows = YAML.parseDocument(result.content, { logLevel: 'silent' }).toJS();
  assert.deepEqual(rows.map(row => row.id), ['llm-retry', 'llm-pi-ai-antigravity', 'auth', 'persona', 'include', 'antigravity-tui-login']);
  assert.equal(rows[1].config.maxTokens, 8192);
  assert.equal(rows[1].config.quotaResetRetry.maxWaitMs, 86400000);
  assert.equal(rows[2].config.retryPolicies['openai-codex'].backoff.maxDelayMs, 1200000);
});
test('removes nested secrets literals comments storage references and private/custom endpoints', () => {
  const token = 'sk-' + 'a'.repeat(30);
  const result = sanitizeYaml(`- id: public-provider # fixture-private-comment\n  config:\n    apiKey: fixture-key\n    access_token: fixture-refresh\n    note: '${token}'\n    maxTokens: 999\n    publicBaseUrl: https://api.openai.com/v1\n    customEndpoint: https://personal.example.org/v1\n    privateEndpoint: http://192.168.1.2/service\n    userUrl: https://user:pass@api.openai.com/v1\n    queryUrl: https://api.openai.com/v1?api_key=fixture-query\n    credentialsFile: /home/alex/.dsh/dsh-auth/credentials.json\n    storage: /home/alex/.codex/auth.json\n`, options);
  assert.equal(result.redactions.length, 9);
  assert(!result.content.includes('fixture-'));
  assert(!JSON.stringify(result.redactions).includes(token));
  assert(result.content.includes('maxTokens: 999'));
  assert(result.content.includes('https://api.openai.com/v1'));
});
test('unsafe JS never runs and unsupported paths/tags refuse rather than leaking', () => {
  const result = sanitizeYaml(`- id: fixture\n  config:\n    steal: !js 'process.env.PRIVATE_TOKEN + require("fs").readFileSync("credentials.json")'\n    resource: !js 'globalThis.fetch("https://api.openai.com")'\n    pure: !js '(agent) => agent.model'\n    otherHome: /home/another/private-file\n    unsupported: !something-public fixture\n`, options);
  assert.equal(result.redactions.length, 4);
  assert.equal(result.jsTags.length, 1);
  assert(!result.content.includes('require'));
  assert(!result.content.includes('another'));
  assert.throws(() => sanitizeYaml('a: &one fixture\nb: *one\n', options), /aliases refused/);
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-profile-transfer-'));
  t.after(async () => { assert.equal(await realpath(root), root); await rm(root, { recursive: true }); });
  const repoRoot = join(root, 'repo'), sourceProfile = join(root, 'source'), targetProfile = join(root, 'target');
  await mkdir(join(repoRoot, '.dumps/task61'), { recursive: true }); await mkdir(sourceProfile);
  await writeFile(join(sourceProfile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-llm-pi-ai-antigravity'] } }, dependencies: { '@deepseek-ai/dsh-agent': 'file:/private/donor' }, scripts: { preinstall: 'must-not-run' }, credentials: 'must-not-copy' }));
  await writeFile(join(sourceProfile, 'cordis.yml'), '[]\n');
  await writeFile(join(sourceProfile, 'cordis.patch.yml'), '- id: llm-pi-ai-antigravity\n  config:\n    apiKey: fixture-private\n    maxTokens: 100\n');
  await writeFile(join(sourceProfile, 'standard-managed-plugins.yml'), '- id: persona\n  config:\n    prefix: !js "(agent) => agent.id"\n');
  return { repoRoot, sourceProfile, targetProfile, outputRoot: join(repoRoot, '.dumps/task61/export-root') };
}
test('exclusive local private export reads only selected configs and manifest names', async t => {
  const fixtureOptions = await fixture(t);
  await writeFile(join(fixtureOptions.sourceProfile, 'credentials.json'), 'private-canary-no-read');
  const receipt = await exportProfile(fixtureOptions);
  assert.equal(receipt.credentialsCopied, false);
  assert.equal(receipt.evaluatedJs, false);
  assert.equal(receipt.files[1].redactions.length, 1);
  assert.equal((await lstat(fixtureOptions.outputRoot)).mode & 0o777, 0o700);
  const pkg = JSON.parse(await readFile(join(fixtureOptions.outputRoot, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, { '@deepseek-ai/dsh-agent': '*' });
  assert(!JSON.stringify(pkg).includes('/private/donor'));
  assert(!JSON.stringify(pkg).includes('must-not-copy'));
  assert.equal(pkg.private, true);
  assert.equal((await lstat(join(fixtureOptions.outputRoot, 'cordis.patch.yml'))).mode & 0o777, 0o600);
  await assert.rejects(exportProfile(fixtureOptions), /must be absent/);
  assert((await readFile(join(fixtureOptions.sourceProfile, 'cordis.patch.yml'), 'utf8')).includes('fixture-private'));
});
test('confinement prevents source symlink escape and arbitrary publication destinations', async t => {
  const fixtureOptions = await fixture(t);
  await assert.rejects(exportProfile({ ...fixtureOptions, outputRoot: join(fixtureOptions.repoRoot, 'published') }), /local-only/);
  const linked = join(fixtureOptions.repoRoot, 'linked-profile');
  await symlink(fixtureOptions.sourceProfile, linked, 'dir');
  await assert.rejects(exportProfile({ ...fixtureOptions, sourceProfile: linked }), /canonical/);
});
test('noargs help and malformed explicit commands remain inert', async () => {
  assert((await main([])).help.includes('Local-only'));
  assert((await main(['--help'])).help);
  await assert.rejects(main(['--source-profile', 'relative']), /absolute/);
  await assert.rejects(main(['--unknown', '/tmp']), /Unknown/);
});
