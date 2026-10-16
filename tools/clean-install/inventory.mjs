#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageNames = Object.freeze({ dsh: '@deepseek-ai/dsh', base: '@deepseek-ai/dsh-base', cordis: '@deepseek-ai/cordis', scope: '@deepseek-ai/dsh-scope', adapter: '@deepseek-ai/dsh-llm-pi-ai', pi: '@earendil-works/pi-ai', tui: '@deepseek-harness-tui/dsh-tui', antigravity: '@deepseek-ai/dsh-llm-pi-ai-antigravity', session: '@deepseek-ai/dsh-session', persistence: '@deepseek-ai/dsh-session-persistence', jsonl: '@deepseek-ai/dsh-session-persistence-jsonl' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => path === root || path.startsWith(root + sep);
function absolute(path) { assert(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'Normalized absolute path required'); return path; }
function directory(path) { absolute(path); assert.equal(realpathSync(path), path, 'Canonical directory required'); assert(lstatSync(path).isDirectory()); return path; }
const codePaths = { session: ['lib/index.js', 'lib/types/known-event-types.js'], pi: ['dist/index.js', 'dist/api/openai-codex-responses.js', 'dist/utils/provider-failure.js'], antigravity: ['lib/index.js'], tui: ['index.js', 'index.d.ts', 'index.d.ts.map', 'profiles.js', 'profiles.d.ts', 'profiles.d.ts.map'].map(name => 'lib/types/dsh-adapter/oauth/' + name) };
const sourcePaths = { tui: ['src/dsh-adapter/oauth/index.ts', 'src/dsh-adapter/oauth/profiles.ts'], antigravity: ['src/index.ts', 'src/api.ts', 'src/failure.ts', 'src/failure-bridge.ts'], pi: ['packages/ai/src/index.ts', 'packages/ai/src/api/openai-codex-responses.ts'], selfheal: ['index.mjs', 'logic.mjs', 'sanitizer.mjs', 'persistence.mjs', 'state-schema.mjs'], resilience: ['index.mjs', 'policy.mjs', 'controller.mjs', 'main-driver.mjs', 'aux-driver.mjs', 'recovery-accounting.mjs'] };
const recoveryArtifacts = {
  selfheal: ['lib/index-v2-persistence.mjs', 'lib/index-v3-resilience.mjs', 'lib/index-v6-unified.mjs', 'lib/index-v6-unified.build.json'],
  resilience: ['lib/index-v1-resilience.mjs', 'lib/index-v5-unified.mjs', 'lib/index-v5-unified.build.json'],
};

/** Reads only explicitly selected public package metadata/code; never imports a
 * package, walks a config directory, searches credentials or touches session logs.
 * A repository fallback is source/code location evidence, not profile activation.
 */
