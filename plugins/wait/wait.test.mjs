import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseWaitArgs,
  waitDuration,
  formatDuration,
  apply,
  name,
  inject,
  DEFAULT_WAIT_SECONDS,
  MIN_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
} from './index.mjs';

test('metadata exports match dsh plugin conventions', () => {
  assert.equal(name, 'alex-wait');
  assert.deepEqual(inject, ['tools']);
});

test('formatDuration formats seconds, minutes, and hours cleanly', () => {
  assert.equal(formatDuration(5), '5s');
  assert.equal(formatDuration(120), '120s (~2m)');
  assert.equal(formatDuration(3600), '3600s (~1h)');
  assert.equal(formatDuration(7200), '7200s (~2h)');
});

test('parseWaitArgs defaults and valid numeric inputs', () => {
  assert.deepEqual(parseWaitArgs({}), { seconds: DEFAULT_WAIT_SECONDS, reason: '' });
  assert.deepEqual(parseWaitArgs({ seconds: 2.5 }), { seconds: 2.5, reason: '' });
  assert.deepEqual(parseWaitArgs({ seconds: 5, reason: '  test reason  ' }), { seconds: 5, reason: 'test reason' });
});

test('parseWaitArgs accepts alternative naming aliases and time units', () => {
  assert.deepEqual(parseWaitArgs({ duration: 3 }), { seconds: 3, reason: '' });
  assert.deepEqual(parseWaitArgs({ ms: 2500 }), { seconds: 2.5, reason: '' });
  assert.deepEqual(parseWaitArgs({ duration_ms: 1000 }), { seconds: 1, reason: '' });
  assert.deepEqual(parseWaitArgs({ minutes: 5 }), { seconds: 300, reason: '' });
  assert.deepEqual(parseWaitArgs({ hours: 2 }), { seconds: 7200, reason: '' });
});

test('parseWaitArgs bounds validation', () => {
  assert.throws(() => parseWaitArgs({ seconds: 0 }), /must be at least/);
  assert.throws(() => parseWaitArgs({ seconds: -1 }), /must be at least/);
  assert.throws(() => parseWaitArgs({ seconds: MIN_WAIT_SECONDS - 0.001 }), /must be at least/);
  assert.throws(() => parseWaitArgs({ seconds: MAX_WAIT_SECONDS + 1 }), /cannot exceed/);
  assert.throws(() => parseWaitArgs({ hours: 25 }), /cannot exceed/);
  assert.throws(() => parseWaitArgs({ seconds: 'invalid' }), /must be a finite positive number/);
  assert.throws(() => parseWaitArgs({ seconds: Infinity }), /must be a finite positive number/);
  assert.throws(() => parseWaitArgs({ seconds: 1, reason: 123 }), /reason must be a string/);
});

test('waitDuration resolves with formatted duration and optional reason', async () => {
  const start = Date.now();
  const resWithReason = await waitDuration(0.05, 'Testing pause', undefined);
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 40, `Elapsed should be at least ~40ms, got ${elapsed}ms`);
  assert.equal(resWithReason, 'Waited 0.05s (Testing pause).');

  const resWithoutReason = await waitDuration(0.02, '', undefined);
  assert.equal(resWithoutReason, 'Waited 0.02s.');
});

test('waitDuration rejects immediately when signal is pre-aborted', async () => {
  const controller = new AbortController();
  const abortReason = new Error('Already cancelled');
  controller.abort(abortReason);

  await assert.rejects(
    waitDuration(1, 'Cancelled', controller.signal),
    error => error === abortReason
  );
});

test('waitDuration aborts cleanly in-flight when signal fires', async () => {
  const controller = new AbortController();
  const abortReason = new Error('Interrupted in flight');

  const promise = waitDuration(2, 'Long wait', controller.signal);
  setTimeout(() => controller.abort(abortReason), 50);

  await assert.rejects(promise, error => error === abortReason);
});

test('apply registers the wait tool in the context', async () => {
  let registeredTool = null;
  const ctx = {
    tools: {
      register(tool) {
        registeredTool = tool;
      },
    },
  };

  apply(ctx);
  assert.ok(registeredTool, 'Tool should be registered');
  assert.equal(registeredTool.name, 'wait');
  assert.ok(registeredTool.description.includes('Wait for a specified duration'));
  assert.ok(registeredTool.parameters.properties.seconds);
  assert.ok(registeredTool.parameters.properties.minutes);
  assert.ok(registeredTool.parameters.properties.hours);
  assert.ok(registeredTool.parameters.properties.reason);

  const exec = { signal: new AbortController().signal };
  const result = await registeredTool.execute({ seconds: 0.02, reason: 'test execute' }, exec);
  assert.equal(result, 'Waited 0.02s (test execute).');
});
