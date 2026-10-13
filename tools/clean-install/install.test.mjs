import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installationPaths, assertFresh, runtimePackage, main } from './install.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-clean-install-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const repo = join(home, 'repo');
  await mkdir(repo);
  return installationPaths(home, repo);
}

test('canonical layout is host-identical under the supplied fresh HOME', () => {
  const paths = installationPaths('/home/alex', '/home/alex/git/my/dsh-customs');
  assert.equal(paths.install, '/home/alex/.local/share/dsh-cli');
  assert.equal(paths.dshHome, '/home/alex/.dsh');
  assert.throws(() => installationPaths('relative'), /absolute/);
});

test('fresh guard refuses host execution and all occupied roots', async t => {
  const paths = await fixture(t);
  await assert.rejects(assertFresh(paths), /Docker-only/);
  await assertFresh(paths, { docker: true });
  await mkdir(paths.dshHome);
  await assertFresh(paths, { docker: true });
  await writeFile(join(paths.dshHome, 'private-placeholder'), 'do not read');
  await assert.rejects(assertFresh(paths, { docker: true }), /absent or empty/);
});

test('broken symlinks cannot bypass absent canonical runtime checks', async t => {
  const paths = await fixture(t);
  await mkdir(join(paths.home, '.local/share'), { recursive: true });
  await symlink('/intentionally/missing/fixture', paths.install);
  await assert.rejects(assertFresh(paths, { docker: true }), /already occupied/);
});

test('runtime owns direct physical Pi identity for every dependency caller', () => {
  const pkg = runtimePackage({ tui: '/artifacts/tui.tgz', antigravity: '/artifacts/ag.tgz', pi: '/artifacts/pi.tgz' });
  assert.equal(pkg.overrides['@earendil-works/pi-ai'], '$@earendil-works/pi-ai');
  assert.equal(pkg.dependencies['@earendil-works/pi-ai'], 'file:/artifacts/pi.tgz');
  assert.equal(pkg.dependencies['@deepseek-ai/dsh'], '0.2.0-rc.2');
  assert.equal(pkg.dependencies.yaml, '2.9.1');
  assert.throws(() => runtimePackage({ tui: 'relative', antigravity: '/ag', pi: '/pi' }));
});

test('default/help CLI does not reserve paths or execute subprocesses', async () => {
  assert.match((await main([])).help, /Docker-only/);
  assert.match((await main(['--help'])).help, /no automatic model/);
  await assert.rejects(main(['--fresh', '--force']), /explicit --fresh/);
});
