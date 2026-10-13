import assert from 'node:assert/strict';
import { mkdir, lstat, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { filterPreset } from '../task10-profile/promotion.mjs';
import { longCodexRetryConfig } from '../pi-ai-fork/long-retry-policy.mjs';

export function profilePackage() {
  return { name: 'dsh-profile-dsh-tui', private: true, dependencies: { '@deepseek-ai/dsh-base': '0.2.0-rc.2', '@deepseek-harness-tui/dsh-tui': '0.14.0', yaml: '2.9.1' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui'] } } };
}

/** Seeds contain public policy only; credential references/storage stay external. */
export function assertPublicSeed(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert(!/(?:password|secret|token|api.?key|credentials?|client.?id|account)/i.test(key), `Private configuration key is not allowed in seed: ${key}`);
    assertPublicSeed(child);
  }
}

export function publicProfilePatch(base, presets, profile) {
  let patch = base.trimEnd() + '\n- id: dsh-tui\n  config:\n    lang: en\n';
  patch += '- id: dsh-tui-auth\n  config:\n    retryPolicies:\n      openai-codex:\n';
  const policy = longCodexRetryConfig;
  patch += `        mode: ${policy.mode}\n        maxRetries: ${policy.maxRetries}\n        backoff:\n          initialDelayMs: ${policy.backoff.initialDelayMs}\n          maxDelayMs: ${policy.backoff.maxDelayMs}\n          jitterRatio: ${policy.backoff.jitterRatio}\n`;
  patch += '- insert:\n';
  for (const preset of presets.filter(item => !item.untouched)) {
    patch += `    - id: preset-${preset.id}\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: ${preset.id}\n        order: ${preset.order}\n        plugins:\n          - id: ${preset.id}-managed-plugins\n            name: '@deepseek-ai/cordis-plugin-include'\n            config:\n              path: ${JSON.stringify(join(profile, 'presets', preset.id + '.yml'))}\n`;
  }
  return patch;
}

/** Fresh composition only. Never reads an existing user profile or home patch. */
export async function seedProfile({ home, installRoot, repo }, { run } = {}) {
  for (const path of [home, installRoot, repo]) assert.equal(path, resolve(path), 'Absolute normalized profile input required');
  assert.equal(await realpath(installRoot), installRoot);
  const dshHome = join(home, '.dsh');
  const existing = await lstat(dshHome).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) assert(existing.isDirectory() && !existing.isSymbolicLink() && (await readdir(dshHome)).length === 0, 'DSH home must be absent or empty');
  assert.equal(typeof run, 'function', 'Explicit activation runner required');
  const require = createRequire(join(installRoot, 'package.json'));
  const YAML = require('yaml');
  const presets = [];
  for (const id of ['standard', 'ptc', 'cordis', 'minimal']) {
    const file = require.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`);
    presets.push(filterPreset(await readFile(file, 'utf8'), id, YAML));
  }
  const profile = join(dshHome, 'profiles/dsh-tui');
  const pkg = profilePackage();
  assertPublicSeed(pkg);
  const base = await readFile(join(repo, 'tools/task10-profile/cordis.patch.yml'), 'utf8');
  const patch = publicProfilePatch(base, presets, profile);
  const parsed = YAML.parseDocument(patch);
  assert.equal(parsed.errors.length, 0, 'Public profile patch must parse');
  assertPublicSeed(parsed.toJS());
  await mkdir(join(profile, 'presets'), { recursive: true, mode: 0o700 });
  const exclusive = (path, bytes) => writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  await exclusive(join(profile, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  await exclusive(join(profile, 'cordis.yml'), '[]\n');
  await exclusive(join(profile, 'cordis.patch.yml'), patch);
  for (const preset of presets.filter(item => !item.untouched)) await exclusive(join(profile, 'presets', preset.id + '.yml'), preset.content);
  await symlink(join(installRoot, 'node_modules'), join(dshHome, 'profiles/node_modules'), 'dir');
  await symlink(join(installRoot, 'node_modules'), join(profile, 'node_modules'), 'dir');
  await run(process.execPath, [join(repo, 'tools/activate.mjs'), '--write', '--profile', 'dsh-tui', '--root', repo], repo);
  await run(process.execPath, [join(repo, 'tools/activate.mjs'), '--check', '--profile', 'dsh-tui', '--root', repo], repo);
  const finalManifest = JSON.parse(await readFile(join(repo, 'plugins/activation.json'), 'utf8'));
  const selfheal = finalManifest.plugins.find(plugin => plugin.id === 'alex-agent-self-heal');
  assert.equal(selfheal?.module, 'agent-self-heal/lib/index-v2-persistence.mjs', 'Required persistence self-heal activation missing');
  assert.equal(await realpath(join(profile, 'node_modules')), await realpath(join(installRoot, 'node_modules')));
  return { profile, bundles: pkg.dsh.profile.bundles, publicRetryPolicy: longCodexRetryConfig, planning: 'Native root/preset planning removed; minimal unchanged', sharedPhysicalModules: true, credentialsSeeded: false, booted: false };
}
