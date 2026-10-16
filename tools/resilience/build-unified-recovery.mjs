#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRepo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const specs = Object.freeze({
  controller: Object.freeze({ entry: 'plugins/llm-resilience/index.mjs', output: 'plugins/llm-resilience/lib/index-v5-unified.mjs', rollback: 'plugins/llm-resilience/lib/index-v1-resilience.mjs' }),
  selfHeal: Object.freeze({ entry: 'plugins/agent-self-heal/index.mjs', output: 'plugins/agent-self-heal/lib/index-v6-unified.mjs', rollback: 'plugins/agent-self-heal/lib/index-v3-resilience.mjs' }),
});

async function maybeRead(path) {
  try {
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Regular immutable artifact required');
    assert.equal(await realpath(path), path, 'Symlink artifact path refused');
    return await readFile(path);
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Closed own-module bundles avoid cached ESM leaves after profile-only HMR.
 * Compile only the new controller. The owner is an existing reviewed closure,
 * not a reproducibility rebuild with potentially different compiler path bytes.
 * Publication remains a separate guarded operation, not this build.
 */
export async function buildUnifiedRecovery({ repoRoot = defaultRepo, esbuildModule } = {}) {
  assert.equal(repoRoot, await realpath(repoRoot), 'Repository must be canonical');
  assert.equal(esbuildModule, resolve(esbuildModule), 'Explicit compiler module required');
  const compilerPath = await realpath(esbuildModule);
  const compiler = await import(pathToFileURL(compilerPath).href);
  const build = compiler.build ?? compiler.default?.build;
  const compilerVersion = compiler.version ?? compiler.default?.version;
  assert.equal(typeof build, 'function', 'Invalid compiler');
  assert.equal(compilerVersion, '0.28.2', 'Reviewed compiler version required');
  const protectedPaths = [...new Set([
    ...Object.values(specs).map(spec => spec.rollback),
    'plugins/agent-self-heal/lib/index-v2-persistence.mjs',
  ])];
  const rollbackHashes = Object.fromEntries(await Promise.all(protectedPaths.map(async path => {
    const bytes = await maybeRead(join(repoRoot, path));
    assert(bytes !== undefined, 'Required rollback artifact missing');
    return [path, sha(bytes)];
  })));
  const pending = [];
  const owner = specs.selfHeal;
  const ownerOutput = join(repoRoot, owner.output), ownerManifest = ownerOutput.replace(/\.mjs$/, '.build.json');
  const ownerBytes = await maybeRead(ownerOutput), ownerRecordBytes = await maybeRead(ownerManifest);
  assert(ownerBytes !== undefined && ownerRecordBytes !== undefined, 'Existing immutable owner and build record required');
  const ownerRecord = JSON.parse(ownerRecordBytes);
  assert.deepEqual(Object.keys(ownerRecord).sort(), ['schema', 'output', 'sha256', 'sourceHashes', 'compilerVersion', 'target', 'rollbackSha256'].sort(), 'Owner build record fields differ');
  assert.equal(ownerRecord.schema, 1); assert.equal(ownerRecord.output, owner.output.split('/').at(-1));
  assert.equal(ownerRecord.compilerVersion, compilerVersion); assert.equal(ownerRecord.target, 'node24');
  assert.equal(ownerRecord.rollbackSha256, rollbackHashes[owner.rollback], 'Owner rollback drift');
  assert.equal(sha(ownerBytes), ownerRecord.sha256, 'Owner artifact hash differs');
  assert(ownerRecord.sourceHashes && typeof ownerRecord.sourceHashes === 'object' && !Array.isArray(ownerRecord.sourceHashes) && Object.hasOwn(ownerRecord.sourceHashes, owner.entry), 'Owner entry source record required');
  for (const [path, expected] of Object.entries(ownerRecord.sourceHashes)) {
    assert(path === 'plugins/common.mjs' || /^(?:plugins\/agent-self-heal|plugins\/llm-resilience)\/(?!lib\/)[a-zA-Z0-9_-]+\.mjs$/.test(path), 'Unexpected owner source');
    assert.match(expected, /^[a-f0-9]{64}$/);
    const bytes = await maybeRead(join(repoRoot, path));
    assert(bytes !== undefined && sha(bytes) === expected, 'Owner source closure changed; a separately reviewed new owner is required');
  }
  for (const [name, spec] of Object.entries(specs)) {
    if (name === 'selfHeal') continue;
    const sources = new Map();
    const result = await build({
      entryPoints: [join(repoRoot, spec.entry)], absWorkingDir: repoRoot,
      bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24', write: false, metafile: true,
      plugins: [{ name: 'immutable-own-source-snapshot', setup(builder) {
        builder.onLoad({ filter: /\.mjs$/ }, async args => {
          assert.equal(args.path, await realpath(args.path), 'Symlink source refused');
          const path = relative(repoRoot, args.path).split(sep).join('/');
          assert(path === 'plugins/common.mjs' ||
            ['plugins/llm-resilience/', 'plugins/agent-self-heal/'].some(prefix => path.startsWith(prefix) && !path.slice(prefix.length).startsWith('lib/')), 'Unexpected bundled module');
          const bytes = await readFile(args.path);
          sources.set(path, { bytes, sha256: sha(bytes) });
          return { contents: bytes.toString('utf8'), loader: 'js', resolveDir: dirname(args.path) };
        });
      } }],
    });
    assert.equal(result.outputFiles.length, 1, 'One closed artifact required');
    assert(sources.has(spec.entry), 'Compiler must capture the entry source');
    assert.deepEqual(Object.keys(result.metafile.inputs).sort(), [...sources.keys()].sort(), 'Uncaptured build dependency');
    const sourceHashes = Object.fromEntries([...sources].sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => [path, value.sha256]));
    for (const [path, expected] of Object.entries(sourceHashes)) assert.equal(sha(await readFile(join(repoRoot, path))), expected, 'Source changed during compilation');
    const bytes = result.outputFiles[0].contents;
    const output = join(repoRoot, spec.output), manifest = output.replace(/\.mjs$/, '.build.json');
    const record = { schema: 1, output: spec.output.split('/').at(-1), sha256: sha(bytes), sourceHashes, compilerVersion, target: 'node24', rollbackSha256: rollbackHashes[spec.rollback] };
    const recordBytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
    const oldOutput = await maybeRead(output), oldRecord = await maybeRead(manifest);
    if (oldOutput !== undefined) assert.equal(sha(oldOutput), record.sha256, 'Immutable artifact differs; use a new version');
    if (oldRecord !== undefined) assert(oldRecord.equals(recordBytes), 'Immutable build record differs');
    pending.push({ name, output, manifest, bytes, recordBytes, oldOutput, oldRecord, record });
  }
  // Check the entire source/rollback set before the first new artifact write.
  for (const item of pending) for (const [path, expected] of Object.entries(item.record.sourceHashes)) assert.equal(sha(await readFile(join(repoRoot, path))), expected, 'Build inputs changed');
  async function verifyOwner() {
    assert((await maybeRead(ownerOutput))?.equals(ownerBytes), 'Owner artifact changed');
    assert((await maybeRead(ownerManifest))?.equals(ownerRecordBytes), 'Owner build record changed');
    for (const [path, expected] of Object.entries(ownerRecord.sourceHashes)) assert.equal(sha(await maybeRead(join(repoRoot, path))), expected, 'Owner source changed during build');
  }
  await verifyOwner();
  for (const [path, expected] of Object.entries(rollbackHashes)) assert.equal(sha(await readFile(join(repoRoot, path))), expected, 'Rollback artifact changed');
  const artifacts = {};
  for (const item of pending) {
    await mkdir(dirname(item.output), { recursive: true });
    assert.equal(await realpath(dirname(item.output)), dirname(item.output), 'Symlink output directory refused');
    if (item.oldOutput === undefined) await writeFile(item.output, item.bytes, { flag: 'wx', mode: 0o644 });
    if (item.oldRecord === undefined) await writeFile(item.manifest, item.recordBytes, { flag: 'wx', mode: 0o644 });
    assert.equal(sha(await readFile(item.output)), item.record.sha256);
    assert((await readFile(item.manifest)).equals(item.recordBytes));
    artifacts[item.name] = { ...item.record, output: item.output, manifest: item.manifest, reused: item.oldOutput !== undefined && item.oldRecord !== undefined };
  }
  for (const [path, expected] of Object.entries(rollbackHashes)) assert.equal(sha(await readFile(join(repoRoot, path))), expected, 'Rollback changed after build');
  await verifyOwner();
  artifacts.selfHeal = { ...ownerRecord, output: ownerOutput, manifest: ownerManifest, reused: true };
  return { schema: 1, kind: 'unified-recovery-build', artifacts, compiler: compilerPath, rollbackHashes, modelCalls: 0, profilesModified: false, multiFileAtomic: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === '--help') console.log('Usage: node tools/resilience/build-unified-recovery.mjs --esbuild /absolute/esbuild/lib/main.js');
    else { assert.equal(args.length, 2); assert.equal(args[0], '--esbuild'); console.log(JSON.stringify(await buildUnifiedRecovery({ esbuildModule: args[1] }), null, 2)); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
