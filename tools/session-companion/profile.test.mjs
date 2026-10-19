import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { YAML, profileFiles, serviceFile } from './profile.mjs';
import { appliesToProfile } from '../activation-selection.mjs';
import { COMPANION_WORKSPACE_ROOT } from '../../plugins/companion-workspace/controller-policy.mjs';
import { WORKSPACE_ROOT } from '../../plugins/companion-workspace/guard-policy.mjs';

test('companion declares one workspace preset with native files and always-asked oneshot Bash', () => {
  const files = profileFiles('/tmp/repo');
  const patch = YAML.parse(files['cordis.patch.yml']);
  const preset = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-companion');
  assert.equal(preset.config.id, 'companion');
  assert.deepEqual(preset.config.plugins.find(row => row.id === 'skill-filesystem').config,
    { customSkillDirs: [join(COMPANION_WORKSPACE_ROOT, '.agents/skills')] });
  assert.equal(patch.some(row => ['skill-filesystem', 'tool-skill'].includes(row.id)), false);
  assert.deepEqual(preset.config.plugins.filter(row => row.id !== 'compaction').map(row => row.name), [
    '/tmp/repo/plugins/session/index.mjs', '/tmp/repo/plugins/companion-workspace/index.mjs',
    '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-agent-instructions', '/tmp/repo/plugins/list/index.mjs', '@deepseek-ai/dsh-tool-bash'
  ]);
  assert.equal(preset.config.plugins.some(row => row.id === 'persona' || row.name === '@deepseek-ai/dsh-persona'), false);
  assert.deepEqual(preset.config.plugins.find(row => row.id === 'agent-instructions').config, { maxBytes: 65536, dshHome: join(homedir(), '.dsh/Companion') });
  assert.equal(preset.config.plugins.find(row => row.id === 'companion-session').config.profile, 'companion');
  assert.equal(preset.config.plugins.find(row => row.id === 'companion-workspace').config.profile, 'companion');
  assert.deepEqual(preset.config.plugins.find(row => row.id === 'companion-bash').config, { enableRunInBackground: false, promoteOnTimeout: false });
  assert.deepEqual(patch.find(row => row.id === 'permission').config, { presets: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' }
  }, defaultPreset: 'workspace-write' });
  assert.equal(WORKSPACE_ROOT, COMPANION_WORKSPACE_ROOT);
  assert.deepEqual(patch.find(row => row.id === 'sandbox-policy').config, { mode: 'workspace-write', workspaceRoot: COMPANION_WORKSPACE_ROOT });
  assert.deepEqual(patch.find(row => row.id === 'session-controller'), { id: 'session-controller', disabled: true });
  assert.deepEqual(patch.flatMap(row => row.insert ?? []).find(row => row.id === 'companion-session-controller'), { id: 'companion-session-controller', name: '/tmp/repo/plugins/companion-workspace/session-controller.mjs' });
  for (const id of ['tool-fs', 'tool-bash']) assert.equal(patch.find(row => row.id === id).disabled, true);
  for (const id of ['standard', 'minimal', 'ptc', 'cordis']) assert.equal(patch.find(row => row.id === `preset-${id}`).disabled, true);
  assert.equal(patch.find(row => row.id === 'approval').config.policy, 'ask');
  assert.equal(patch.find(row => row.id === 'web-runtime').config.printUrl, false);
  assert.equal(JSON.parse(files['package.json']).dsh.profile.bundles.length, 2);
});

test('native catalog is a host-only companion contribution, never a model tool or bridge', () => {
  const patch = YAML.parse(profileFiles('/tmp/repo')['cordis.patch.yml']);
  const inserted = patch.flatMap(row => row.insert ?? []);
  const catalog = inserted.find(row => row.id === 'companion-catalog-api');
  assert.equal(catalog.name, '/tmp/repo/plugins/companion-api/index.mjs');
  assert.deepEqual(catalog.inject, ['typert', 'sessionPersistence']);
  assert.equal(inserted.filter(row => row.id === 'companion-catalog-api').length, 1);
  const preset = inserted.find(row => row.id === 'preset-companion');
  assert.equal(preset.config.plugins.some(row => row.name.includes('companion-api')), false);
  assert.equal(inserted.some(row => row.name?.endsWith('/session/bridge.mjs')), false);
});

test('shared JSONL source keeps its verified Zstd encoding and a complete root config', () => {
  const patch = YAML.parse(profileFiles('/tmp/repo')['cordis.patch.yml']);
  assert.deepEqual(patch.find(row => row.id === 'session-persistence-jsonl').config, {
    root: join(homedir(), '.dsh/sessions'), compression: 'zstd'
  });
  assert.equal(patch.filter(row => row.id === 'session-persistence-jsonl').length, 1);
});

