import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencyStatus, loadRuntime, RUNTIME_PINS, runtimeRequire } from './deps.mjs';

test('runtime status verifies all exact installed pins, not mere resolvability', async () => {
  const status = await dependencyStatus();
  assert.equal(status.available, true); assert.equal(status.manifestMatched, true);
  assert.equal(status.dependencies.length, 6); assert.equal(Object.isFrozen(RUNTIME_PINS), true);
  for (const entry of status.dependencies) assert.equal(entry.actual, RUNTIME_PINS[entry.name]);
});

test('unknown runtime imports fail closed without loading external packages', async () => {
  await assert.rejects(loadRuntime('node:child_process'), { code: 'BACKEND_UNAVAILABLE' });
  await assert.rejects(loadRuntime('unapproved-browser-runtime'), { code: 'BACKEND_UNAVAILABLE' });
});

test('missing runtime resolution is discovery data rather than a thrown metadata failure', async () => {
  const original = runtimeRequire.resolve;
  runtimeRequire.resolve = () => { throw new Error('Fixture missing installation'); };
  try {
    const status = await dependencyStatus();
    assert.equal(status.available, false);
    assert.ok(status.dependencies.every(entry => entry.available === false));
  } finally { runtimeRequire.resolve = original; }
});