export function inventory({ runtimeRoot, repoRoot, sources = {} } = {}) {
  directory(runtimeRoot);
  if (repoRoot) directory(repoRoot);
  assert(Object.keys(sources).every(key => Object.hasOwn(sourcePaths, key)), 'Unknown source mapping');
  const locations = { ...(repoRoot ? { tui: join(repoRoot, 'frontend/dsh-tui'), antigravity: join(repoRoot, 'plugins/dsh-antigravity'), pi: join(repoRoot, 'sources/pi-ai'), selfheal: join(repoRoot, 'plugins/agent-self-heal'), resilience: join(repoRoot, 'plugins/llm-resilience') } : {}), ...sources };
  const roots = [runtimeRoot, ...(repoRoot ? [repoRoot] : []), ...Object.values(sources).map(directory)];
  function bytes(path) {
    const physical = realpathSync(path);
    assert(roots.some(root => inside(root, physical)), 'Public code escaped selected roots');
    assert(!physical.split(sep).some(part => ['.dsh', '.dumps'].includes(part)), 'Private scratch/config target refused');
    assert(lstatSync(physical).isFile(), 'Regular public file required');
    return { physical, bytes: readFileSync(physical) };
  }
  const packages = {}, code = {}, sourceCode = {}, graph = {}, graphContext = {}, blockers = [], sourceGraphIssues = [], texts = {};
  function attempt(label, fn, issues = blockers) { try { return fn(); } catch (error) { issues.push({ item: label, reason: error.code === 'ENOENT' || error.code === 'MODULE_NOT_FOUND' ? 'missing' : 'invalid-or-unconfined' }); return null; } }
  function peerManifest(anchored, name) {
    try { return anchored.resolve(name + '/package.json'); } catch (error) {
      if (!['ERR_PACKAGE_PATH_NOT_EXPORTED', 'MODULE_NOT_FOUND'].includes(error.code)) throw error;
      // Metadata exports are optional. Follow Node's anchored search directories
      // without resolving/evaluating an ESM entry or jumping past an existing
      // shadow package. bytes() below enforces confinement and package identity.
      for (const search of anchored.resolve.paths(name) ?? []) {
        const candidate = join(search, name);
        try { lstatSync(candidate); } catch (missing) { if (missing.code === 'ENOENT') continue; throw missing; }
        return join(candidate, 'package.json');
      }
      throw error;
    }
  }
  for (const [id, name] of Object.entries(packageNames)) {
    packages[id] = attempt('package:' + id, () => {
      let path = join(runtimeRoot, 'node_modules', name, 'package.json'), origin = 'runtime';
      // Current host TUI/AG are separate public source forks, not installed at
      // top-level. This explicit fallback never reads a private profile map.
      try { lstatSync(path); } catch (error) {
        if (error.code !== 'ENOENT' || !['tui', 'antigravity'].includes(id) || !locations[id]) throw error;
        path = join(locations[id], 'package.json'); origin = 'public-source-fallback';
      }
      const file = bytes(path), metadata = JSON.parse(file.bytes);
      assert.equal(metadata.name, name); assert(typeof metadata.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(metadata.version), 'Invalid public version');
      return { name, version: metadata.version, manifest: file.physical, origin };
    });
    if (packages[id]) for (const relative of codePaths[id] ?? []) {
      const key = id + '/' + relative;
      const file = attempt('code:' + key, () => bytes(join(packages[id].manifest.slice(0, -'package.json'.length), relative)));
      code[key] = file ? digest(file.bytes) : null;
      if (file) texts[key] = file.bytes.toString('utf8');
    }
  }
  const peerIds = ['cordis', 'scope', 'pi'];
  for (const consumer of ['dsh', 'base', 'adapter', 'tui', 'antigravity', 'session', 'jsonl']) {
    if (!packages[consumer]) continue;
    graph[consumer] = {};
    const sourceOnly = packages[consumer].origin === 'public-source-fallback';
    graphContext[consumer] = sourceOnly ? 'source-build-resolution-only' : 'installed-runtime-resolution';
    const anchored = createRequire(packages[consumer].manifest);
    for (const peer of peerIds) graph[consumer][peer] = attempt('peer:' + consumer + ':' + peer, () => {
      const file = bytes(peerManifest(anchored, packageNames[peer]));
      assert.equal(JSON.parse(file.bytes).name, packageNames[peer]);
      return file.physical;
    }, sourceOnly ? sourceGraphIssues : blockers);
  }
  const identity = {};
  for (const peer of peerIds) {
    const paths = Object.values(graph).map(peers => peers[peer]);
    const runtimePaths = Object.entries(graph).filter(([id]) => packages[id].origin === 'runtime').map(([, peers]) => peers[peer]);
    const matches = values => !!packages[peer] && values.length > 0 && values.every(path => path === packages[peer].manifest);
    identity[peer] = { shared: matches(paths), sharedRuntime: matches(runtimePaths), physicalCopies: [...new Set(paths.filter(Boolean))], runtimePhysicalCopies: [...new Set(runtimePaths.filter(Boolean))] };
    if (!identity[peer].sharedRuntime) blockers.push({ item: 'identity:' + peer, reason: 'missing-or-split-physical-peer' });
  }
  function fingerprint(key, path) { const file = attempt('source:' + key, () => bytes(path)); sourceCode[key] = file ? digest(file.bytes) : null; }
  for (const [id, location] of Object.entries(locations)) for (const file of sourcePaths[id]) fingerprint(id + '/' + file, join(location, file));
  if (repoRoot) for (const file of ['plugins/common.mjs', 'tools/pi-ai-fork/provider-failure.ts', 'tools/pi-ai-fork/codex-failure-categories.mjs']) fingerprint(file, join(repoRoot, file));
  for (const [id, paths] of Object.entries(recoveryArtifacts)) if (locations[id]) for (const path of paths) {
    const key = `${id}/${path}`;
    const file = attempt('code:' + key, () => bytes(join(locations[id], path)));
    code[key] = file ? digest(file.bytes) : null; if (file) texts[key] = file.bytes.toString('utf8');
  }
  // Historical controller4 is optional provenance, not an active/portable gate.
  // Keep it out of parity-required code so a fresh 5/6 install need not ship it.
  const historicalArtifacts = {};
  if (locations.resilience) for (const path of ['lib/index-v4-unified.mjs', 'lib/index-v4-unified.build.json']) {
    const file = attempt('history:resilience/' + path, () => bytes(join(locations.resilience, path)), []);
    if (file) historicalArtifacts['resilience/' + path] = digest(file.bytes);
  }
  const features = { observer38: /subscribeProviderFailures/.test(texts['pi/dist/utils/provider-failure.js'] ?? '') && /report(?:Codex|Provider)Failure/.test(texts['pi/dist/api/openai-codex-responses.js'] ?? ''), sdk50: ['session/lib/index.js', 'session/lib/types/known-event-types.js'].every(key => (texts[key] ?? '').includes('agent/self-heal')), oauth32: (texts['tui/lib/types/dsh-adapter/oauth/index.js'] ?? '').includes('retryPolicies'), antigravitySignedReplay: ['convertMessages', 'isThinkingPart', 'retainThoughtSignature'].every(marker => (texts['antigravity/lib/index.js'] ?? '').includes(marker)), selfhealPersistence: (texts['selfheal/lib/index-v6-unified.mjs'] ?? '').includes('assertPersistenceCompatible'), unifiedRecoveryArtifacts: Object.entries(recoveryArtifacts).every(([id, paths]) => paths.every(path => !!code[`${id}/${path}`])), contextualHarnessWarning: ['selfheal/lib/index-v6-unified.mjs', 'resilience/lib/index-v5-unified.mjs'].every(key => (texts[key] ?? '').includes('harness warning:')), historyReadinessAlias: ['selfheal/lib/index-v6-unified.mjs', 'resilience/lib/index-v5-unified.mjs'].every(key => (texts[key] ?? '').includes('llmRecoveryHistory')) };
  for (const [feature, present] of Object.entries(features)) if (!present) blockers.push({ item: 'feature:' + feature, reason: 'static-marker-absent' });
  return { schemaVersion: 1, packages, graph, graphContext, identity, code, sourceCode, historicalArtifacts, features, blockers, sourceGraphIssues, qualification: 'Static public metadata/byte fingerprints and installed-package physical resolution only. Source fallback is not activation; its build dependencies are reported separately, not used to infer loaded runtime peers. Historical artifacts are optional provenance, not active targets or parity requirements. Markers do not prove running-daemon behavior or provider authentication.' };
}

