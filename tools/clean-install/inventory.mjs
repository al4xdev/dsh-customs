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
const sourcePaths = { tui: ['src/dsh-adapter/oauth/index.ts', 'src/dsh-adapter/oauth/profiles.ts'], antigravity: ['src/index.ts', 'src/api.ts', 'src/failure.ts', 'src/failure-bridge.ts'], pi: ['packages/ai/src/index.ts', 'packages/ai/src/api/openai-codex-responses.ts'], selfheal: ['index.mjs', 'logic.mjs', 'sanitizer.mjs', 'persistence.mjs'] };

/** Reads only explicitly selected public package metadata/code; never imports a
 * package, walks a config directory, searches credentials or touches session logs.
 * A repository fallback is source/code location evidence, not profile activation.
 */
export function inventory({ runtimeRoot, repoRoot, sources = {} } = {}) {
  directory(runtimeRoot);
  if (repoRoot) directory(repoRoot);
  assert(Object.keys(sources).every(key => Object.hasOwn(sourcePaths, key)), 'Unknown source mapping');
  const locations = { ...(repoRoot ? { tui: join(repoRoot, 'frontend/dsh-tui'), antigravity: join(repoRoot, 'plugins/dsh-antigravity'), pi: join(repoRoot, 'sources/pi-ai'), selfheal: join(repoRoot, 'plugins/agent-self-heal') } : {}), ...sources };
  const roots = [runtimeRoot, ...(repoRoot ? [repoRoot] : []), ...Object.values(sources).map(directory)];
  function bytes(path) {
    const physical = realpathSync(path);
    assert(roots.some(root => inside(root, physical)), 'Public code escaped selected roots');
    assert(!physical.split(sep).some(part => ['.dsh', '.dumps'].includes(part)), 'Private scratch/config target refused');
    assert(lstatSync(physical).isFile(), 'Regular public file required');
    return { physical, bytes: readFileSync(physical) };
  }
  const packages = {}, code = {}, sourceCode = {}, graph = {}, blockers = [], texts = {};
  function attempt(label, fn) { try { return fn(); } catch (error) { blockers.push({ item: label, reason: error.code === 'ENOENT' || error.code === 'MODULE_NOT_FOUND' ? 'missing' : 'invalid-or-unconfined' }); return null; } }
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
    const anchored = createRequire(packages[consumer].manifest);
    for (const peer of peerIds) graph[consumer][peer] = attempt('peer:' + consumer + ':' + peer, () => {
      const file = bytes(anchored.resolve(packageNames[peer] + '/package.json'));
      assert.equal(JSON.parse(file.bytes).name, packageNames[peer]);
      return file.physical;
    });
  }
  const identity = {};
  for (const peer of peerIds) {
    const paths = Object.values(graph).map(peers => peers[peer]);
    identity[peer] = { shared: !!packages[peer] && paths.length > 0 && paths.every(path => path === packages[peer].manifest), physicalCopies: [...new Set(paths.filter(Boolean))] };
    if (!identity[peer].shared) blockers.push({ item: 'identity:' + peer, reason: 'missing-or-split-physical-peer' });
  }
  function fingerprint(key, path) { const file = attempt('source:' + key, () => bytes(path)); sourceCode[key] = file ? digest(file.bytes) : null; }
  for (const [id, location] of Object.entries(locations)) for (const file of sourcePaths[id]) fingerprint(id + '/' + file, join(location, file));
  if (repoRoot) for (const file of ['plugins/common.mjs', 'tools/pi-ai-fork/provider-failure.ts', 'tools/pi-ai-fork/codex-failure-categories.mjs']) fingerprint(file, join(repoRoot, file));
  if (locations.selfheal) {
    const key = 'selfheal/lib/index-v2-persistence.mjs';
    const file = attempt('code:' + key, () => bytes(join(locations.selfheal, 'lib/index-v2-persistence.mjs')));
    code[key] = file ? digest(file.bytes) : null; if (file) texts[key] = file.bytes.toString('utf8');
  }
  const features = { observer38: /subscribeProviderFailures/.test(texts['pi/dist/utils/provider-failure.js'] ?? '') && /reportCodexFailure/.test(texts['pi/dist/api/openai-codex-responses.js'] ?? ''), sdk50: ['session/lib/index.js', 'session/lib/types/known-event-types.js'].every(key => (texts[key] ?? '').includes('agent/self-heal')), oauth32: (texts['tui/lib/types/dsh-adapter/oauth/index.js'] ?? '').includes('retryPolicies'), antigravitySignedReplay: ['convertMessages', 'isThinkingPart', 'retainThoughtSignature'].every(marker => (texts['antigravity/lib/index.js'] ?? '').includes(marker)), selfhealPersistence: (texts['selfheal/lib/index-v2-persistence.mjs'] ?? '').includes('assertPersistenceCompatible') };
  for (const [feature, present] of Object.entries(features)) if (!present) blockers.push({ item: 'feature:' + feature, reason: 'static-marker-absent' });
  return { schemaVersion: 1, packages, graph, identity, code, sourceCode, features, blockers, qualification: 'Static public metadata/byte fingerprints and physical resolution only. Source fallback is not activation; markers do not prove running-daemon behavior or provider authentication.' };
}