test('existing general machine plugins cannot leak into companion via activation', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../plugins/activation.json', import.meta.url), 'utf8'));
  assert.ok(manifest.profiles.includes('companion'));
  assert.deepEqual(manifest.isolatedProfiles, ['companion']);
  assert.equal(appliesToProfile({ module: 'future-dangerous-plugin/index.mjs' }, 'companion', manifest), false);
  assert.equal(appliesToProfile({ module: 'future-dangerous-plugin/index.mjs' }, 'web', manifest), true);
  assert.equal(appliesToProfile({ module: 'explicit/index.mjs', profiles: ['companion'] }, 'companion', manifest), true);
  assert.equal(appliesToProfile({ overlay: false }, null, manifest), false);
  // Keep an explicit allowlist: pre-existing resilience hooks and the owner's
  // new all-profile research tool do not enable implicit future plugin leakage.
  const companionPlugins = manifest.plugins.filter(row => !row.profiles || row.profiles.includes('companion'));
  assert.deepEqual(companionPlugins.map(row => row.id).sort(), [
    'alex-agent-self-heal', 'alex-codex-transient-close', 'alex-llm-resilience', 'alex-music', 'alex-research', 'alex-wait',
  ]);
  assert.ok(companionPlugins.every(row => row.overlay === false));
  const generated = YAML.parse(profileFiles('/tmp/repo')['cordis.patch.yml']);
  assert.equal(generated.flatMap(row => row.insert ?? []).filter(row => row.id === 'alex-research').length, 1);
  const bridge = manifest.plugins.find(row => row.id === 'alex-session-bridge');
  assert.deepEqual(bridge.profiles, ['dsh-tui']);
  assert.equal(bridge.overlay, false);
});

test('service is separate from existing web and never prints startup tokens', () => {
  const unit = serviceFile({ cliPath: '/tmp/bin.js', repoRoot: '/tmp/repo' });
  assert.match(unit, /--profile companion --port 3081/);
  assert.match(unit, /UMask=0077/);
  assert.doesNotMatch(unit, /0\.0\.0\.0|3080|Funnel/);
  assert.throws(() => serviceFile({ cliPath: '/tmp/bin.js\nExecStart=bad', repoRoot: '/tmp/repo' }));
});

test('guarded native transport is opt-in and preserves every existing profile row', () => {
  const original = profileFiles('/tmp/repo');
  assert.deepEqual(profileFiles('/tmp/repo', { guardedTransport: false }), original);
  const base = YAML.parse(original['cordis.patch.yml']);
  assert.equal(base.some(row => row.id === 'webserver' || row.id === 'connection'), false);
  const prepared = profileFiles('/tmp/repo', { guardedTransport: true });
  assert.equal(prepared['package.json'], original['package.json']);
  assert.equal(prepared['cordis.yml'], original['cordis.yml']);
  const guarded = YAML.parse(prepared['cordis.patch.yml']);
  assert.deepEqual(guarded.filter(row => !['webserver', 'connection'].includes(row.id)), base);
  assert.deepEqual(guarded.find(row => row.id === 'webserver'), {
    id: 'webserver', name: '/tmp/repo/plugins/companion-transport/guarded-webserver.mjs', inject: ['webStartup'],
    config: { host: '127.0.0.1', port: 3081, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 }
  });
  assert.deepEqual(guarded.find(row => row.id === 'connection'), {
    id: 'connection', inject: ['webRuntime'],
    config: { trustedHosts: ['dsh.tail37b3d7.ts.net:8443'] }
  });
});

test('actual SDK patch composition disables stock controller and mounts a distinct subclass row', async () => {
  const { resolveHost } = await import('../../plugins/common.mjs');
  const { composeEntries } = await import(resolveHost('@deepseek-ai/dsh-app-boot'));
  const stock = [{ insert: [{ id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller' }] }];
  const old = composeEntries([stock, [{ id: 'session-controller', name: '/tmp/repo/plugins/companion-workspace/session-controller.mjs' }]]);
  // A name mismatch skips a patch rather than replacing its module.
  assert.equal(old[0].name, '@deepseek-ai/dsh-api-session-controller');
  const effective = composeEntries([stock, YAML.parse(profileFiles('/tmp/repo')['cordis.patch.yml'])]);
  assert.equal(effective.find(row => row.id === 'session-controller').disabled, true);
  assert.equal(effective.find(row => row.id === 'companion-session-controller').name, '/tmp/repo/plugins/companion-workspace/session-controller.mjs');
});

test('guarded transport refuses truthy coercions before generating a profile', () => {
  for (const guardedTransport of ['false', 'true', 1, null, []]) {
    assert.throws(() => profileFiles('/tmp/repo', { guardedTransport }), TypeError);
  }
});
