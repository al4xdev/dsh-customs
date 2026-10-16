import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './test-fixture.mjs';
import { MAX_BYTES, PrivateStore } from './store.mjs';

test('private0700 directory and0600 state, exclusive writer, stable owner and safe reopen', () => {
  const directory = root(), s = new PrivateStore(directory);
  try {
    assert.equal(statSync(s.directory).mode & 0o777, 0o700); assert.equal(statSync(s.path).mode & 0o777, 0o600);
    assert.equal(statSync(s.lock).mode & 0o777, 0o600);
    assert.throws(() => new PrivateStore(directory), /EEXIST/);
    const owner = s.read().ownerScopeId; s.close();
    const reopened = new PrivateStore(directory);
    try { assert.equal(reopened.read().ownerScopeId, owner); } finally { reopened.close(); }
  } finally { s.close(); }
});

test('corrupt, foreign-profile, oversized and permissive state all fail closed without replacement', () => {
  for (const mode of ['json', 'profile', 'oversize', 'permissions']) {
    const directory = root(), s = new PrivateStore(directory), path = s.path, state = s.read(); s.close();
    if (mode === 'json') writeFileSync(path, '{unparseable');
    if (mode === 'profile') writeFileSync(path, JSON.stringify({ ...state, profile: 'foreign' }));
    if (mode === 'oversize') writeFileSync(path, 'x'.repeat(MAX_BYTES + 1));
    if (mode === 'permissions') chmodSync(path, 0o644);
    assert.throws(() => new PrivateStore(directory));
    assert.equal(existsSync(join(directory, 'companion-push/writer.lock')), false);
  }
});

test('symlink directory/state and unsafe parent path are refused before following targets', () => {
  const directory = root(), target = root();
  symlinkSync(target, join(directory, 'companion-push'));
  assert.throws(() => new PrivateStore(directory));
  const other = root(), storeDirectory = join(other, 'companion-push'); mkdirSync(storeDirectory, { mode: 0o700 });
  const foreign = join(target, 'not-credentials.json'); writeFileSync(foreign, 'OWN SYNTHETIC FILE ONLY', { mode: 0o600 });
  symlinkSync(foreign, join(storeDirectory, 'state-v1.json'));
  assert.throws(() => new PrivateStore(other));
  const alias = join(root(), 'profile-alias'); symlinkSync(target, alias);
  assert.throws(() => new PrivateStore(alias));
});

test('crash-held writer lock requires manual stopped-profile review, never automatic reclaim', () => {
  const directory = root(), folder = join(directory, 'companion-push'); mkdirSync(folder, { mode: 0o700 });
  writeFileSync(join(folder, 'writer.lock'), 'OWN SYNTHETIC CRASH', { mode: 0o600 });
  assert.throws(() => new PrivateStore(directory), /EEXIST/);
  assert.equal(existsSync(join(folder, 'state-v1.json')), false);
});

test('invalid persistent revisions and targets cannot become delivery permission', () => {
  const directory = root(), s = new PrivateStore(directory);
  try {
    const original = s.read(); const invalid = structuredClone(original); invalid.events.push({ payload: { objective: 'not a completion' }, targets: [] });
    assert.throws(() => s.save(invalid)); assert.deepEqual(s.read(), original);
    assert.throws(() => s.change(state => { state.ownerScopeId = 'not-a-digest'; })); assert.deepEqual(s.read(), original);
  } finally { s.close(); }
});
