import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packResult, sourceInventory, verifySource, preparePi, piVersion } from './pi.mjs';
import { baselineCodexHash } from '../pi-ai-fork/codex-failure-categories.mjs';

test('npm 12 map and older array pack metadata are supported', () => {
  const pack = { filename: 'pi.tgz', integrity: 'sha512-fixture' };
  assert.deepEqual(packResult(JSON.stringify([pack]), 'pi'), pack);
  assert.deepEqual(packResult(JSON.stringify({ pi: pack }), 'pi'), pack);
  assert.throws(() => packResult('{}', 'pi'));
  assert.throws(() => packResult(JSON.stringify([{ ...pack, filename: '../pi.tgz' }]), 'pi'));
});

test('public source digest is ordered and ignores generated/private/VCS trees', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-source-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'b.ts'), 'b');
  await writeFile(join(root, 'a.ts'), 'a');
  const before = await sourceInventory(root);
  for (const name of ['.git', 'node_modules', '.dumps', 'dist']) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, 'ignored'), 'ignored');
  }
  await writeFile(join(root, 'SOURCE-PROVENANCE.json'), '{}');
  assert.deepEqual(await sourceInventory(root), before);
  assert.deepEqual(before.files.map(([name]) => name), ['a.ts', 'b.ts']);
  await writeFile(join(root, 'a.ts'), 'changed');
  assert.notEqual((await sourceInventory(root)).sourceDigest, before.sourceDigest);
});

test('source symlinks refuse ambiguous vendored content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-source-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'real'), 'data');
  await symlink(join(root, 'real'), join(root, 'alias'));
  await assert.rejects(sourceInventory(root), /symlink/);
});

test('verified snapshot cannot borrow parent Git HEAD or accept unsealed source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-proof-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const api = join(root, 'packages/ai/src/api');
  await mkdir(api, { recursive: true });
  const bytes = await readFile(new URL('../../sources/pi-ai/packages/ai/src/api/openai-codex-responses.ts', import.meta.url));
  await writeFile(join(api, 'openai-codex-responses.ts'), bytes);
  const proof = { kind: 'verified-source-snapshot-not-a-git-checkout', currentGitHead: null, codexSourceHash: baselineCodexHash, historicalSourceCommit: 'f5a24c96d72732ba63aeca9a02295c320db04c2d', treeDigest: 'historical-proof' };
  await writeFile(join(root, 'SOURCE-PROVENANCE.json'), JSON.stringify(proof));
  const runner = () => { throw new Error('Snapshot must not invoke Git'); };
  await assert.rejects(verifySource(root, { runner }), /publication needs/);
  const sealed = (await sourceInventory(root)).sourceDigest;
  const result = await verifySource(root, { runner, expectedSourceDigest: sealed });
  assert.equal(result.sourceDigest, sealed);
  assert.equal(result.sourceCommit, undefined);
  await writeFile(join(root, 'SOURCE-PROVENANCE.json'), JSON.stringify({ ...proof, sourceDigest: sealed }));
  assert.equal((await verifySource(root, { runner })).sourceDigest, sealed);
  await writeFile(join(root, 'extra-source.ts'), 'foreign change');
  await assert.rejects(verifySource(root, { runner }), /inventory drift/);
});

test('preflight refuses relative inputs before spawn/build and retains intended version', async () => {
  let spawned = false;
  await assert.rejects(preparePi({ sourceRoot: 'relative', dependencyRoot: '/deps', seedNodeModules: '/seed', artifactsRoot: '/artifacts' }, { runner() { spawned = true; } }), /absolute/);
  assert.equal(spawned, false);
  assert.equal(piVersion, '0.87.1+alex.codex-default.206545bfd51e');
});
