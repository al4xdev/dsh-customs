import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { inventory, compareInventories, packageNames, runInventoryCommand } from './inventory.mjs';

async function file(path, contents) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, contents); }
async function fixture({ fallback = false, duplicatePi = false, missingCode = false, secretName = false, restrictedPi = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-public-inventory-')), runtimeRoot = join(root, 'runtime'), repoRoot = join(root, 'repo');
  await mkdir(runtimeRoot); await mkdir(repoRoot);
  const roots = {};
  for (const [id, name] of Object.entries(packageNames)) {
    const packageRoot = fallback && ['tui', 'antigravity'].includes(id) ? join(repoRoot, id === 'tui' ? 'frontend/dsh-tui' : 'plugins/dsh-antigravity') : join(runtimeRoot, 'node_modules', name);
    roots[id] = packageRoot;
    const metadata = { name: secretName && id === 'adapter' ? 'SECRET_NAME_CANARY' : name, version: '0.2.0-rc.2', exports: { './package.json': './package.json', '.': './index.js' }, secret: 'SECRET_VALUE_CANARY', scripts: { prepare: 'touch MUST_NEVER_EXECUTE' }, auth: { token: 'PRIVATE_AUTH_CANARY' } };
    if (restrictedPi && id === 'pi') metadata.exports = { '.': { import: './index.js' } };
    await file(join(packageRoot, 'package.json'), JSON.stringify(metadata));
    // The fixture would throw if inventory imported/evaluated any package.
    await file(join(packageRoot, 'index.js'), 'throw new Error("PACKAGE_MUST_NOT_EXECUTE");');
  }
  if (fallback) await symlink(join(runtimeRoot, 'node_modules'), join(repoRoot, 'node_modules'));
  const code = { session: ['lib/index.js', 'lib/types/known-event-types.js'], pi: ['dist/index.js', 'dist/api/openai-codex-responses.js', 'dist/utils/provider-failure.js'], antigravity: ['lib/index.js'], tui: ['index.js', 'index.d.ts', 'index.d.ts.map', 'profiles.js', 'profiles.d.ts', 'profiles.d.ts.map'].map(name => 'lib/types/dsh-adapter/oauth/' + name) };
  for (const [id, files] of Object.entries(code)) for (const path of files) {
    if (missingCode && id === 'pi' && path.endsWith('/provider-failure.js')) continue;
    await file(join(roots[id], path), 'public compiled static markers: agent/self-heal subscribeProviderFailures reportCodexFailure retryPolicies convertMessages isThinkingPart retainThoughtSignature');
  }
  const sources = { tui: fallback ? roots.tui : join(repoRoot, 'tui-source'), antigravity: fallback ? roots.antigravity : join(repoRoot, 'ag-source'), pi: join(repoRoot, 'pi-source'), selfheal: join(repoRoot, 'selfheal-source'), resilience: join(repoRoot, 'resilience-source') };
  const sourceFiles = { tui: ['src/dsh-adapter/oauth/index.ts', 'src/dsh-adapter/oauth/profiles.ts'], antigravity: ['src/index.ts', 'src/api.ts', 'src/failure.ts', 'src/failure-bridge.ts'], pi: ['packages/ai/src/index.ts', 'packages/ai/src/api/openai-codex-responses.ts'], selfheal: ['index.mjs', 'logic.mjs', 'sanitizer.mjs', 'persistence.mjs', 'state-schema.mjs', 'lib/index-v2-persistence.mjs', 'lib/index-v3-resilience.mjs', 'lib/index-v6-unified.mjs', 'lib/index-v6-unified.build.json', 'lib/index-v7-unified.mjs', 'lib/index-v7-unified.build.json'], resilience: ['index.mjs', 'policy.mjs', 'controller.mjs', 'main-driver.mjs', 'aux-driver.mjs', 'recovery-accounting.mjs', 'lib/index-v1-resilience.mjs', 'lib/index-v5-unified.mjs', 'lib/index-v5-unified.build.json', 'lib/index-v6-unified.mjs', 'lib/index-v6-unified.build.json'] };
  for (const [id, paths] of Object.entries(sourceFiles)) for (const path of paths) await file(join(sources[id], path), 'public source assertPersistenceCompatible harness warning: llmRecoveryUnbounded');
  for (const path of ['plugins/common.mjs', 'tools/pi-ai-fork/provider-failure.ts', 'tools/pi-ai-fork/codex-failure-categories.mjs']) await file(join(repoRoot, path), 'public portable recipe');
  await file(join(repoRoot, '.dsh/auth.json'), 'DO_NOT_READ_PRIVATE_AUTH');
  await file(join(repoRoot, '.dumps/session.jsonl'), 'DO_NOT_READ_PRIVATE_HISTORY');
  if (duplicatePi) await file(join(roots.antigravity, 'node_modules', packageNames.pi, 'package.json'), JSON.stringify({ name: packageNames.pi, version: '0.2.0-rc.2' }));
  return { root, roots, runtimeRoot, repoRoot, sources };
}

test('public inventory reads selected metadata/code only and never executes package modules', async () => {
  const result = inventory(await fixture());
  assert.deepEqual(result.blockers, []);
  assert.equal(Object.keys(result.packages).length, 11);
  assert.equal(Object.keys(result.code).length, 23);
  assert(Object.values(result.identity).every(peer => peer.shared));
  assert(Object.values(result.features).every(Boolean));
  const output = JSON.stringify(result);
  for (const canary of ['SECRET_VALUE_CANARY', 'PRIVATE_AUTH_CANARY', 'DO_NOT_READ_PRIVATE_AUTH', 'DO_NOT_READ_PRIVATE_HISTORY', 'MUST_NEVER_EXECUTE']) assert(!output.includes(canary));
  assert.deepEqual(Object.keys(result.packages.adapter).sort(), ['manifest', 'name', 'origin', 'version']);
});

test('relocated identical trees compare exact public parity without equating absolute paths', async () => {
  const host = inventory(await fixture()), container = inventory(await fixture());
  assert.notEqual(host.packages.pi.manifest, container.packages.pi.manifest);
  const comparison = compareInventories(host, container);
  assert.equal(comparison.exactPublicParity, true);
  assert.equal(comparison.identicalVersions, true);
  assert.equal(comparison.sharedIdentity, true);
});

test('import-only Pi exports do not block confined anchored package metadata inspection', async () => {
  const input = await fixture({ restrictedPi: true });
  const result = inventory(input);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.identity.pi.sharedRuntime, true);
  assert(Object.values(result.graph).every(peers => peers.pi === result.packages.pi.manifest));
  assert.equal(compareInventories(result, result).exactPublicParity, true);
});

