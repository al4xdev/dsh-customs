import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUnifiedRecovery } from './build-unified-recovery.mjs';

// Production builder permissions are masked for these private scratch fixtures.
process.umask(0o077);
const dumpRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dumps');
const controllerPath = 'plugins/llm-resilience/lib/index-v5-unified.mjs';
const historicalPath = 'plugins/llm-resilience/lib/index-v4-unified.mjs';
const selfHealPath = 'plugins/agent-self-heal/lib/index-v6-unified.mjs';
const ownerEntry = 'plugins/agent-self-heal/index.mjs';
const ownerLeaf = 'plugins/llm-resilience/policy.mjs';
const ownerRecordPath = selfHealPath.replace(/\.mjs$/, '.build.json');
const legacy = ['plugins/llm-resilience/lib/index-v1-resilience.mjs', 'plugins/agent-self-heal/lib/index-v3-resilience.mjs', 'plugins/agent-self-heal/lib/index-v2-persistence.mjs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fakeCompiler = `import {relative} from 'node:path';
export const version='0.28.2';
export async function build(options){if(!options.entryPoints[0].endsWith('/llm-resilience/index.mjs'))throw Error('OWNER_MUST_NOT_COMPILE');let load;options.plugins[0].setup({onLoad(_filter,callback){load=callback}});const entry=options.entryPoints[0];const result=await load({path:entry});return{outputFiles:[{contents:Buffer.from('// reviewed fixture compiler output\\n'+result.contents)}],metafile:{inputs:{[relative(options.absWorkingDir,entry)]:{bytes:result.contents.length}}}}}
`;

async function fixture() {
  await mkdir(dumpRoot, { recursive: true, mode: 0o700 });
  const repoRoot = await mkdtemp(join(dumpRoot, 'unified-builder-test-'));
  async function file(path, bytes) { const target = join(repoRoot, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
  for (const path of legacy) await file(path, `// immutable rollback: ${path}\n`);
  await file(historicalPath, '// historical controller4\n');
  await file(historicalPath.replace(/\.mjs$/, '.build.json'), '{"historical":true}\n');
  await file('plugins/llm-resilience/index.mjs', 'export const controller = 2;\n');
  const ownerSource = 'export const selfHeal = 6;\n', ownerBytes = '// exact previously built owner6\n';
  await file(ownerEntry, ownerSource);
  await file(ownerLeaf, 'export const sharedPolicy = 2;\n');
  await file(selfHealPath, ownerBytes);
  await file(ownerRecordPath, JSON.stringify({ schema: 1, output: 'index-v6-unified.mjs', sha256: sha(ownerBytes), sourceHashes: { [ownerEntry]: sha(ownerSource), [ownerLeaf]: sha(await readFile(join(repoRoot, ownerLeaf))) }, compilerVersion: '0.28.2', target: 'node24', rollbackSha256: sha(await readFile(join(repoRoot, legacy[1]))) }, null, 2) + '\n');
  await file('compiler.mjs', fakeCompiler);
  return { repoRoot, esbuildModule: join(repoRoot, 'compiler.mjs') };
}
const preserved = [...legacy, historicalPath, historicalPath.replace(/\.mjs$/, '.build.json'), selfHealPath, ownerRecordPath];
const snapshot = async options => Promise.all(preserved.map(async path => ({ path, bytes: await readFile(join(options.repoRoot, path)), stat: await stat(join(options.repoRoot, path)) })));
async function assertPreserved(before, options) {
  for (const old of before) {
    assert.deepEqual(await readFile(join(options.repoRoot, old.path)), old.bytes);
    const after = await stat(join(options.repoRoot, old.path));
    for (const key of ['ino', 'mode', 'mtimeMs']) assert.equal(after[key], old.stat[key]);
  }
}

test('only controller5 compiles; exact owner6/sidecar and historical controller4 stay untouched', async () => {
  const options = await fixture(), before = await snapshot(options);
  const first = await buildUnifiedRecovery(options);
  assert.equal(first.kind, 'unified-recovery-build'); assert.equal(first.profilesModified, false); assert.equal(first.modelCalls, 0);
  assert.equal(first.artifacts.controller.output, join(options.repoRoot, controllerPath));
  assert.equal(first.artifacts.selfHeal.output, join(options.repoRoot, selfHealPath));
  assert.equal(first.artifacts.controller.reused, false); assert.equal(first.artifacts.selfHeal.reused, true);
  for (const item of Object.values(first.artifacts)) {
    const record = JSON.parse(await readFile(item.manifest, 'utf8'));
    assert.equal(record.compilerVersion, '0.28.2'); assert.equal(record.sha256, item.sha256);
    assert.equal(record.target, 'node24'); assert.equal(Object.keys(record.sourceHashes).length, item === first.artifacts.selfHeal ? 2 : 1);
  }
  const second = await buildUnifiedRecovery(options);
  assert.equal(second.artifacts.controller.reused, true); assert.equal(second.artifacts.selfHeal.reused, true);
  assert.deepEqual(second.rollbackHashes, first.rollbackHashes);
  await assertPreserved(before, options);
});

