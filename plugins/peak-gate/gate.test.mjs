import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_GATE_CONFIG, cancellableSleep, normalizeConfig, planWait, refusalMessage, waitForOffPeak } from './gate.mjs';
import { renderPlan, upcomingIntervals } from './plan.mjs';
import { normalizeSchedule } from '../wait/schedule.mjs';

const UTC = (...parts) => Date.UTC(...parts);
const SP = 'America/Sao_Paulo';
const PEAK = UTC(2026, 9, 20, 2, 0); // Tue 02:00 UTC, inside 01:00-04:00
const OPEN = UTC(2026, 9, 20, 4, 30); // Tue 04:30 UTC, between windows

const settings = (config = {}) => normalizeConfig({ timeZone: SP, ...config });

test('defaults gate only the DeepSeek official route', () => {
  const s = settings();
  assert.deepEqual([...s.providers], [...DEFAULT_GATE_CONFIG.providers]);
  assert.equal(s.mode, 'wait');
  // The widest interval is 06:00-10:00 UTC plus both margins (4h20m), so the
  // default must stay above it or an ordinary 02:50 BRT request would refuse.
  assert.equal(s.maxWaitMs, 5 * 3_600_000);
  assert.equal(planWait({ provider: 'deepseek-official' }, s, PEAK).wait, true);
  assert.equal(planWait({ provider: 'openai-codex' }, s, PEAK).wait, false);
  assert.equal(planWait({ provider: 'google-antigravity' }, s, PEAK).wait, false);
});

test('outside a peak window nothing is held', () => {
  const plan = planWait({ provider: 'deepseek-official' }, settings(), OPEN);
  assert.equal(plan.wait, false);
});

test('disabled configuration and custom provider lists are honored', () => {
  assert.equal(planWait({ provider: 'deepseek-official' }, settings({ enabled: false }), PEAK).wait, false);
  const codex = settings({ providers: ['openai-codex'] });
  assert.equal(planWait({ provider: 'openai-codex' }, codex, PEAK).wait, true);
  assert.equal(planWait({ provider: 'deepseek-official' }, codex, PEAK).wait, false);
});

test('planWait carries the resume instant and kind', () => {
  const plan = planWait({ provider: 'deepseek-official' }, settings(), PEAK);
  assert.equal(plan.gate.kind, 'peak');
  assert.equal(plan.gate.resumeAt, UTC(2026, 9, 20, 4, 10));
});

test('normalizeConfig accepts flat schedule fields and rejects garbage', () => {
  const s = settings({ holidays: ['2026-10-20'], preMarginMs: 0 });
  assert.deepEqual([...s.schedule.holidays], ['2026-10-20']);
  assert.equal(planWait({ provider: 'deepseek-official' }, s, PEAK).wait, false);

  assert.throws(() => normalizeConfig({ providers: [] }), /non-empty array/);
  assert.throws(() => normalizeConfig({ providers: [42] }), /non-empty strings/);
  assert.throws(() => normalizeConfig({ mode: 'sleep' }), /mode must be/);
  assert.throws(() => normalizeConfig({ maxWaitMs: 0 }), /positive number/);
  assert.throws(() => normalizeConfig({ waitSliceMs: -5 }), /positive number/);
  assert.throws(() => normalizeConfig({ timeZone: 'Mars/Olympus' }), /valid IANA zone/);
});

test('refusalMessage names the resume clock and the price reason', () => {
  const plan = planWait({ provider: 'deepseek-official' }, settings(), PEAK);
  const message = refusalMessage(plan.gate, settings());
  assert.match(message, /deepseek peak hours/);
  assert.match(message, /off-peak in 2h10m \(01:10 America\/Sao_Paulo\)/);
  assert.match(message, /cost double/);
});

