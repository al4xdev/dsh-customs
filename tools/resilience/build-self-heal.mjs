#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const defaultRepo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Immutable versioned output: never overwrite the active or rollback bundle. */
export async function buildSelfHeal({ repoRoot = defaultRepo, esbuildModule } = {}) {
  assert.equal(repoRoot, await realpath(repoRoot), 'Repository must be canonical');
  assert.equal(esbuildModule, resolve(esbuildModule), 'Use an explicit existing compiler module');
  const compiler = await import(pathToFileURL(await realpath(esbuildModule)).href);
  const build = compiler.build ?? compiler.default?.build;
  assert.equal(typeof build, 'function', 'Invalid esbuild module');
  const paths = ['plugins/common.mjs', ...['index.mjs', 'logic.mjs', 'sanitizer.mjs', 'persistence.mjs'].map(name => 'plugins/agent-self-heal/' + name)];
  const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(repoRoot, path)))])));
  const before = await hashes();
  const rollback = join(repoRoot, 'plugins/agent-self-heal/lib/index-v2-persistence.mjs');
  const rollbackSha256 = sha(await readFile(rollback));
  const result = await build({ entryPoints: [join(repoRoot, 'plugins/agent-self-heal/index.mjs')],
    absWorkingDir: repoRoot, bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node24', write: false,
  });
  assert.deepEqual(await hashes(), before, 'Sources changed during build');
  assert.equal(result.outputFiles.length, 1);
  const bytes = result.outputFiles[0].contents;
  const output = join(repoRoot, 'plugins/agent-self-heal/lib/index-v3-resilience.mjs');
  let reused = false;
  try { const old = await readFile(output); assert.equal(sha(old), sha(bytes), 'Versioned output already differs; refuse overwrite'); reused = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(output, bytes, { flag: 'wx', mode: 0o644 }); }
  assert.equal(sha(await readFile(output)), sha(bytes));
  assert.equal(sha(await readFile(rollback)), rollbackSha256, 'Rollback bundle changed');
  const manifest = output.replace(/\.mjs$/, '.build.json');
  const buildRecord = JSON.stringify({ schema: 1, output: 'index-v3-resilience.mjs', sha256: sha(bytes), sourceHashes: before,
    compilerVersion: compiler.version ?? compiler.default?.version, target: 'node24', rollbackSha256 }, null, 2) + '\n';
  try { assert.equal(await readFile(manifest, 'utf8'), buildRecord, 'Versioned build manifest differs'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(manifest, buildRecord, { flag: 'wx', mode: 0o644 }); }
  return { schema: 1, kind: 'self-heal-resilience-build', output, sha256: sha(bytes), sourceHashes: before,
    manifest, compiler: await realpath(esbuildModule), rollback, rollbackSha256, rollbackUnchanged: true, reused, modelCalls: 0, profilesModified: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === '--help') console.log('Usage: node tools/resilience/build-self-heal.mjs --esbuild /absolute/existing/esbuild/lib/main.js');
    else { assert.equal(args.length, 2); assert.equal(args[0], '--esbuild'); console.log(JSON.stringify(await buildSelfHeal({ esbuildModule: args[1] }), null, 2)); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