test('changed controller source cannot overwrite versioned output or build record', async () => {
  const options = await fixture(), first = await buildUnifiedRecovery(options);
  const outputBefore = await readFile(first.artifacts.controller.output), recordBefore = await readFile(first.artifacts.controller.manifest);
  await writeFile(join(options.repoRoot, 'plugins/llm-resilience/index.mjs'), 'export const controller = 999;\n');
  await assert.rejects(buildUnifiedRecovery(options), /Immutable artifact differs/);
  assert.deepEqual(await readFile(first.artifacts.controller.output), outputBefore);
  assert.deepEqual(await readFile(first.artifacts.controller.manifest), recordBefore);
});

test('foreign controller5 output fails preflight without touching owner6 or controller4', async () => {
  const options = await fixture(), before = await snapshot(options);
  await writeFile(join(options.repoRoot, controllerPath), 'foreign output', { flag: 'wx', mode: 0o600 });
  await assert.rejects(buildUnifiedRecovery(options), /Immutable artifact differs/);
  await assertPreserved(before, options);
  await assert.rejects(readFile(join(options.repoRoot, controllerPath.replace(/\.mjs$/, '.build.json'))), { code: 'ENOENT' });
});

for (const drift of ['source', 'leaf', 'hash', 'rollback', 'compiler', 'target', 'entry', 'escape', 'missing-owner', 'missing-sidecar', 'symlink']) test(`owner ${drift} refuses before new controller publication`, async () => {
  const options = await fixture();
  const record = JSON.parse(await readFile(join(options.repoRoot, ownerRecordPath), 'utf8'));
  if (drift === 'source') await writeFile(join(options.repoRoot, ownerEntry), 'changed closure');
  if (drift === 'leaf') await writeFile(join(options.repoRoot, ownerLeaf), 'changed shared closure');
  if (drift === 'hash') record.sha256 = 'a'.repeat(64);
  if (drift === 'rollback') record.rollbackSha256 = 'a'.repeat(64);
  if (drift === 'compiler') record.compilerVersion = 'unreviewed';
  if (drift === 'target') record.target = 'node22';
  if (drift === 'entry') record.sourceHashes = {};
  if (drift === 'escape') record.sourceHashes['plugins/../private.mjs'] = 'a'.repeat(64);
  await writeFile(join(options.repoRoot, ownerRecordPath), JSON.stringify(record));
  // Rename/delete is deliberately unnecessary: a second synthetic repository
  // selection demonstrates absent and redirected immutable owner paths.
  if (['missing-owner', 'missing-sidecar', 'symlink'].includes(drift)) {
    const absent = 'plugins/agent-self-heal/lib/index-v7-fixture.mjs';
    const source = await readFile(new URL('./build-unified-recovery.mjs', import.meta.url), 'utf8');
    const compilerPath = join(options.repoRoot, `builder-${drift}.mjs`);
    await writeFile(compilerPath, source.replaceAll(selfHealPath, absent), { flag: 'wx', mode: 0o600 });
    if (drift === 'missing-owner') await writeFile(join(options.repoRoot, absent.replace(/\.mjs$/, '.build.json')), '{}', { mode: 0o600 });
    if (drift === 'missing-sidecar') await writeFile(join(options.repoRoot, absent), '// owner', { mode: 0o600 });
    if (drift === 'symlink') await symlink(join(options.repoRoot, selfHealPath), join(options.repoRoot, absent));
    const { buildUnifiedRecovery: build } = await import(compilerPath);
    await assert.rejects(build(options));
  } else await assert.rejects(buildUnifiedRecovery(options));
  await assert.rejects(readFile(join(options.repoRoot, controllerPath)), { code: 'ENOENT' });
});

for (const path of [selfHealPath, ownerRecordPath, ownerLeaf]) test(`concurrent ${path} drift refuses before controller writes`, async () => {
  const options = await fixture();
  const compiler = `import {writeFile} from 'node:fs/promises';\n` + fakeCompiler.replace('let load;', `await writeFile(${JSON.stringify(join(options.repoRoot, path))}, 'concurrent drift');let load;`);
  await writeFile(options.esbuildModule, compiler);
  await assert.rejects(buildUnifiedRecovery(options), /Owner .*changed/);
  await assert.rejects(readFile(join(options.repoRoot, controllerPath)), { code: 'ENOENT' });
});

test('symlink controller artifacts are refused without modifying referent', async () => {
  const options = await fixture();
  const outside = join(options.repoRoot, 'owner-file.mjs'); await writeFile(outside, 'owner bytes', { flag: 'wx', mode: 0o600 });
  await symlink(outside, join(options.repoRoot, controllerPath));
  await assert.rejects(buildUnifiedRecovery(options), /Regular immutable artifact required/);
  assert.equal(await readFile(outside, 'utf8'), 'owner bytes');
});