export function compareInventories(host, container) {
  for (const value of [host, container]) assert.equal(value?.schemaVersion, 1, 'Inventory schema required');
  const versions = Object.keys(packageNames).map(id => ({ id, host: host.packages[id]?.version ?? null, container: container.packages[id]?.version ?? null, identical: !!host.packages[id] && !!container.packages[id] && host.packages[id].version === container.packages[id].version }));
  function differences(field) { return [...new Set([...Object.keys(host[field]), ...Object.keys(container[field])])].sort().filter(key => !host[field][key] || !container[field][key] || host[field][key] !== container[field][key]).map(key => ({ key, host: host[field][key] ?? null, container: container[field][key] ?? null })); }
  const codeDifferences = differences('code'), sourceDifferences = differences('sourceCode');
  const sharedIdentity = [host, container].every(value => ['cordis', 'scope', 'pi'].every(peer => value.identity[peer]?.shared === true));
  const complete = [host, container].every(value => Array.isArray(value.blockers) && value.blockers.length === 0);
  const exactPublicParity = complete && sharedIdentity && versions.every(item => item.identical) && codeDifferences.length === 0 && sourceDifferences.length === 0;
  return { versions, identicalVersions: versions.every(item => item.identical), sharedIdentity, codeDifferences, sourceDifferences, hostBlockers: host.blockers, containerBlockers: container.blockers, exactPublicParity, qualification: 'Different generated bytes remain differences. Compiler comments, notices, path annotations or formatting may explain them only after an explicit reviewed comparison; versions/markers alone never establish parity.' };
}

const help = 'Public code inventory only: --runtime ABS [--repo ABS] [--output ABS (new file only)]\nSource mapping: [--tui-source ABS] [--antigravity-source ABS] [--pi-source ABS] [--selfheal-source ABS]\nCompare reviewed public inventories: --compare HOST_JSON_ABS CONTAINER_JSON_ABS\nNo arguments/--help performs no filesystem inspection. No auth, profiles, environment dump, imports or inference.\n';
export function runInventoryCommand(argv) {
  if (!argv.length || (argv.length === 1 && argv[0] === '--help')) return help;
  if (argv[0] === '--compare') { assert.equal(argv.length, 3); return compareInventories(...argv.slice(1).map(path => JSON.parse(readFileSync(absolute(path), 'utf8')))); }
  const args = {};
  for (let i = 0; i < argv.length; i += 2) { const flag = argv[i]; assert(['--runtime', '--repo', '--output', '--tui-source', '--antigravity-source', '--pi-source', '--selfheal-source'].includes(flag) && !Object.hasOwn(args, flag), 'Unknown/duplicate inventory option'); args[flag] = absolute(argv[i + 1]); }
  assert(args['--runtime'], '--runtime required');
  const sources = Object.fromEntries(Object.keys(sourcePaths).filter(id => args['--' + id + '-source']).map(id => [id, args['--' + id + '-source']]));
  const result = inventory({ runtimeRoot: args['--runtime'], repoRoot: args['--repo'], sources });
  if (args['--output']) writeFileSync(args['--output'], JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = runInventoryCommand(process.argv.slice(2)); console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2)); if (result.blockers?.length || result.exactPublicParity === false) process.exitCode = 2; } catch { console.error('Public inventory failed; check explicit paths and schema. No private diagnostics emitted.'); process.exitCode = 1; }
}
