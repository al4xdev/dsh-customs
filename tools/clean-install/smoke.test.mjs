import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as observerSource from '../pi-ai-fork/provider-failure.ts';
import * as policySource from '../../plugins/llm-resilience/policy.mjs';
import { main, smoke, syntheticPersistence, syntheticObserver, syntheticRecoveryPolicy } from './smoke.mjs';

function syntheticSdk() {
  return { validateStoredEvents(header, events) {
    assert.equal(header.version, 4);
    assert.equal(events.length, 1);
    if (events[0].type !== 'agent/self-heal') throw new Error('Unknown required fixture event');
  } };
}

test('persistence fixture requires both known acceptance and unknown rejection', () => {
  syntheticPersistence(syntheticSdk());
  assert.throws(() => syntheticPersistence({ validateStoredEvents() {} }), /Unknown required events/);
  assert.throws(() => syntheticPersistence({ validateStoredEvents() { throw new Error('unsupported'); } }), /unsupported/);
});

test('observer checks pure source categories and callback disposal without selecting a retry authority', () => {
  syntheticObserver(observerSource);
  assert.throws(() => syntheticObserver({ ...observerSource, PROVIDER_FAILURE_OBSERVER_VERSION: 0 }));
});

test('current harness metadata is the unbounded contextual schedule rather than historical SDK retry defaults', () => {
  const result = syntheticRecoveryPolicy(policySource);
  assert.equal(result.maxRetries, 'unbounded'); assert.equal(result.nominalDelaysMs[9], 3600000); assert.equal(result.laterDelayMs, 3600000);
  assert.equal(result.recoveryVersion, 3); assert.equal(result.maxProviderWaitMs, 86400000);
  assert.equal(result.legacySdkMetadataIsAuthority, false);
  assert.throws(() => syntheticRecoveryPolicy({ ...policySource, DEFAULT_POLICY: { ...policySource.DEFAULT_POLICY, maxRetries: 9 } }));
});

test('default/help and malformed CLI remain inert', async () => {
  assert.match((await main([])).help, /Docker-only/);
  assert.match((await main(['--help'])).help, /No CLI boot/);
  await assert.rejects(main(['--runtime', '/runtime']), /Explicit runtime/);
  await assert.rejects(main(['--runtime', '/runtime', '--runtime', '/again']), /duplicate/);
});

test('host guard runs before metadata, imports or filesystem root inspection', async () => {
  let touched = false;
  await assert.rejects(smoke({ runtimeRoot: '/intentionally/missing', repoRoot: '/also/missing' }, {
    dockerCheck: async () => false,
    inventory() { touched = true; },
    loadModule() { touched = true; },
  }), /Docker-only/);
  assert.equal(touched, false);
});

test('DI smoke imports only validators, observer helper and pure current policy, not boot/providers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-smoke-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'runtime'), repoRoot = join(root, 'repo');
  await mkdir(runtimeRoot); await mkdir(repoRoot);
  const imports = [];
  let compatibility = false;
  const result = await smoke({ runtimeRoot, repoRoot }, {
    dockerCheck: async () => true,
    inventory: () => ({ blockers: [] }),
    async loadModule(path) {
      imports.push(path);
      if (path.endsWith('dsh-session-persistence/lib/index.js')) return syntheticSdk();
      if (path.endsWith('pi-ai/dist/utils/provider-failure.js')) return observerSource;
      if (path.endsWith('agent-self-heal/persistence.mjs')) return { assertPersistenceCompatible() { compatibility = true; } };
      if (path.endsWith('llm-resilience/policy.mjs')) return policySource;
      throw new Error('Unexpected import: ' + path);
    },
  });
  assert.equal(imports.length, 4);
  assert(imports.every(path => !/dsh-app-boot|api\/|oauth|credentials/.test(path)));
  assert.equal(compatibility, true);
  assert.equal(result.sdk50SyntheticRoundtrip, true);
  assert.equal(result.observer38Synthetic, true);
  assert.equal(result.unifiedRecoveryPolicy.maxRetries, 'unbounded');
  assert.equal(result.modelCalls, 0);
  assert.equal(result.credentialsRead, false);
  assert.equal(result.cliBooted, false);
});

test('metadata blockers stop before any module fixture is loaded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-offline-smoke-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let imports = 0;
  await assert.rejects(smoke({ runtimeRoot: root, repoRoot: root }, {
    dockerCheck: async () => true,
    inventory: () => ({ blockers: [{ item: 'identity:pi' }] }),
    loadModule() { imports++; },
  }), /inventory has blockers/);
  assert.equal(imports, 0);
});
