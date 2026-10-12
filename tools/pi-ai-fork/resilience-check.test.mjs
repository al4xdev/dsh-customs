import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSnapshotUnchanged, decideHelperReanchoring, parseResilienceArgs } from './resilience-check.mjs';

const version = '0.87.1+alex.codex-default.206545bfd51e';

test('offline defaults require the actual composed profile without changing provider policy', () => {
  assert.deepEqual(parseResilienceArgs([]), {
    officialRoot: undefined, profileDir: undefined, expectedVersion: undefined,
    explicitOfficialRoot: false, allowUnconfiguredProfile: false, summary: false,
  });
});

test('explicit host, profile, pinned version and summary are parsed independently', () => {
  assert.deepEqual(parseResilienceArgs(['--official-root', '/fixture/node_modules', '--profile-dir=/fixture/profile',
    '--expected-version', version, '--summary']), {
    officialRoot: '/fixture/node_modules', profileDir: '/fixture/profile', expectedVersion: version,
    explicitOfficialRoot: true, allowUnconfiguredProfile: false, summary: true,
  });
  assert.equal(parseResilienceArgs(['--allow-unconfigured-profile']).allowUnconfiguredProfile, true);
});

test('unknown, live and malformed options fail before workers or profile reads', () => {
  for (const args of [['--live'], ['--unknown'], ['positional'], ['--expected-version']]) {
    assert.throws(() => parseResilienceArgs(args));
  }
});

test('expected versions must match the whole pinned artifact identifier', () => {
  for (const invalid of ['', '0.87.1', `${version}\n`, `${version}\r`, `${version}x`, version.toUpperCase()]) {
    assert.throws(() => parseResilienceArgs(['--expected-version', invalid]), { code: 'EXPECTED_VERSION_INVALID' });
  }
  assert.equal(parseResilienceArgs(['--expected-version', '0.87.1+alex.codex-default.7f8948d3c423']).expectedVersion,
    '0.87.1+alex.codex-default.7f8948d3c423');
});

test('default helper mismatches fail closed rather than manufacturing host identity', () => {
  assert.equal(decideHelperReanchoring(true), false);
  assert.equal(decideHelperReanchoring(true, true), false);
  assert.throws(() => decideHelperReanchoring(false), { code: 'HELPER_HOST_MISMATCH' });
  assert.throws(() => decideHelperReanchoring(false, false), { code: 'HELPER_HOST_MISMATCH' });
  assert.throws(() => decideHelperReanchoring(false, 'true'), { code: 'HELPER_HOST_MISMATCH' });
});

test('only an explicitly selected alternate host can request reported reanchoring', () => {
  const defaults = parseResilienceArgs([]);
  assert.throws(() => decideHelperReanchoring(false, defaults.explicitOfficialRoot), { code: 'HELPER_HOST_MISMATCH' });
  const alternate = parseResilienceArgs(['--official-root=/fixture/node_modules']);
  assert.equal(decideHelperReanchoring(false, alternate.explicitOfficialRoot), true);
});

test('each simulated profile or final plugin mutation invalidates the snapshot', () => {
  const before = { files: { profilePatch: 'patch-a', profilePackage: 'package-a', profileMain: 'main-a' },
    selectionSha256: 'selected-enabled-name-config-a', pluginSourceSha256: 'plugin-a' };
  assert.doesNotThrow(() => assertSnapshotUnchanged(before, structuredClone(before)));
  for (const key of Object.keys(before.files)) {
    const after = structuredClone(before);
    after.files[key] = 'changed';
    assert.throws(() => assertSnapshotUnchanged(before, after), { code: 'SNAPSHOT_CHANGED' });
  }
  for (const key of ['selectionSha256', 'pluginSourceSha256']) {
    const after = structuredClone(before);
    after[key] = 'changed';
    assert.throws(() => assertSnapshotUnchanged(before, after), { code: 'SNAPSHOT_CHANGED' });
  }
});

test('selected row enabled, name or config changes cannot retain acceptance', () => {
  const before = { selected: [{ enabled: true, name: '/fixture/plugin.mjs', config: { mode: 'fixture' } }] };
  for (const mutate of [row => { row.enabled = false; }, row => { row.name = '/fixture/other.mjs'; },
    row => { row.config.mode = 'changed'; }]) {
    const after = structuredClone(before);
    mutate(after.selected[0]);
    assert.throws(() => assertSnapshotUnchanged(before, after), { code: 'SNAPSHOT_CHANGED' });
  }
  assert.throws(() => assertSnapshotUnchanged(before, { selected: [] }), { code: 'SNAPSHOT_CHANGED' });
});
