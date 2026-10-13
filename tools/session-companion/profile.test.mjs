import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { YAML, profileFiles, serviceFile } from './profile.mjs';
import { appliesToProfile } from '../activation-selection.mjs';

test('companion declares one restricted preset with session as the only tool plugin', () => {
  const files = profileFiles('/tmp/repo');
  const patch = YAML.parse(files['cordis.patch.yml']);
  const preset = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-companion');
  assert.equal(preset.config.id, 'companion');
  assert.deepEqual(preset.config.plugins.filter(row => row.id !== 'persona' && row.id !== 'compaction').map(row => row.name), ['/tmp/repo/plugins/session/index.mjs']);
  assert.equal(preset.config.plugins.find(row => row.id === 'companion-session').config.profile, 'companion');
  for (const id of ['standard', 'minimal', 'ptc', 'cordis']) assert.equal(patch.find(row => row.id === `preset-${id}`).disabled, true);
  assert.equal(patch.find(row => row.id === 'approval').config.policy, 'ask');
  assert.equal(patch.find(row => row.id === 'web-runtime').config.printUrl, false);
  assert.equal(JSON.parse(files['package.json']).dsh.profile.bundles.length, 2);
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
  assert.deepEqual(manifest.plugins.filter(row => !row.profiles || row.profiles.includes('companion')), []);
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
