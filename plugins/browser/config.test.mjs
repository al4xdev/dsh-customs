import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, normalizeConfig, resolveConfig } from './config.mjs';

const scratch = fileURLToPath(new URL('../../.dumps/tasks/task05-contract-config/', import.meta.url));
async function fixture() {
  await mkdir(scratch, { recursive: true });
  const base = await mkdtemp(join(scratch, 'fixture-'));
  const root = join(base, 'project');
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(join(root, '.agents'));
  await mkdir(join(root, 'nested'));
  return { base, root, cwd: join(root, 'nested'), path: join(root, '.agents', 'config.json') };
}

test('defaults are finite, recursively frozen and not mutated by normalization', () => {
  const actual = normalizeConfig();
  assert.deepEqual(actual, DEFAULT_CONFIG);
  assert.ok(Object.isFrozen(DEFAULT_CONFIG)); assert.ok(Object.isFrozen(DEFAULT_CONFIG.limits));
  assert.ok(Object.isFrozen(actual.allowedEngines));
  assert.throws(() => { actual.limits.sessions = 100; }, TypeError);
  assert.equal(DEFAULT_CONFIG.limits.sessions, 2);
});

test('profile override is explicit; project narrows budgets/capabilities/retention', () => {
  const actual = normalizeConfig({ allowCss: true, allowedEngines: ['chromium', 'firefox'], limits: { tabs: 8 }, browserCache: '/tmp/owned-browser-cache' }, { allowCss: false, allowedEngines: ['chromium'], limits: { tabs: 2, freeDiskBytes: 2147483648 }, rawRetentionMs: 3600000 });
  assert.equal(actual.allowCss, false); assert.deepEqual(actual.allowedEngines, ['chromium']);
  assert.equal(actual.limits.tabs, 2); assert.equal(actual.limits.sessions, 2);
  assert.equal(actual.limits.freeDiskBytes, 2147483648); assert.equal(actual.rawRetentionMs, 3600000);
  assert.equal(actual.browserCache, '/tmp/owned-browser-cache');
});

test('project attempts to widen permission fail closed', () => {
  for (const project of [
    { allowCss: true }, { allowDownloads: true }, { allowedEngines: ['webkit'] },
    { limits: { tabs: 5 } }, { limits: { freeDiskBytes: 1 } },
    { deliveryRetentionMs: 604800001 }, { browserCache: '/tmp/model-controlled' },
  ]) assert.throws(() => normalizeConfig({}, project), { code: 'BROWSER_CONFIG_INVALID' });
  assert.throws(() => normalizeConfig({ enabled: false }, { enabled: true }), { code: 'BROWSER_CONFIG_INVALID' });
  assert.throws(() => normalizeConfig({ sensitiveOps: 'disabled' }, { sensitiveOps: 'ask' }), { code: 'BROWSER_CONFIG_INVALID' });
  assert.equal(normalizeConfig({}, { enabled: false }).enabled, false);
});

test('invalid/unknown config fields never become permissive defaults', () => {
  for (const profile of [
    null, [], { enabled: 'true' }, { command: 'node' }, { allowedEngines: ['chromium', 'chromium'] },
    { sensitiveOps: 'allow' }, { browserCache: 'relative' }, { browserCache: '/tmp\0bad' },
    { limits: { tabs: Infinity } }, { limits: { tabs: 2.5 } }, { limits: { unknown: 1 } },
    { limits: { inputBytes: 0 } }, { limits: { videoDurationMs: 999 } }, { rawRetentionMs: -1 },
  ]) assert.throws(() => normalizeConfig(profile), { code: 'BROWSER_CONFIG_INVALID' });
});

test('nearest Git configuration reads only browser namespace and preserves file', async () => {
  const f = await fixture();
  const original = JSON.stringify({ unrelated: { keep: true }, dshCustoms: { managedPlans: { autoApprove: true }, browser: { enabled: false, limits: { tabs: 1 } } } }, null, 2);
  await writeFile(f.path, original);
  const first = await resolveConfig(f.cwd);
  const second = await resolveConfig(f.cwd);
  assert.equal(first.root, f.root); assert.equal(first.config.enabled, false); assert.equal(first.config.limits.tabs, 1);
  assert.equal(first.revision, second.revision);
  assert.equal(await readFile(f.path, 'utf8'), original);
  await mkdir(join(f.cwd, 'nested-repo/.git'), { recursive: true });
  await writeFile(join(f.cwd, 'nested-repo/.git/HEAD'), 'ref: refs/heads/child\n');
  const nested = await resolveConfig(join(f.cwd, 'nested-repo'));
  assert.equal(nested.config.enabled, true); assert.notEqual(nested.root, first.root);
});

test('absent browser section applies profile, malformed shared namespaces fail only browser', async () => {
  const f = await fixture();
  await writeFile(f.path, JSON.stringify({ dshCustoms: { managedPlans: { autoApprove: false } } }));
  assert.equal((await resolveConfig(f.cwd, { enabled: false })).config.enabled, false);
  await writeFile(f.path, JSON.stringify({ dshCustoms: 'malformed' }));
  await assert.rejects(resolveConfig(f.cwd), { code: 'BROWSER_CONFIG_INVALID' });
  await writeFile(f.path, '{not valid json');
  await assert.rejects(resolveConfig(f.cwd), { code: 'BROWSER_CONFIG_INVALID' });
});

test('file symlink, directory escape and oversized config fail closed', async () => {
  const f = await fixture();
  const outside = join(f.base, 'outside.json');
  await writeFile(outside, JSON.stringify({ dshCustoms: { browser: { enabled: true } } }));
  await symlink(outside, f.path);
  await assert.rejects(resolveConfig(f.cwd), { code: 'BROWSER_CONFIG_INVALID' });
  const g = await fixture();
  await writeFile(g.path, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(resolveConfig(g.cwd), { code: 'BROWSER_CONFIG_INVALID' });
  const h = await fixture();
  const root = join(h.base, 'escape-project');
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
  await symlink(join(h.root, '.agents'), join(root, '.agents'));
  await assert.rejects(resolveConfig(root), { code: 'BROWSER_CONFIG_INVALID' });
  const dangling = join(h.base, 'dangling-project');
  await mkdir(join(dangling, '.git'), { recursive: true });
  await writeFile(join(dangling, '.git/HEAD'), 'ref: refs/heads/main\n');
  await symlink(join(h.base, 'does-not-exist'), join(dangling, '.agents'));
  await assert.rejects(resolveConfig(dangling), { code: 'BROWSER_CONFIG_INVALID' });
});
