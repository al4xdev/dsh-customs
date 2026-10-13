import test from 'node:test';
import assert from 'node:assert/strict';
import { profilePackage, assertPublicSeed, publicProfilePatch } from './profile.mjs';

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
  assert.match(patch, /dsh-tui-auth/);
  assert.match(patch, /maxRetries: 9/);
  assert.match(patch, /maxDelayMs: 1200000/);
  assert.match(patch, /presets\/standard.yml/);
  assert.doesNotMatch(patch, /preset-minimal|credential|secret|account|public !!js/);
  assert.match(patch, /session-title-llm\n  disabled: true/);
});
