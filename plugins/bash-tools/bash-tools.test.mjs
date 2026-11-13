import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRACTICE, apply, withPractice } from './index.mjs';

test('only the bash definition gains the practice, after the stock text', () => {
  const bash = withPractice({ name: 'bash', description: 'stock', parameters: {} });
  assert.equal(bash.description, `stock\n\n${PRACTICE}`);
  const other = { name: 'job_output', description: 'x' };
  assert.equal(withPractice(other), other);
});

test('the stock plugin, run through the adapter, registers bash with the practice in both job states', () => {
  const registered = [];
  let jobsCallback;
  const ctx = {
    tools: { register(def) { registered.push(def); return () => {}; } },
    systemPrompt: { section() { return () => {}; }, getSectionOrder: () => 0 },
    shell: { sandboxMode: undefined }, shellEnv: {},
    fiber: { state: 2 },
    get: () => undefined,
    on: () => () => {}, emit() {}, effect: () => () => {},
    inject(_deps, callback) { jobsCallback = callback; return () => {}; },
  };
  apply(ctx, { enableRunInBackground: true, promoteOnTimeout: true });
  // Without a jobs service the stock registers a foreground-only bash first...
  assert.equal(registered.length, 1);
  assert.ok(registered[0].description.endsWith(PRACTICE));
  // ...and re-registers the background-capable one once jobs mount.
  jobsCallback({ jobs: {}, effect: () => () => {} });
  assert.equal(registered.length, 2);
  assert.ok(registered[1].description.endsWith(PRACTICE));
  assert.ok(registered[1].description.startsWith('Execute a bash command'));
});
