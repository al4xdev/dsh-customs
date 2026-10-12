import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlanConfig, writePlanConfig } from './config.mjs';

const scratch = fileURLToPath(new URL('../../.dumps/', import.meta.url));
async function fixture() {
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, 'managed-plan-config-'));
}
async function config(root, value) {
  await mkdir(join(root, '.agents'), { recursive: true });
  await writeFile(join(root, '.agents', 'config.json'), JSON.stringify(value));
}

test('missing project preference is read-only and does not bootstrap either directory', async () => {
  const root = await fixture();
  assert.equal(await readPlanConfig(root), null);
  await assert.rejects(access(join(root, '.agents')), { code: 'ENOENT' });
  await assert.rejects(access(join(root, '.plan')), { code: 'ENOENT' });
});

test('on/off persist while unrelated config and namespace keys remain intact', async () => {
  const root = await fixture();
  const original = { unrelated: [1, 2], dshCustoms: { future: { value: 1 }, managedPlans: { other: 'retained' } } };
  await config(root, original);
  assert.equal(await readPlanConfig(root), null);
  await writePlanConfig(root, true);
  assert.equal(await readPlanConfig(root), true);
  assert.deepEqual(JSON.parse(await readFile(join(root, '.agents', 'config.json'), 'utf8')), {
    ...original, dshCustoms: { ...original.dshCustoms, managedPlans: { other: 'retained', autoApprove: true } },
  });
  await writePlanConfig(root, false);
  assert.equal(await readPlanConfig(root), false);
  await assert.rejects(writePlanConfig(root, 'true'), /boolean/);
});

test('malformed JSON and namespace shapes fail without silently enabling approval', async () => {
  const root = await fixture();
  for (const document of [null, [], { dshCustoms: null }, { dshCustoms: [] }, { dshCustoms: { managedPlans: 'bad' } }, { dshCustoms: { managedPlans: { autoApprove: 'true' } } }]) {
    await config(root, document);
    await assert.rejects(readPlanConfig(root));
  }
  await writeFile(join(root, '.agents', 'config.json'), '{broken json');
  await assert.rejects(readPlanConfig(root), SyntaxError);
  await assert.rejects(writePlanConfig(root, true), SyntaxError);
  assert.equal(await readFile(join(root, '.agents', 'config.json'), 'utf8'), '{broken json');
});

test('malformed namespace is preserved rather than overwritten by a toggle', async () => {
  const root = await fixture();
  await config(root, { dshCustoms: { managedPlans: null } });
  const before = await readFile(join(root, '.agents', 'config.json'), 'utf8');
  await assert.rejects(writePlanConfig(root, true), /must be an object/);
  assert.equal(await readFile(join(root, '.agents', 'config.json'), 'utf8'), before);
});

test('oversized config is rejected on read and write', async () => {
  const root = await fixture();
  await config(root, { large: 'x'.repeat(1024 * 1024) });
  await assert.rejects(readPlanConfig(root), /1 MiB/);
  await assert.rejects(writePlanConfig(root, true), /1 MiB/);
});

test('project config directory cannot escape to another workspace', async () => {
  const root = await fixture(), outside = await fixture();
  await config(outside, { dshCustoms: { managedPlans: { autoApprove: true } } });
  await symlink(join(outside, '.agents'), join(root, '.agents'));
  await assert.rejects(readPlanConfig(root), /outside/);
  await assert.rejects(writePlanConfig(root, false), /outside/);
  assert.equal(await readPlanConfig(outside), true);
});

test('config file symlinks are neither imported nor replaced', async () => {
  const root = await fixture();
  const target = join(root, 'other.json');
  await writeFile(target, JSON.stringify({ dshCustoms: { managedPlans: { autoApprove: true } } }));
  await mkdir(join(root, '.agents'));
  await symlink(target, join(root, '.agents', 'config.json'));
  await assert.rejects(readPlanConfig(root), { code: 'ELOOP' });
  await assert.rejects(writePlanConfig(root, false), { code: 'ELOOP' });
  assert.equal(JSON.parse(await readFile(target, 'utf8')).dshCustoms.managedPlans.autoApprove, true);
});
