import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUnifiedRecovery, specs, HISTORICAL } from './build-unified-recovery.mjs';

// Production builder permissions are masked for these private scratch fixtures.
process.umask(0o077);
const dumpRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dumps');
const controllerPath = specs.controller.output, selfHealPath = specs.selfHeal.output;
const controllerRollback = specs.controller.rollback, ownerRollback = specs.selfHeal.rollback;
const sidecar = path => path.replace(/\.mjs$/, '.build.json');
const ownerLeaf = 'plugins/llm-resilience/policy.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Fixture compiler: echoes every own module it is told to load, so the builder's
// closure capture (entry + leaf) and metafile cross-check are exercised.
const fakeCompiler = `import {relative} from 'node:path';
export const version='0.28.2';
export async function build(options){let load;options.plugins[0].setup({onLoad(_filter,callback){load=callback}});const entry=options.entryPoints[0];const leaf=entry.replace(/plugins\\/[^/]+\\/index\\.mjs$/,'plugins/llm-resilience/policy.mjs');const inputs={};let text='// reviewed fixture compiler output\\n';for(const path of [...new Set([entry,leaf])]){const result=await load({path});inputs[relative(options.absWorkingDir,path)]={bytes:result.contents.length};text+=result.contents}return{outputFiles:[{contents:Buffer.from(text)}],metafile:{inputs}}}
`;

