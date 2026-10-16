import test from 'node:test';
import assert from 'node:assert/strict';
import { profilePackage, assertPublicSeed, publicProfilePatch } from './profile.mjs';
import { migrateResilienceProfile } from '../resilience/profile.mjs';
import { DEFAULT_POLICY } from '../../plugins/llm-resilience/policy.mjs';

test('profile manifest uses ordered base and TUI bundles without provider secrets', () => {
  const pkg = profilePackage();
  assert.deepEqual(pkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui']);
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-base'], '0.2.0-rc.2');
  assertPublicSeed(pkg);
});

test('nested credential/application/account fields are refused by public seed guard', () => {
  for (const key of ['apiKey', 'refreshToken', 'clientSecret', 'credentialsFile', 'accountId']) {
    assert.throws(() => assertPublicSeed({ config: { [key]: 'fixture' } }), /Private configuration key/);
  }
  assertPublicSeed({ retryPolicies: { 'openai-codex': { maxRetries: 9 } }, lang: 'en' });
});

test('preset wrappers preserve public filtered YAML via include and leave minimal unchanged', () => {
  const patch = publicProfilePatch('- id: plan-mode\n  disabled: true\n- id: session-title-llm\n  disabled: true\n', [
    { id: 'standard', order: 1, content: 'public !!js expression' },
    { id: 'ptc', order: 2, content: 'public !!js expression' },
    { id: 'cordis', order: 3, content: 'public !!js expression' },
    { id: 'minimal', untouched: true },
  ], '/home/alex/.dsh/profiles/dsh-tui');
  assert.doesNotMatch(patch, /dsh-tui-auth|retryPolicies|maxRetries|maxDelayMs/);
  const candidate = migrateResilienceProfile(patch, { repoRoot: '/fixture/repo', profile: 'dsh-tui' }).candidate;
  for (const id of ['alex-llm-resilience', 'alex-codex-transient-close', 'alex-agent-self-heal']) assert.equal(candidate.split('id: ' + id).length, 2);
  assert.match(candidate, /id: llm-retry\n  disabled: true/);
  assert.match(candidate, /agent-self-heal\/lib\/index-v6-unified\.mjs/);
  assert.match(candidate, /llm-resilience\/lib\/index-v5-unified\.mjs/);
  assert.doesNotMatch(candidate, /retryPolicies|maxRetries|maxDelayMs|antigravity-quota-retry/);
  assert.equal(DEFAULT_POLICY.maxRetries, 10);
  assert.equal(DEFAULT_POLICY.initialDelayMs, 7031.25);
  assert.equal(DEFAULT_POLICY.maxDelayMs, 3600000);
  assert.equal(DEFAULT_POLICY.jitterRatio, 0);
  assert.match(patch, /presets\/standard.yml/);
  assert.doesNotMatch(patch, /preset-minimal|credential|secret|account|public !!js/);
  assert.match(patch, /session-title-llm\n  disabled: true/);
});
