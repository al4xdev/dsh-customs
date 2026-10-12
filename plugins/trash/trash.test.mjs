import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkedSource, requireFullAccess } from './index.mjs';

const cwd = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const home = homedir();
const context = policy => ({ sandboxPolicy: { resolve: () => policy } });

for (const mode of ['workspace-write', 'danger-full-access']) {
  test(`policy accepts ${mode} without changing the resolved policy`, () => {
    const policy = { mode, workspaceRoot: cwd };
    assert.equal(requireFullAccess(context(policy)), policy);
  });
}

test('read-only policy denies removal', () => {
  assert.throws(() => requireFullAccess(context({ mode: 'read-only' })),
    /Removal is not allowed under read-only mode/);
});

test('policy resolution uses the executing agent session, or an empty fallback', () => {
  const session = {}, calls = [], policy = { mode: 'workspace-write' };
  const ctx = { sandboxPolicy: { resolve(options) { calls.push(options); return policy; } } };
  requireFullAccess(ctx, { agent: { session } });
  requireFullAccess(ctx);
  assert.equal(calls[0].session, session);
  assert.deepEqual(calls[1], {});
});

test('invalid inputs are rejected with an unmoved failure record', async () => {
  for (const input of [undefined, null, 42, [], '', ' \t\n ', 'file\0name']) {
    await assert.rejects(checkedSource(input, cwd), error => {
      assert.match(error.message, /Source path must be a non-empty explicit path/);
      assert.deepEqual(error.trash, {
        original: null, recovery: null, manifest: null, status: 'failed', copy_fallback: false,
      });
      return true;
    });
  }
});

async function assertProtected(path) {
  await assert.rejects(checkedSource(path, cwd), error => {
    assert.match(error.message, /Protected broad target:/);
    assert.equal(error.trash.status, 'failed');
    assert.equal(error.trash.recovery, null);
    assert.equal(error.trash.manifest, null);
    assert.equal(error.trash.copy_fallback, false);
    return true;
  });
}

test('filesystem, home and broad user paths are protected', async () => {
  for (const path of ['/', '/home', home, join(home, 'Documents'), join(home, 'git', 'my')]) {
    await assertProtected(path);
  }
});

test('the working directory and its ancestors are protected', async () => {
  await assertProtected('.');
  await assertProtected('..');
  await assertProtected(dirname(cwd));
});

test('credential trees remain protected even for paths that need not exist', async () => {
  // These are lexical guards: no credential file is opened or mutated.
  for (const path of [join(home, '.ssh', 'contract-test-key'),
    join(home, '.gnupg', 'contract-test-key'), join(home, '.dsh', 'dsh-auth', 'contract-test-token')]) {
    await assertProtected(path);
  }
});
