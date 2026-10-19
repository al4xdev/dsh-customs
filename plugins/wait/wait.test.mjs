import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseWaitArgs,
  waitDuration,
  formatDuration,
  apply,
  applyWithClock,
  normalizeWaitConfig,
  resolveWaitTarget,
  name,
  inject,
  DEFAULT_WAIT_SECONDS,
  MIN_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
} from './index.mjs';

const UTC = (...parts) => Date.UTC(...parts);
const SP = 'America/Sao_Paulo';
const PEAK = UTC(2026, 9, 20, 2, 0); // Tue 02:00 UTC, inside 01:00-04:00
const OPEN = UTC(2026, 9, 20, 4, 30); // Tue 04:30 UTC, between windows

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
  assert.ok(registeredTool.description.includes('untilOffPeak'));
  assert.ok(registeredTool.parameters.properties.seconds);
  assert.ok(registeredTool.parameters.properties.minutes);
  assert.ok(registeredTool.parameters.properties.hours);
  assert.ok(registeredTool.parameters.properties.until);
  assert.ok(registeredTool.parameters.properties.untilOffPeak);
  assert.ok(registeredTool.parameters.properties.reason);

  const exec = { signal: new AbortController().signal };
  const result = await registeredTool.execute({ seconds: 0.02, reason: 'test execute' }, exec);
  assert.equal(result, 'Waited 0.02s (test execute).');
});

function toolFor(config, now) {
  let registeredTool = null;
  const ctx = { tools: { register(tool) { registeredTool = tool; } } };
  applyWithClock(ctx, config, () => now);
  return registeredTool;
}

test('normalizeWaitConfig defaults the zone and validates overrides', () => {
  const settings = normalizeWaitConfig({ timeZone: SP, holidays: ['2026-10-20'] });
  assert.equal(settings.timeZone, SP);
  assert.deepEqual([...settings.schedule.holidays], ['2026-10-20']);
  assert.throws(() => normalizeWaitConfig({ timeZone: 'Mars/Olympus' }), /valid IANA zone/);
  assert.throws(() => normalizeWaitConfig({ preMarginMs: -1 }), /non-negative/);
});

test('resolveWaitTarget computes the hold from the shared peak schedule', () => {
  const settings = normalizeWaitConfig({ timeZone: SP });
  const peak = resolveWaitTarget({ untilOffPeak: true }, { nowMs: PEAK, settings });
  assert.equal(peak.seconds, (UTC(2026, 9, 20, 4, 10) - PEAK) / 1000);
  assert.match(peak.note, /off-peak in 2h10m \(01:10 America\/Sao_Paulo\)/);

  const open = resolveWaitTarget({ untilOffPeak: true }, { nowMs: OPEN, settings });
  assert.equal(open.seconds, 0);
  assert.match(open.note, /already off-peak/);
});

test('resolveWaitTarget resolves an explicit local clock time', () => {
  const settings = normalizeWaitConfig({ timeZone: SP });
  const target = resolveWaitTarget({ until: '01:10' }, { nowMs: PEAK, settings });
  assert.equal(target.seconds, (UTC(2026, 9, 20, 4, 10) - PEAK) / 1000);
  assert.match(target.note, /until 01:10 America\/Sao_Paulo/);
  // No clock target means the plain duration form is untouched.
  assert.equal(resolveWaitTarget({ seconds: 5 }, { nowMs: PEAK, settings }), undefined);
  assert.throws(() => resolveWaitTarget({ until: '01:10', untilOffPeak: true }, { nowMs: PEAK, settings }), /cannot be combined/);
  assert.throws(() => resolveWaitTarget({ until: 'later' }, { nowMs: PEAK, settings }), /expected HH:MM/);
});

test('the tool waits for the reported peak target and says why', async () => {
  const tool = toolFor({ timeZone: SP }, PEAK);
  const controller = new AbortController();
  const exec = { signal: controller.signal };
  const promise = tool.execute({ untilOffPeak: true }, exec);
  // Abort instead of really sleeping 2h10m: the tool must honor exec.signal.
  setTimeout(() => controller.abort(new Error('user interrupted')), 10);
  await assert.rejects(promise, /user interrupted/);
});

test('already off-peak returns a note instead of sleeping', async () => {
  const tool = toolFor({ timeZone: SP }, OPEN);
  const exec = { signal: new AbortController().signal };
  const result = await tool.execute({ untilOffPeak: true }, exec);
  assert.match(result, /Nothing to wait for: DeepSeek is already off-peak \(America\/Sao_Paulo\)\./);
});

test('an explicit until target near the clock waits and formats the reason', async () => {
  const now = UTC(2026, 9, 20, 4, 9, 59, 500); // 04:09:59.5 UTC, half a second before 04:10
  const tool = toolFor({ timeZone: 'UTC' }, now);
  const exec = { signal: new AbortController().signal };
  const result = await tool.execute({ until: '04:10', reason: 'peak window' }, exec);
  assert.match(result, /^Waited 0\.5s/);
  assert.match(result, /until 04:10 UTC/);
  assert.match(result, /peak window/);
});
