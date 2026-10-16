#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRepo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const REVIEWED_COMPILER = '0.28.2';
// Contract 3: controller6 + owner7, both compiled from the current sources.
// Each rollback is the previous immutable pair member (controller5 / owner6).
export const specs = Object.freeze({
  controller: Object.freeze({ entry: 'plugins/llm-resilience/index.mjs', output: 'plugins/llm-resilience/lib/index-v6-unified.mjs', rollback: 'plugins/llm-resilience/lib/index-v5-unified.mjs' }),
  selfHeal: Object.freeze({ entry: 'plugins/agent-self-heal/index.mjs', output: 'plugins/agent-self-heal/lib/index-v7-unified.mjs', rollback: 'plugins/agent-self-heal/lib/index-v6-unified.mjs' }),
});
// Older immutable artifacts that must never change either (historical rollback
// chain). Their sidecars, where they exist, are protected byte-for-byte too.
export const HISTORICAL = Object.freeze([
  'plugins/llm-resilience/lib/index-v1-resilience.mjs',
  'plugins/agent-self-heal/lib/index-v3-resilience.mjs',
  'plugins/agent-self-heal/lib/index-v2-persistence.mjs',
]);
const RECORD_KEYS = ['schema', 'output', 'sha256', 'sourceHashes', 'compilerVersion', 'target', 'rollbackSha256'].sort();

async function maybeRead(path) {
  try {
    const stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Regular immutable artifact required');
    assert.equal(await realpath(path), path, 'Symlink artifact path refused');
    return await readFile(path);
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const sidecarOf = path => path.replace(/\.mjs$/, '.build.json');

/** Closed own-module bundles avoid cached ESM leaves after profile-only HMR.
 * Both contract-3 artifacts are reproducible from the current sources; an
 * existing artifact is reused only when byte-identical, never overwritten.
 * Each rollback artifact must still match its own reviewed sidecar hash, and
 * every protected artifact is re-verified before the first and after the last
 * write. Publication into profiles remains a separate guarded operation.
 */
export async function buildUnifiedRecovery({ repoRoot = defaultRepo, esbuildModule } = {}) {
  assert.equal(repoRoot, await realpath(repoRoot), 'Repository must be canonical');
  assert.equal(esbuildModule, resolve(esbuildModule), 'Explicit compiler module required');
  const compilerPath = await realpath(esbuildModule);
  const compiler = await import(pathToFileURL(compilerPath).href);
  const build = compiler.build ?? compiler.default?.build;
  const compilerVersion = compiler.version ?? compiler.default?.version;
  assert.equal(typeof build, 'function', 'Invalid compiler');
  assert.equal(compilerVersion, REVIEWED_COMPILER, 'Reviewed compiler version required');
  // Rollbacks: artifact AND sidecar must exist, and the artifact must still be
  // exactly what its sidecar recorded (no drifted rollback can be published).
  const protectedPaths = [];
  const rollbackHashes = {};
  for (const spec of Object.values(specs)) {
    const bytes = await maybeRead(join(repoRoot, spec.rollback));
    const recordBytes = await maybeRead(join(repoRoot, sidecarOf(spec.rollback)));
    assert(bytes !== undefined && recordBytes !== undefined, 'Required rollback artifact and build record missing');
    const record = JSON.parse(recordBytes);
    assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS, 'Rollback build record fields differ');
    assert.equal(record.output, spec.rollback.split('/').at(-1), 'Rollback build record output differs');
    assert.equal(sha(bytes), record.sha256, 'Rollback artifact differs from its reviewed build record');
    rollbackHashes[spec.rollback] = sha(bytes);
    protectedPaths.push(spec.rollback, sidecarOf(spec.rollback));
  }
  for (const path of HISTORICAL) {
    const bytes = await maybeRead(join(repoRoot, path));
    assert(bytes !== undefined, 'Required historical artifact missing');
    rollbackHashes[path] = sha(bytes);
    protectedPaths.push(path);
    if (await maybeRead(join(repoRoot, sidecarOf(path))) !== undefined) protectedPaths.push(sidecarOf(path));
  }
  const protectedBytes = new Map();
  for (const path of protectedPaths) protectedBytes.set(path, await maybeRead(join(repoRoot, path)));
  async function verifyProtected(stage) {
    for (const [path, bytes] of protectedBytes) assert((await maybeRead(join(repoRoot, path)))?.equals(bytes), `Protected artifact changed ${stage}`);
  }
  const pending = [];
  for (const [name, spec] of Object.entries(specs)) {
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
    const output = join(repoRoot, spec.output), manifest = sidecarOf(output);
    const record = { schema: 1, output: spec.output.split('/').at(-1), sha256: sha(bytes), sourceHashes, compilerVersion, target: 'node24', rollbackSha256: rollbackHashes[spec.rollback] };
    const recordBytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
    const oldOutput = await maybeRead(output), oldRecord = await maybeRead(manifest);
    if (oldOutput !== undefined) assert.equal(sha(oldOutput), record.sha256, 'Immutable artifact differs; use a new version');
    if (oldRecord !== undefined) assert(oldRecord.equals(recordBytes), 'Immutable build record differs');
    pending.push({ name, output, manifest, bytes, recordBytes, oldOutput, oldRecord, record });
  }
  // Check the entire source/rollback set before the first new artifact write.
  for (const item of pending) for (const [path, expected] of Object.entries(item.record.sourceHashes)) assert.equal(sha(await readFile(join(repoRoot, path))), expected, 'Build inputs changed');
  await verifyProtected('before publication');
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
  await verifyProtected('after publication');
  return { schema: 1, kind: 'unified-recovery-build', contract: 3, artifacts, compiler: compilerPath, rollbackHashes, modelCalls: 0, profilesModified: false, multiFileAtomic: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === '--help') console.log('Usage: node tools/resilience/build-unified-recovery.mjs --esbuild /absolute/esbuild/lib/main.js');
    else { assert.equal(args.length, 2); assert.equal(args[0], '--esbuild'); console.log(JSON.stringify(await buildUnifiedRecovery({ esbuildModule: args[1] }), null, 2)); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
