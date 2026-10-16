import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { packResult, sourceInventory, verifySource, preparePi, piVersion, oauthSeams } from './pi.mjs';
import { apis as failureApis, prefixes as failurePrefixes, suffixes as failureSuffixes } from '../pi-ai-fork/generalized-failure-categories.mjs';

net.Socket.prototype.connect = function () { throw new Error('Real network forbidden in Pi preparation fixtures'); };
tls.connect = () => { throw new Error('Real TLS forbidden in Pi preparation fixtures'); };
globalThis.fetch = () => { throw new Error('Real fetch forbidden in Pi preparation fixtures'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
import { baselineCodexHash } from '../pi-ai-fork/codex-failure-categories.mjs';

async function preparationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-generalized-test-'));
  t.after(async () => {
    assert(root.startsWith(join(tmpdir(), 'pi-generalized-test-')));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true });
  });
  const sourceRoot = join(root, 'source'), dependencyRoot = join(root, 'deps'), seedNodeModules = join(root, 'seed'), artifactsRoot = join(root, 'artifacts');
  const ai = join(sourceRoot, 'packages/ai');
  const put = async (path, bytes) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); };
  // Real reviewed API/index inputs, not miniature substitutes for the thirteen
  // baseline checks. Only packaging/compiler/catalog plumbing is simulated.
  for (const prefix of failurePrefixes.filter(prefix => prefix !== 'dist/utils/provider-failure')) {
    const relative = prefix.replace(/^dist\//, 'src/') + '.ts';
    await put(join(ai, relative), await readFile(new URL('../../sources/pi-ai/packages/ai/' + relative, import.meta.url)));
  }
  await put(join(ai, 'src/utils/unary-deadline-sentinel.ts'), 'export const untouchedDeadline = 64000;\n');
  await put(join(ai, 'src/auth/oauth/openai-codex.ts'), 'fixture OAuth public source must stay unchanged\n');
  await put(join(ai, 'src/providers/data/obsolete.json'), '{"mustNotBePackaged":true}\n');
  await put(join(ai, 'scripts/model-data.ts'), 'export const readModelDataStructure = () => ({});\nexport const createModelDataManifest = (_structure, contents, generatedAt) => ({generatedAt, files:Object.keys(contents)});\n');
  await put(join(ai, 'scripts/check-model-data.ts'), '// Mocked validator command; no external I/O.\n');
  await put(join(ai, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.87.1', type: 'module', dependencies: {} }));
  await put(join(ai, 'README.md'), 'Fixture public README\n');
  await put(join(ai, 'tsconfig.build.json'), '{}');
  await put(join(sourceRoot, 'package.json'), '{"type":"module"}');
  await put(join(sourceRoot, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@typescript/native-preview': { version: 'fixture-compiler' } } }));
  await put(join(sourceRoot, 'LICENSE'), 'Fixture license notice\n');
  await put(join(sourceRoot, 'packages/telemetry/package.json'), '{"name":"@earendil-works/pi-telemetry"}');
  await put(join(sourceRoot, 'SOURCE-PROVENANCE.json'), JSON.stringify({ kind: 'verified-source-snapshot-not-a-git-checkout', currentGitHead: null, codexSourceHash: baselineCodexHash, historicalSourceCommit: 'f5a24c96d72732ba63aeca9a02295c320db04c2d' }));
  await put(join(dependencyRoot, '@typescript/native-preview/package.json'), '{"version":"fixture-compiler"}');
  await mkdir(join(dependencyRoot, '@earendil-works'), { recursive: true });
  await put(join(seedNodeModules, '@earendil-works/pi-ai/package.json'), '{"version":"0.87.1"}');
  await put(join(seedNodeModules, '@earendil-works/pi-telemetry/package.json'), '{"version":"fixture-telemetry"}');
  const donorCatalog = join(seedNodeModules, '@earendil-works/pi-ai/dist/providers/data');
  const catalogBytes = '{ "publicModel": "fixture", "contextWindow": 128000 }\n';
  await put(join(donorCatalog, 'fixture.json'), catalogBytes);
  await put(join(donorCatalog, '.manifest.json'), '{"generatedAt":"fixture-public-stamp"}');
  return { root, sourceRoot, dependencyRoot, seedNodeModules, artifactsRoot, ai, put, catalogBytes };
}

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

test('portable preparation generalizes all ten APIs before compiler and records all fingerprints without historical dumps', async t => {
  const fixture = await preparationFixture(t);
  const { sourceRoot, dependencyRoot, seedNodeModules, artifactsRoot, catalogBytes } = fixture;
  const before = await sourceInventory(sourceRoot), calls = [];
  const expectedFiles = [...oauthSeams, ...failurePrefixes.flatMap(prefix => failureSuffixes.map(suffix => prefix + suffix))];
  const runner = (command, args, { cwd }) => {
    calls.push({ command, args, cwd });
    if (command === process.execPath && args[0].endsWith('/check-model-data.ts')) return '';
    if (command === process.execPath && args[0].endsWith('/tsgo.js')) {
      if (cwd.endsWith('/packages/telemetry')) return '';
      assert.equal(cwd, join(artifactsRoot, 'build/packages/ai'));
      for (const api of failureApis) {
        const source = readFileSync(join(cwd, 'src/api/' + api + '.ts'), 'utf8');
        assert.equal(source.split('reportProviderFailure(').length - 1, 1, api);
        assert(!source.includes('reportCodexFailure('), api);
      }
      assert(readFileSync(join(cwd, 'src/api/openai-responses-shared.ts'), 'utf8').includes('{ payload: event }'));
      assert.equal(readFileSync(join(cwd, 'src/utils/unary-deadline-sentinel.ts'), 'utf8'), 'export const untouchedDeadline = 64000;\n');
      assert.equal(readFileSync(join(cwd, 'src/auth/oauth/openai-codex.ts'), 'utf8'), 'fixture OAuth public source must stay unchanged\n');
      // Packaging simulation only: real cached TypeScript compilation is covered
      // by the SDK gate. Use distinct output bytes to check every fingerprint.
      for (const name of expectedFiles) {
        const target = join(cwd, name); mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, 'fixture-compiler-output:' + name);
      }
      return '';
    }
    assert.equal(command, 'npm'); assert.deepEqual(args.slice(0, 3), ['pack', '--ignore-scripts', '--json']);
    assert.equal(cwd, join(artifactsRoot, 'package'));
    assert.equal(readFileSync(join(cwd, 'dist/providers/data/fixture.json'), 'utf8'), catalogBytes);
    assert.throws(() => readFileSync(join(cwd, 'dist/providers/data/obsolete.json')), { code: 'ENOENT' });
    writeFileSync(join(artifactsRoot, 'fixture-pi.tgz'), 'fixture archive bytes');
    return JSON.stringify([{ filename: 'fixture-pi.tgz', integrity: 'sha512-fixture' }]);
  };
  const proof = await preparePi({ sourceRoot, dependencyRoot, seedNodeModules, artifactsRoot, expectedSourceDigest: before.sourceDigest }, { runner });
  assert.deepEqual(await sourceInventory(sourceRoot), before, 'Input source snapshot must remain immutable');
  assert.deepEqual(proof.providerFailureApis, failureApis);
  assert.equal(proof.providerFailureSourceFiles.length, 13);
  assert.equal(proof.providerFailureReviewedSourceDigest, '84608e042e01e90b6b00eeab2e981a58bd5ca168274958f3d826738acdec5be4');
  assert.notEqual(proof.providerFailureSourceDigest, proof.providerFailureReviewedSourceDigest, 'Current helper input must not claim old Task38 before-hash');
  assert.equal(proof.providerFailureSourceDigest, sha(JSON.stringify(proof.providerFailureSourceFiles.slice().sort((a, b) => a.path.localeCompare(b.path)))));
  assert.equal(Object.keys(proof.compiledFingerprints).length, 58);
  for (const name of expectedFiles) assert.equal(proof.compiledFingerprints[name], sha(await readFile(join(artifactsRoot, 'package', name))));
  assert.equal(proof.observerVersion, 1); assert.equal(proof.hostSdkCopied, false); assert.equal(proof.telemetrySourceCompiled, true);
  assert.equal(proof.helperSourceHash, sha(await readFile(new URL('../pi-ai-fork/provider-failure.ts', import.meta.url))));
  assert.equal(calls.length, 4); assert(!JSON.stringify(calls).includes('.dumps/'));
  assert.deepEqual(JSON.parse(await readFile(join(artifactsRoot, 'provenance.json'), 'utf8')), JSON.parse(JSON.stringify(proof)));
  await assert.rejects(preparePi({ sourceRoot, dependencyRoot, seedNodeModules, artifactsRoot, expectedSourceDigest: before.sourceDigest }, { runner }), { code: 'EEXIST' });
});

test('generalized API drift refuses portable packaging before compiler or npm rather than publishing Codex-only coverage', async t => {
  const fixture = await preparationFixture(t);
  const path = join(fixture.ai, 'src/api/google-vertex.ts');
  await writeFile(path, await readFile(path, 'utf8') + '\n// unreviewed change\n');
  const sealed = (await sourceInventory(fixture.sourceRoot)).sourceDigest;
  let spawned = false;
  await assert.rejects(preparePi({ sourceRoot: fixture.sourceRoot, dependencyRoot: fixture.dependencyRoot, seedNodeModules: fixture.seedNodeModules, artifactsRoot: fixture.artifactsRoot, expectedSourceDigest: sealed }, { runner() { spawned = true; throw new Error('No compiler/npm expected'); } }), /Reconstructed Task38 baseline changed: src\/api\/google-vertex.ts/);
  assert.equal(spawned, false);
  await assert.rejects(readFile(join(fixture.artifactsRoot, 'provenance.json')), { code: 'ENOENT' });
});