test('waitForOffPeak sleeps in slices and returns once the window opens', async () => {
  // The slice is 1ms so the test is fast; the clock advances 10 minutes per
  // read, which is what proves the loop recomputes instead of sleeping blind.
  let now = PEAK;
  const seen = [];
  const resumeAt = UTC(2026, 9, 20, 4, 10);
  await waitForOffPeak({
    signal: undefined,
    settings: settings({ waitSliceMs: 1 }),
    clock: () => {
      // Advance only while the gate is still closed, and record each wake.
      seen.push(now);
      if (now < resumeAt) now += 10 * 60_000;
      return now;
    },
    onGate: (gate) => assert.equal(gate.resumeAt, resumeAt),
  });
  assert.ok(seen.length > 1, 'the gate must re-evaluate on every wake');
  assert.ok(now >= resumeAt, `clock must pass the resume instant, got ${new Date(now).toISOString()}`);
});

test('waitForOffPeak returns immediately outside a window', async () => {
  const gate = await waitForOffPeak({ signal: undefined, settings: settings(), clock: () => OPEN });
  assert.equal(gate.gated, false);
});

test('waitForOffPeak rejects when the request is aborted while held', async () => {
  const controller = new AbortController();
  const reason = new Error('user interrupted');
  setTimeout(() => controller.abort(reason), 20);
  await assert.rejects(
    waitForOffPeak({ signal: controller.signal, settings: settings(), clock: () => PEAK }),
    (error) => error === reason,
  );
});

test('cancellableSleep resolves, and rejects an already-aborted signal', async () => {
  await cancellableSleep(5, undefined);
  const controller = new AbortController();
  const reason = new Error('gone');
  controller.abort(reason);
  await assert.rejects(cancellableSleep(10, controller.signal), (error) => error === reason);
});

// Regression for the default that shipped wrong once: maxWaitMs was 4h, but
// 06:00-10:00 UTC plus both margins is 4h20m, so an ordinary 02:50 BRT request
// was refused instead of held. The default must cover every instant of a week.
test('the default maxWaitMs covers every gated instant in a week', () => {
  const s = settings();
  const begin = UTC(2026, 9, 19, 0, 0);
  let widest = 0;
  for (let minute = 0; minute < 7 * 24 * 60; minute += 1) {
    const plan = planWait({ provider: 'deepseek-official' }, s, begin + minute * 60_000);
    if (plan.wait) widest = Math.max(widest, plan.gate.waitMs);
  }
  assert.equal(widest, (4 * 60 + 20) * 60_000, 'widest interval is 06:00-10:00 UTC plus margins');
  assert.ok(s.maxWaitMs >= widest, `default maxWaitMs ${s.maxWaitMs} must cover ${widest}`);
});

test('renderPlan prints tonight in local time with the real window widths', () => {
  // 20:35 BRT on Monday 19 Oct 2026, half an hour before the gate closes.
  const now = UTC(2026, 9, 19, 23, 35);
  const plan = renderPlan(now, settings(), { days: 1, limit: 2 });
  assert.match(plan.lines[0], /^now 2026-10-19 20:35 America\/Sao_Paulo — open$/);
  assert.equal(
    plan.lines[1],
    '2026-10-19 21:50 → 2026-10-20 01:10  (3h20m, window 01:00-04:00 UTC, peak 22:00-01:00 local)',
  );
  assert.equal(
    plan.lines[2],
    '2026-10-20 02:50 → 2026-10-20 07:10  (4h20m, window 06:00-10:00 UTC, peak 03:00-07:00 local)',
  );
});

test('renderPlan reports the hold state and when it opens', () => {
  const plan = renderPlan(PEAK, settings(), { days: 0, limit: 1 });
  assert.match(plan.lines[0], /GATED \(peak, 2h10m left, opens 01:10\)$/);
});

test('upcomingIntervals skips the weekend and stays sorted and unique', () => {
  // After Friday 23 Oct 07:10 local the next gate is Sunday night: UTC weekend
  // windows are off-peak in full.
  const afterFriday = UTC(2026, 9, 23, 10, 10);
  const intervals = upcomingIntervals(afterFriday, normalizeSchedule({}), 4);
  assert.equal(intervals[0].gateStartAt, UTC(2026, 9, 26, 0, 50)); // Sun 25 Oct 21:50 BRT
  const starts = intervals.map((interval) => interval.gateStartAt);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(new Set(starts).size, starts.length);
});