test('exports-restricted nearest nested Pi remains a real installed-runtime split', async () => {
  const input = await fixture({ restrictedPi: true });
  const nested = join(input.roots.adapter, 'node_modules', packageNames.pi, 'package.json');
  await file(nested, JSON.stringify({ name: packageNames.pi, version: '0.2.0-rc.2', exports: { '.': { import: './no-entry-evaluation.js' } } }));
  const result = inventory(input);
  assert.equal(result.graph.adapter.pi, nested);
  assert.equal(result.identity.pi.sharedRuntime, false);
  assert(result.blockers.some(item => item.item === 'identity:pi'));
});

test('source-build splits remain visible without inventing an installed-runtime failure', async () => {
  const input = await fixture({ fallback: true, restrictedPi: true });
  for (const peer of ['cordis', 'scope', 'pi']) await file(join(input.roots.tui, 'node_modules', packageNames[peer], 'package.json'), JSON.stringify({ name: packageNames[peer], version: '0.2.0-rc.2', exports: { '.': { import: './not-loaded.js' } } }));
  const result = inventory(input);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.graphContext.tui, 'source-build-resolution-only');
  for (const peer of ['cordis', 'scope', 'pi']) {
    assert.equal(result.identity[peer].sharedRuntime, true);
    assert.equal(result.identity[peer].shared, false);
    assert.equal(result.identity[peer].physicalCopies.length, 2);
    assert.equal(result.identity[peer].runtimePhysicalCopies.length, 1);
  }
  const comparison = compareInventories(result, inventory(await fixture()));
  assert.equal(comparison.sharedIdentity, true);
  assert.equal(comparison.allConsumerIdentity, false);
  assert.deepEqual(comparison.sourceFallbackConsumers.host, ['tui', 'antigravity']);
  assert.match(comparison.qualification, /not activation/);
});