async function fixture() {
  await mkdir(dumpRoot, { recursive: true, mode: 0o700 });
  const repoRoot = await mkdtemp(join(dumpRoot, 'unified-builder-test-'));
  async function file(path, bytes) { const target = join(repoRoot, path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
  for (const path of HISTORICAL) await file(path, `// immutable historical: ${path}\n`);
  for (const path of [controllerRollback, ownerRollback]) {
    const bytes = `// immutable rollback: ${path}\n`;
    await file(path, bytes);
    await file(sidecar(path), JSON.stringify({ schema: 1, output: path.split('/').at(-1), sha256: sha(bytes), sourceHashes: { [path]: 'a'.repeat(64) }, compilerVersion: '0.28.2', target: 'node24', rollbackSha256: 'b'.repeat(64) }, null, 2) + '\n');
  }
  await file(specs.controller.entry, 'export const controller = 6;\n');
  await file(specs.selfHeal.entry, 'export const selfHeal = 7;\n');
  await file(ownerLeaf, 'export const sharedPolicy = 3;\n');
  await file('compiler.mjs', fakeCompiler);
  return { repoRoot, esbuildModule: join(repoRoot, 'compiler.mjs') };
}
const preserved = [...HISTORICAL, controllerRollback, ownerRollback, sidecar(controllerRollback), sidecar(ownerRollback)];
const snapshot = async options => Promise.all(preserved.map(async path => ({ path, bytes: await readFile(join(options.repoRoot, path)), stat: await stat(join(options.repoRoot, path)) })));
async function assertPreserved(before, options) {
  for (const old of before) {
    assert.deepEqual(await readFile(join(options.repoRoot, old.path)), old.bytes);
    const after = await stat(join(options.repoRoot, old.path));
    for (const key of ['ino', 'mode', 'mtimeMs']) assert.equal(after[key], old.stat[key]);
  }
}
const absent = async (options, ...paths) => { for (const path of paths) await assert.rejects(readFile(join(options.repoRoot, path)), { code: 'ENOENT' }); };

test('controller6 and owner7 both compile from sources; reruns reuse; rollbacks controller5/owner6 stay untouched', async () => {
  const options = await fixture(), before = await snapshot(options);
  const first = await buildUnifiedRecovery(options);
  assert.equal(first.kind, 'unified-recovery-build'); assert.equal(first.contract, 3); assert.equal(first.profilesModified, false); assert.equal(first.modelCalls, 0);
  assert.equal(first.artifacts.controller.output, join(options.repoRoot, controllerPath));
  assert.equal(first.artifacts.selfHeal.output, join(options.repoRoot, selfHealPath));
  assert.equal(first.artifacts.controller.reused, false); assert.equal(first.artifacts.selfHeal.reused, false);
  for (const [name, item] of Object.entries(first.artifacts)) {
    const record = JSON.parse(await readFile(item.manifest, 'utf8'));
    assert.equal(record.compilerVersion, '0.28.2'); assert.equal(record.sha256, item.sha256); assert.equal(record.target, 'node24');
    assert.deepEqual(Object.keys(record.sourceHashes).sort(), [specs[name].entry, ownerLeaf].sort());
    assert.equal(record.rollbackSha256, sha(await readFile(join(options.repoRoot, specs[name].rollback))));
  }
  const second = await buildUnifiedRecovery(options);
  assert.equal(second.artifacts.controller.reused, true); assert.equal(second.artifacts.selfHeal.reused, true);
  assert.deepEqual(second.rollbackHashes, first.rollbackHashes);
  await assertPreserved(before, options);
});

for (const path of [specs.controller.entry, specs.selfHeal.entry, ownerLeaf]) test(`changed source ${path} cannot overwrite versioned outputs or build records`, async () => {
  const options = await fixture(), first = await buildUnifiedRecovery(options);
  const outputs = await Promise.all(Object.values(first.artifacts).flatMap(item => [item.output, item.manifest]).map(file => readFile(file)));
  await writeFile(join(options.repoRoot, path), 'export const changed = 999;\n');
  await assert.rejects(buildUnifiedRecovery(options), /Immutable artifact differs/);
  assert.deepEqual(await Promise.all(Object.values(first.artifacts).flatMap(item => [item.output, item.manifest]).map(file => readFile(file))), outputs);
});

for (const path of [controllerPath, selfHealPath]) test(`foreign ${path} fails preflight before ANY new publication`, async () => {
  const options = await fixture(), before = await snapshot(options);
  await mkdir(dirname(join(options.repoRoot, path)), { recursive: true });
  await writeFile(join(options.repoRoot, path), 'foreign output', { flag: 'wx', mode: 0o600 });
  await assert.rejects(buildUnifiedRecovery(options), /Immutable artifact differs/);
  await assertPreserved(before, options);
  const other = path === controllerPath ? selfHealPath : controllerPath;
  await absent(options, sidecar(path), other, sidecar(other));
});

for (const drift of ['rollback-bytes', 'rollback-sidecar-fields', 'missing-rollback', 'missing-rollback-sidecar', 'missing-historical', 'compiler']) test(`${drift} refuses before any publication`, async () => {
  const options = await fixture();
  if (drift === 'rollback-bytes') await writeFile(join(options.repoRoot, ownerRollback), '// drifted rollback\n');
  if (drift === 'rollback-sidecar-fields') await writeFile(join(options.repoRoot, sidecar(controllerRollback)), JSON.stringify({ schema: 1 }));
  if (drift === 'missing-rollback' || drift === 'missing-rollback-sidecar' || drift === 'missing-historical') {
    // Rename/delete is deliberately unnecessary: a synthetic builder copy points
    // the protected path at a name that was never created.
    const source = await readFile(new URL('./build-unified-recovery.mjs', import.meta.url), 'utf8');
    const target = drift === 'missing-historical' ? HISTORICAL[0] : drift === 'missing-rollback' ? ownerRollback : controllerRollback;
    const replacement = drift === 'missing-rollback-sidecar' ? target.replace('index-v5', 'index-v5x') : target.replace(/\.mjs$/, '-absent.mjs');
    let patched = source.replaceAll(target, replacement);
    if (drift === 'missing-rollback-sidecar') await writeFile(join(options.repoRoot, replacement), await readFile(join(options.repoRoot, target)), { mode: 0o600 });
    const builder = join(options.repoRoot, `builder-${drift}.mjs`);
    await writeFile(builder, patched, { flag: 'wx', mode: 0o600 });
    const { buildUnifiedRecovery: build } = await import(builder);
    await assert.rejects(build(options));
  } else {
    if (drift === 'compiler') await writeFile(options.esbuildModule, fakeCompiler.replace("'0.28.2'", "'0.28.3'"));
    await assert.rejects(buildUnifiedRecovery(options));
  }
  await absent(options, controllerPath, selfHealPath, sidecar(controllerPath), sidecar(selfHealPath));
});

for (const path of [ownerRollback, sidecar(controllerRollback), HISTORICAL[1]]) test(`concurrent ${path} drift refuses before writes`, async () => {
  const options = await fixture();
  const compiler = `import {writeFile} from 'node:fs/promises';\n` + fakeCompiler.replace('let load;', `await writeFile(${JSON.stringify(join(options.repoRoot, path))}, 'concurrent drift');let load;`);
  await writeFile(options.esbuildModule, compiler);
  await assert.rejects(buildUnifiedRecovery(options), /changed/);
  await absent(options, controllerPath, selfHealPath);
});

test('a source edited after the compiler captured it refuses before writes', async () => {
  const options = await fixture();
  // Drift lands after onLoad hashed the leaf: the captured bytes no longer match disk.
  const compiler = `import {writeFile} from 'node:fs/promises';\n` + fakeCompiler.replace('return{outputFiles', `await writeFile(${JSON.stringify(join(options.repoRoot, ownerLeaf))}, 'concurrent drift');return{outputFiles`);
  await writeFile(options.esbuildModule, compiler);
  await assert.rejects(buildUnifiedRecovery(options), /Source changed during compilation/);
  await absent(options, controllerPath, selfHealPath);
});

test('unexpected bundled module and uncaptured dependency are refused', async () => {
  const options = await fixture();
  await writeFile(options.esbuildModule, fakeCompiler.replace("const leaf=entry.replace(/plugins\\/[^/]+\\/index\\.mjs$/,'plugins/llm-resilience/policy.mjs');", "const leaf=entry.replace(/plugins\\/[^/]+\\/index\\.mjs$/,'compiler.mjs');"));
  await assert.rejects(buildUnifiedRecovery(options), /Unexpected bundled module/);
  const second = await fixture();
  await writeFile(second.esbuildModule, fakeCompiler.replace('return{outputFiles', "inputs['plugins/hidden.mjs']={bytes:1};return{outputFiles"));
  await assert.rejects(buildUnifiedRecovery(second), /Uncaptured build dependency/);
  await absent(second, controllerPath, selfHealPath);
});

test('symlink artifacts are refused without modifying the referent', async () => {
  const options = await fixture();
  const outside = join(options.repoRoot, 'owner-file.mjs'); await writeFile(outside, 'owner bytes', { flag: 'wx', mode: 0o600 });
  await mkdir(dirname(join(options.repoRoot, controllerPath)), { recursive: true });
  await symlink(outside, join(options.repoRoot, controllerPath));
  await assert.rejects(buildUnifiedRecovery(options), /Regular immutable artifact required/);
  assert.equal(await readFile(outside, 'utf8'), 'owner bytes');
});