export function compareInventories(host, container) {
  for (const value of [host, container]) assert.equal(value?.schemaVersion, 1, 'Inventory schema required');
  const versions = Object.keys(packageNames).map(id => ({ id, host: host.packages[id]?.version ?? null, container: container.packages[id]?.version ?? null, identical: !!host.packages[id] && !!container.packages[id] && host.packages[id].version === container.packages[id].version }));
  function differences(field) { return [...new Set([...Object.keys(host[field]), ...Object.keys(container[field])])].sort().filter(key => !host[field][key] || !container[field][key] || host[field][key] !== container[field][key]).map(key => ({ key, host: host[field][key] ?? null, container: container[field][key] ?? null })); }
  const codeDifferences = differences('code'), sourceDifferences = differences('sourceCode');
  const sharedIdentity = [host, container].every(value => ['cordis', 'scope', 'pi'].every(peer => value.identity[peer]?.sharedRuntime === true));
  const allConsumerIdentity = [host, container].every(value => ['cordis', 'scope', 'pi'].every(peer => value.identity[peer]?.shared === true));
  const sourceFallbackConsumers = Object.fromEntries([['host', host], ['container', container]].map(([label, value]) => [label, Object.keys(value.packages).filter(id => value.packages[id]?.origin === 'public-source-fallback')]));
  const complete = [host, container].every(value => Array.isArray(value.blockers) && value.blockers.length === 0);
  const exactPublicParity = complete && sharedIdentity && versions.every(item => item.identical) && codeDifferences.length === 0 && sourceDifferences.length === 0;
  return { versions, identicalVersions: versions.every(item => item.identical), sharedIdentity, allConsumerIdentity, sourceFallbackConsumers, codeDifferences, sourceDifferences, hostBlockers: host.blockers, containerBlockers: container.blockers, hostSourceGraphIssues: host.sourceGraphIssues ?? [], containerSourceGraphIssues: container.sourceGraphIssues ?? [], exactPublicParity, qualification: 'Parity covers public bytes and installed-runtime package resolution, not activation of source fallbacks or live constructors. Source-build peer splits are separately reported. Different generated bytes remain differences; compiler comments, notices, path annotations or formatting require an explicit reviewed comparison. Versions/markers alone never establish parity.' };
}