test('exports metadata fallback refuses a nearer unconfined SDK instead of hiding it', async () => {
  const input = await fixture({ restrictedPi: true });
  const outside = join(input.root, 'outside-peer');
  await file(join(outside, 'package.json'), JSON.stringify({ name: packageNames.pi, version: '0.2.0-rc.2', exports: { '.': { import: './private.js' } }, secret: 'OUTSIDE_PEER_SECRET_CANARY' }));
  const nested = join(input.roots.adapter, 'node_modules', packageNames.pi);
  await mkdir(dirname(nested), { recursive: true }); await symlink(outside, nested);
  const result = inventory(input);
  assert.equal(result.graph.adapter.pi, null);
  assert.equal(result.identity.pi.sharedRuntime, false);
  assert(result.blockers.some(item => item.item === 'peer:adapter:pi' && item.reason === 'invalid-or-unconfined'));
  assert(!JSON.stringify(result).includes('OUTSIDE_PEER_SECRET_CANARY'));
});

test('split physical SDK is an explicit blocker even when package versions match', async () => {
  const result = inventory(await fixture({ duplicatePi: true }));
  assert.equal(result.identity.pi.shared, false);
  assert.equal(result.identity.pi.physicalCopies.length, 2);
  assert(result.blockers.some(item => item.item === 'identity:pi'));
  const comparison = compareInventories(inventory(await fixture()), result);
  assert.equal(comparison.identicalVersions, true);
  assert.equal(comparison.sharedIdentity, false);
  assert.equal(comparison.exactPublicParity, false);
});

test('missing observer output remains missing rather than treating a version pin as acceptance', async () => {
  const result = inventory(await fixture({ missingCode: true }));
  assert.equal(result.code['pi/dist/utils/provider-failure.js'], null);
  assert.equal(result.features.observer38, false);
  assert(result.blockers.some(item => item.item === 'feature:observer38'));
  assert.equal(compareInventories(result, result).exactPublicParity, false);
});

test('generated comments/formatting differences are reported without blanket normalization', async () => {
  const input = await fixture(), host = inventory(input);
  await file(join(input.roots.antigravity, 'lib/index.js'), '// different compiler path annotation\npublic compiled static markers');
  const comparison = compareInventories(host, inventory(input));
  assert.equal(comparison.identicalVersions, true);
  assert.equal(comparison.exactPublicParity, false);
  assert.deepEqual(comparison.codeDifferences.map(item => item.key), ['antigravity/lib/index.js']);
  assert.match(comparison.qualification, /explicit reviewed comparison/);
});

test('public-source fallback is labeled and cannot be presented as loaded profile evidence', async () => {
  const result = inventory(await fixture({ fallback: true }));
  assert.equal(result.packages.tui.origin, 'public-source-fallback');
  assert.equal(result.packages.antigravity.origin, 'public-source-fallback');
  assert.match(result.qualification, /not activation/);
  assert.deepEqual(result.blockers, []);
});

test('package identity failure emits bounded reason only, never foreign manifest values', async () => {
  const result = inventory(await fixture({ secretName: true }));
  assert.equal(result.packages.adapter, null);
  assert(result.blockers.some(item => item.item === 'package:adapter'));
  assert(!JSON.stringify(result).includes('SECRET_NAME_CANARY'));
});

