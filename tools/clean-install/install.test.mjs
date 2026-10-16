import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installationPaths, assertFresh, runtimePackage, prepareUnifiedRecovery, versions, main } from './install.mjs';

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

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function recoveryFixture(t) {
  const { home, repo } = await fixture(t), esbuildModule = join(home, 'compiler.mjs');
  await writeFile(esbuildModule, 'throw new Error("REAL_COMPILER_MUST_NOT_RUN_IN_UNIT_FIXTURE");\n');
  const specs = {
    controller: { entry: 'plugins/llm-resilience/index.mjs', output: 'plugins/llm-resilience/lib/index-v5-unified.mjs', rollback: 'plugins/llm-resilience/lib/index-v1-resilience.mjs' },
    selfHeal: { entry: 'plugins/agent-self-heal/index.mjs', output: 'plugins/agent-self-heal/lib/index-v6-unified.mjs', rollback: 'plugins/agent-self-heal/lib/index-v3-resilience.mjs' },
  };
  const put = async (relative, bytes) => { const target = join(repo, relative); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, bytes); };
  const rollbackHashes = {};
  for (const path of ['plugins/agent-self-heal/lib/index-v2-persistence.mjs', ...Object.values(specs).map(spec => spec.rollback)]) {
    const bytes = `immutable synthetic rollback ${path}\n`; await put(path, bytes); rollbackHashes[path] = digest(bytes);
  }
  const records = {}, contents = {};
  for (const [id, spec] of Object.entries(specs)) {
    const source = `public synthetic ${id} entry\n`; await put(spec.entry, source);
    contents[id] = `// reviewed closed ${id} artifact\n`;
    records[id] = { schema: 1, output: spec.output.split('/').at(-1), sha256: digest(contents[id]), sourceHashes: { [spec.entry]: digest(source) }, compilerVersion: versions.esbuild, target: 'node24', rollbackSha256: rollbackHashes[spec.rollback] };
    await put(spec.output.replace(/\.mjs$/, '.build.json'), JSON.stringify(records[id], null, 2) + '\n');
    if (id === 'selfHeal') await put(spec.output, contents[id]);
  }
  let calls = 0;
  const build = async args => {
    calls++; assert.deepEqual(args, { repoRoot: repo, esbuildModule });
    const artifacts = {};
    for (const [id, spec] of Object.entries(specs)) {
      const output = join(repo, spec.output), manifest = output.replace(/\.mjs$/, '.build.json');
      try { assert.equal(await readFile(output, 'utf8'), contents[id]); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(output, contents[id], { flag: 'wx' }); }
      artifacts[id] = { ...records[id], output, manifest, reused: id === 'selfHeal' };
    }
    return { schema: 1, kind: 'unified-recovery-build', artifacts, compiler: esbuildModule, rollbackHashes, modelCalls: 0, profilesModified: false };
  };
  return { repo, esbuildModule, specs, records, contents, put, build, get calls() { return calls; }, async saveRecord(id) { await put(specs[id].output.replace(/\.mjs$/, '.build.json'), JSON.stringify(records[id], null, 2) + '\n'); } };
}

test('reviewed controller5 builds through the interface with existing exact owner6', async t => {
  const f = await recoveryFixture(t);
  const first = await prepareUnifiedRecovery(f, { build: f.build });
  assert.equal(first.reviewed, true); assert.equal(f.calls, 1);
  assert.deepEqual(first.outputBeforeHashes, { controller: null, selfHeal: f.records.selfHeal.sha256 });
  const second = await prepareUnifiedRecovery(f, { build: f.build });
  assert.equal(f.calls, 2);
  assert.deepEqual(second.outputBeforeHashes, { controller: f.records.controller.sha256, selfHeal: f.records.selfHeal.sha256 });
});

for (const drift of ['source', 'second-record', 'rollback', 'existing-output', 'source-escape']) test(`${drift} drift rejects both builds before the compiler or first new output`, async t => {
  const f = await recoveryFixture(t);
  if (drift === 'source') await f.put(f.specs.selfHeal.entry, 'changed source');
  if (drift === 'second-record') { f.records.selfHeal.compilerVersion = 'unreviewed'; await f.saveRecord('selfHeal'); }
  if (drift === 'rollback') await f.put(f.specs.selfHeal.rollback, 'changed immutable rollback');
  if (drift === 'existing-output') await f.put(f.specs.controller.output, 'unknown preexisting output');
  if (drift === 'source-escape') { f.records.selfHeal.sourceHashes['plugins/../.dsh/private.mjs'] = 'a'.repeat(64); await f.saveRecord('selfHeal'); }
  await assert.rejects(prepareUnifiedRecovery(f, { build: f.build })); assert.equal(f.calls, 0);
  assert.equal(await readFile(join(f.repo, f.specs.selfHeal.output), 'utf8'), f.contents.selfHeal);
  if (drift !== 'existing-output') await assert.rejects(readFile(join(f.repo, f.specs.controller.output)), { code: 'ENOENT' });
});

test('post-compile source changes invalidate the result without pretending multi-file atomicity', async t => {
  const f = await recoveryFixture(t);
  await assert.rejects(prepareUnifiedRecovery(f, { build: async args => { const result = await f.build(args); await f.put(f.specs.controller.entry, 'concurrent change'); return result; } }), /source changed/);
  assert.equal(f.calls, 1);
});

test('clean install refuses a claimed owner rebuild even with matching output hashes', async t => {
  const f = await recoveryFixture(t);
  await assert.rejects(prepareUnifiedRecovery(f, { build: async args => {
    const result = await f.build(args); result.artifacts.selfHeal.reused = false; return result;
  } }), /Owner must be reused/);
});