const help = 'Public code inventory only: --runtime ABS [--repo ABS] [--output ABS (new file only)]\nSource mapping: [--tui-source ABS] [--antigravity-source ABS] [--pi-source ABS] [--selfheal-source ABS] [--resilience-source ABS]\nCompare reviewed public inventories: --compare HOST_JSON_ABS CONTAINER_JSON_ABS\nNo arguments/--help performs no filesystem inspection. No auth, profiles, environment dump, imports or inference.\n';
export function runInventoryCommand(argv) {
  if (!argv.length || (argv.length === 1 && argv[0] === '--help')) return help;
  if (argv[0] === '--compare') { assert.equal(argv.length, 3); return compareInventories(...argv.slice(1).map(path => JSON.parse(readFileSync(absolute(path), 'utf8')))); }
  const args = {};
  for (let i = 0; i < argv.length; i += 2) { const flag = argv[i]; assert(['--runtime', '--repo', '--output', '--tui-source', '--antigravity-source', '--pi-source', '--selfheal-source', '--resilience-source'].includes(flag) && !Object.hasOwn(args, flag), 'Unknown/duplicate inventory option'); args[flag] = absolute(argv[i + 1]); }
  assert(args['--runtime'], '--runtime required');
  const sources = Object.fromEntries(Object.keys(sourcePaths).filter(id => args['--' + id + '-source']).map(id => [id, args['--' + id + '-source']]));
  const result = inventory({ runtimeRoot: args['--runtime'], repoRoot: args['--repo'], sources });
  if (args['--output']) writeFileSync(args['--output'], JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = runInventoryCommand(process.argv.slice(2)); console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)); if (result.blockers?.length || result.exactPublicParity === false) process.exitCode = 2; } catch { console.error('Public inventory failed; check explicit paths and schema. No private diagnostics emitted.'); process.exitCode = 1; }
}
