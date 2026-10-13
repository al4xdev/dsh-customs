import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { baselineCodexHash } from './codex-failure-categories.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const prefixes = ['dist/api/openai-codex-responses', 'dist/index', 'dist/utils/provider-failure'];
const expected = prefixes.flatMap(prefix => ['.js', '.js.map', '.d.ts', '.d.ts.map'].map(suffix => prefix + suffix));

/** Read-only preflight: verify compiler source, candidate bytes and exact active before-state. */
export async function verifyCodexFailureCandidate(manifestPath) {
  const path = await realpath(manifestPath), output = dirname(path);
  const bytes = await readFile(path), manifest = JSON.parse(bytes);
  assert.equal(manifest.kind, 'codex-failure-categories-candidate'); assert.equal(manifest.promoted, false);
  const installed = await realpath(manifest.installedRoot), candidate = await realpath(manifest.candidate);
  assert.equal(installed, manifest.installedRoot); assert.equal(candidate, join(output, 'package'));
  assert.equal(manifest.baselineCodexHash, baselineCodexHash);
  assert.deepEqual(manifest.generated.map(file => file.path).sort(), expected.slice().sort());
  const sourceRoot = join(output, 'source/packages/ai');
  for (const file of manifest.sourceFiles) {
    assert(['src/api/openai-codex-responses.ts', 'src/index.ts', 'src/utils/provider-failure.ts'].includes(file.path));
    assert.equal(sha(await readFile(join(sourceRoot, file.path))), file.afterSha256, 'Compiled source changed after receipt');
  }
  assert.equal(manifest.sourceFiles.length, 3);
  const source = Object.fromEntries(manifest.sourceFiles.map(file => [file.path, file.afterSha256]));
  const digest = sha(JSON.stringify({ baseline: baselineCodexHash, codex: source['src/api/openai-codex-responses.ts'], helper: source['src/utils/provider-failure.ts'], index: source['src/index.ts'] }));
  assert.equal(digest, manifest.sourceDigest);
  const targets = [];
  for (const file of manifest.generated) {
    const generated = await readFile(join(sourceRoot, file.path));
    assert.equal(sha(generated), file.afterSha256, 'Compiler output no longer matches receipt');
    const current = await readFile(join(candidate, file.path));
    assert(current.equals(generated), 'Candidate output is not compiler-produced');
    let before;
    try { before = sha(await readFile(join(installed, file.path))); } catch (error) { if (error.code !== 'ENOENT') throw error; before = null; }
    assert.equal(before, file.beforeSha256, `Active SDK changed before promotion: ${file.path}`);
    targets.push({ target: join(installed, file.path), candidate: join(candidate, file.path), beforeSha256: before, afterSha256: file.afterSha256, changed: file.changed });
  }
  for (const file of manifest.protectedFiles) {
    assert(!expected.includes(file.path)); assert(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
    assert.equal(sha(await readFile(join(installed, file.path))), file.sha256, `Protected installed output changed: ${file.path}`);
    assert.equal(sha(await readFile(join(candidate, file.path))), file.sha256, `Protected candidate output changed: ${file.path}`);
  }
  const activeMetadata = await readFile(join(installed, 'package.json')), candidateMetadata = await readFile(join(candidate, 'package.json'));
  assert(activeMetadata.equals(candidateMetadata), 'Thin rollout must not stamp package metadata');
  return { kind: 'codex-failure-candidate-readonly-preflight', manifestSha256: sha(bytes), sourceDigest: digest,
    featureVariant: manifest.proposedVersion, packageVersion: JSON.parse(activeMetadata).version, packageMetadataUnchanged: true,
    targets, protectedSdkFiles: manifest.protectedFiles.length, promoted: false };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 3, 'Usage: node verify-codex-failure-candidate.mjs candidate-manifest.json');
  console.log(JSON.stringify(await verifyCodexFailureCandidate(resolve(process.argv[2])), null, 2));
}
