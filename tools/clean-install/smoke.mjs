#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory } from './inventory.mjs';

export function syntheticPersistence(sdk) {
  assert.equal(typeof sdk.validateStoredEvents, 'function');
  const header = { version: 4, id: 'clean-install-synthetic-probe', createdAt: 0 };
  const events = [{ type: 'agent/self-heal', seq: 0, time: 0, data: { version: 1, action: 'observed', turn: 1, step: 1, state: { lastHealthyTurn: 0 } } }];
  sdk.validateStoredEvents(header, events);
  sdk.validateStoredEvents(JSON.parse(JSON.stringify(header)), JSON.parse(JSON.stringify(events)));
  assert.throws(() => sdk.validateStoredEvents(header, [{ ...events[0], type: 'agent/clean-install-unknown-required' }]), 'Unknown required events must remain rejected');
}

export function syntheticObserver(observer) {
  assert.equal(observer.PROVIDER_FAILURE_OBSERVER_VERSION, 1);
  const rate = { status: 429, code: 'rate_limit_error', providerRetryAfterMs: 1_200_001, message: 'untrusted fixture text' };
  const quota = { status: 429, code: 'insufficient_quota' };
  assert.equal(observer.classifyCodexFailure(quota).code, 'QUOTA');
  assert.equal(observer.classifyCodexFailure({ status: 429 }).code, 'RATE_LIMIT');
  const classified = observer.classifyCodexFailure(rate);
  assert.equal(classified.code, 'RATE_LIMIT');
  assert.equal(classified.providerRetryAfterMs, 1_200_001);
  assert(!JSON.stringify(classified).includes(rate.message), 'Raw fixture text leaked into typed facts');
  assert(Object.isFrozen(classified), 'Provider facts must be frozen');
  const seen = [];
  const unsubscribe = observer.subscribeProviderFailures(failure => seen.push(failure));
  try { observer.reportCodexFailure(rate, 'openai-codex'); } finally { unsubscribe(); }
  assert.equal(seen.length, 1);
  observer.reportCodexFailure(rate, 'openai-codex');
  assert.equal(seen.length, 1, 'Unsubscribed listener was called');
  assert.equal(seen[0].code, 'RATE_LIMIT');
}

/** Current harness authority only. The unchanged SDK recipe's historical 9/20m
 * fixture is neither an active profile override nor an additional retry budget.
 * Contract 3: no count limit by default; ten doubling intervals reach the hour
 * cap, which every later retry keeps; provider minima are honored up to 24h.
 */
export function syntheticRecoveryPolicy(policyModule) {
  const { DEFAULT_POLICY, localDelay } = policyModule;
  assert.equal(DEFAULT_POLICY.maxRetries, Number.MAX_SAFE_INTEGER, 'Unbounded default retry count required');
  assert.equal(DEFAULT_POLICY.initialDelayMs, 7031.25);
  assert.equal(DEFAULT_POLICY.maxDelayMs, 3600000);
  assert.equal(DEFAULT_POLICY.jitterRatio, 0);
  assert.equal(DEFAULT_POLICY.maxProviderWaitMs, 86400000);
  const delays = Array.from({ length: 12 }, (_, index) => localDelay(DEFAULT_POLICY, index + 1, () => 0.5));
  assert.deepEqual(delays, [7031.25, 14062.5, 28125, 56250, 112500, 225000, 450000, 900000, 1800000, 3600000, 3600000, 3600000]);
  assert.equal(delays.slice(0, 10).reduce((sum, delay) => sum + delay, 0), 7192968.75);
  return { authority: 'alex-llm-resilience', recoveryVersion: 3, maxRetries: 'unbounded', nominalDelaysMs: delays.slice(0, 10), laterDelayMs: 3600000, firstTenWaitMs: 7192968.75, maxProviderWaitMs: 86400000, legacySdkMetadataIsAuthority: false };
}

/** Imports only selected public validators/helper modules, never SDK root/index,
 * provider APIs, CLI boot, credentials storage, profile config or session files.
 */
export async function smoke({ runtimeRoot, repoRoot }, io = {}) {
  const docker = await (io.dockerCheck ?? (() => access('/.dockerenv').then(() => true, () => false)))();
  assert(docker, 'Behavior smoke is Docker-only');
  for (const path of [runtimeRoot, repoRoot]) {
    assert.equal(path, resolve(path), 'Explicit absolute normalized roots required');
    assert.equal(await realpath(path), path, 'Canonical public roots required');
    assert(!path.split('/').some(part => ['.dsh', '.dumps'].includes(part)), 'Private paths refused');
  }
  const buildSources = join(dirname(runtimeRoot), 'dsh-build/sources');
  const publicInventory = (io.inventory ?? inventory)({ runtimeRoot, repoRoot, sources: { tui: join(buildSources, 'tui'), antigravity: join(buildSources, 'antigravity') } });
  assert.deepEqual(publicInventory.blockers, [], 'Public installation inventory has blockers');
  const modules = join(runtimeRoot, 'node_modules');
  const load = io.loadModule ?? (async path => {
    const physical = await realpath(path);
    assert(physical.startsWith(runtimeRoot + '/') || physical.startsWith(repoRoot + '/'), 'Module escaped public roots');
    return import(pathToFileURL(physical).href);
  });
  const sdk = await load(join(modules, '@deepseek-ai/dsh-session-persistence/lib/index.js'));
  syntheticPersistence(sdk);
  const observer = await load(join(modules, '@earendil-works/pi-ai/dist/utils/provider-failure.js'));
  syntheticObserver(observer);
  const selfheal = await load(join(repoRoot, 'plugins/agent-self-heal/persistence.mjs'));
  assert.equal(typeof selfheal.assertPersistenceCompatible, 'function');
  selfheal.assertPersistenceCompatible();
  const unifiedRecoveryPolicy = syntheticRecoveryPolicy(await load(join(repoRoot, 'plugins/llm-resilience/policy.mjs')));
  return { sdk50SyntheticRoundtrip: true, unknownRequiredEventStillRejected: true, observer38Synthetic: true, selfhealCompatibilityProbe: true, publicInventoryPassed: true, retryPolicyMetadataChecked: true, unifiedRecoveryPolicy, modelCalls: 0, credentialsRead: false, sessionFilesRead: false, cliBooted: false, qualification: 'Synthetic in-memory validation and public package identity only; no disk-session replay, inference, authentication or real retry waits.' };
}

export async function main(args = process.argv.slice(2)) {
  if (!args.length || (args.length === 1 && args[0] === '--help')) return { help: 'Docker-only offline behavior smoke: --runtime ABS --repo ABS. No CLI boot, providers, credentials, profiles or session-file reads.' };
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--runtime': 'runtimeRoot', '--repo': 'repoRoot' }[args[i]];
    assert(key && !Object.hasOwn(options, key) && args[i + 1], 'Unknown, duplicate or missing smoke option');
    options[key] = args[i + 1];
  }
  assert(options.runtimeRoot && options.repoRoot, 'Explicit runtime and repository roots required');
  return smoke(options);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch { console.error('Offline smoke failed; no private diagnostics emitted.'); process.exitCode = 1; }
}