test('out-of-root and private-target code symlinks are refused before reading contents', async () => {
  const input = await fixture();
  const outside = join(input.root, 'outside');
  await mkdir(outside); await file(join(outside, 'private.txt'), 'OUTSIDE_PRIVATE_CANARY');
  const linkedSource = join(input.repoRoot, 'linked');
  await symlink(outside, linkedSource);
  assert.throws(() => inventory({ ...input, sources: { ...input.sources, selfheal: linkedSource } }), /Canonical/);
  // A public source path may not redirect into an otherwise in-root .dsh file.
  const privateSource = join(input.repoRoot, 'redirected-source');
  await mkdir(privateSource); await symlink(join(input.repoRoot, '.dsh/auth.json'), join(privateSource, 'index.mjs'));
  const result = inventory({ ...input, sources: { ...input.sources, selfheal: privateSource } });
  assert.equal(result.sourceCode['selfheal/index.mjs'], null);
  assert(!JSON.stringify(result).includes('DO_NOT_READ_PRIVATE_AUTH'));
});

test('no-argument/help commands have no inspection and CLI rejects malformed paths/options', () => {
  assert.match(runInventoryCommand([]), /No arguments/);
  assert.equal(runInventoryCommand([]), runInventoryCommand(['--help']));
  assert.throws(() => runInventoryCommand(['--runtime', 'relative']), /absolute/);
  assert.throws(() => runInventoryCommand(['--unexpected', '/tmp']), /Unknown/);
  assert.throws(() => runInventoryCommand(['--runtime']), /absolute/);
});

test('CLI uses explicit public source mappings and exclusively creates output', async () => {
  const input = await fixture(), output = join(input.root, 'public-inventory.json');
  const args = ['--runtime', input.runtimeRoot, '--repo', input.repoRoot, '--output', output, ...Object.entries(input.sources).flatMap(([id, path]) => ['--' + id + '-source', path])];
  const result = runInventoryCommand(args);
  assert.deepEqual(result.blockers, []);
  const before = await readFile(output);
  assert.throws(() => runInventoryCommand(args), { code: 'EEXIST' });
  assert.deepEqual(await readFile(output), before);
  assert.equal(runInventoryCommand(['--compare', output, output]).exactPublicParity, true);
});

test('contract-3 readiness requires the active owner7 alias and fingerprints the extracted schema/accounting sources', async () => {
  const input = await fixture(), before = inventory(input);
  assert(before.sourceCode['selfheal/state-schema.mjs']);
  assert(before.sourceCode['resilience/recovery-accounting.mjs']);
  assert.equal(before.features.unboundedRecoveryAlias, true);
  await file(join(input.sources.selfheal, 'lib/index-v7-unified.mjs'), 'public source assertPersistenceCompatible harness warning:');
  const after = inventory(input);
  assert.equal(after.features.unboundedRecoveryAlias, false);
  assert(after.blockers.some(item => item.item === 'feature:unboundedRecoveryAlias'));
});

test('controller4 is optional historical provenance; active markers use controller6/owner7 and their rollbacks stay required', async () => {
  const input = await fixture(), portable = inventory(input);
  assert.deepEqual(portable.blockers, []); assert.deepEqual(portable.historicalArtifacts, {});
  for (const suffix of ['mjs', 'build.json']) await file(join(input.sources.resilience, `lib/index-v4-unified.${suffix}`), 'historical harness warning: llmRecoveryHistory');
  const historical = inventory(input);
  assert.equal(Object.keys(historical.historicalArtifacts).length, 2);
  assert.equal(compareInventories(portable, historical).exactPublicParity, true);
  assert(!Object.keys(historical.code).some(key => key.includes('index-v4-unified')));
  await file(join(input.sources.resilience, 'lib/index-v6-unified.mjs'), '// no current markers');
  const invalid = inventory(input);
  assert.equal(invalid.features.contextualHarnessWarning, false);
  assert.equal(invalid.features.unboundedRecoveryAlias, false);
  assert(invalid.code['resilience/lib/index-v1-resilience.mjs']);
  assert(invalid.code['resilience/lib/index-v5-unified.mjs']);
  assert(invalid.code['selfheal/lib/index-v3-resilience.mjs']);
  assert(invalid.code['selfheal/lib/index-v6-unified.mjs']);
});
