import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SCHEDULE,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  beijingDate,
  describeGate,
  formatClock,
  formatSpan,
  gateAt,
  gateIntervalsAround,
  nextClockOccurrence,
  normalizeSchedule,
} from './schedule.mjs';

// 2026-10-19 is a Monday, so every UTC weekday below is pinned, not guessed.
const UTC = (...parts) => Date.UTC(...parts);
const SP = 'America/Sao_Paulo';

test('default schedule matches the published DeepSeek windows', () => {
  assert.deepEqual(DEFAULT_SCHEDULE.peakWindowsUtc.map((w) => [...w]), [[1, 4], [6, 10]]);
  assert.equal(DEFAULT_SCHEDULE.weekdaysOnly, true);
  assert.equal(DEFAULT_SCHEDULE.preMarginMs, 10 * MINUTE_MS);
  assert.equal(DEFAULT_SCHEDULE.postMarginMs, 10 * MINUTE_MS);
});

test('mid-window is gated as peak and resumes at end plus the post margin', () => {
  const gate = gateAt(UTC(2026, 9, 20, 2, 0), DEFAULT_SCHEDULE); // Tue 02:00 UTC
  assert.equal(gate.gated, true);
  assert.equal(gate.kind, 'peak');
  assert.equal(gate.resumeAt, UTC(2026, 9, 20, 4, 10));
  assert.equal(gate.waitMs, 2 * HOUR_MS + 10 * MINUTE_MS);
  assert.equal(formatClock(gate.resumeAt, SP), '01:10');
});

test('the pre margin gates before the window opens', () => {
  const gate = gateAt(UTC(2026, 9, 20, 0, 55), DEFAULT_SCHEDULE);
  assert.equal(gate.gated, true);
  assert.equal(gate.kind, 'pre-margin');
  assert.equal(gate.resumeAt, UTC(2026, 9, 20, 4, 10));
});

test('the post margin keeps the gate shut briefly after the window', () => {
  const gate = gateAt(UTC(2026, 9, 20, 4, 5), DEFAULT_SCHEDULE);
  assert.equal(gate.gated, true);
  assert.equal(gate.kind, 'post-margin');
  assert.equal(gate.waitMs, 5 * MINUTE_MS);
});

test('the 04:00-06:00 UTC gap is open', () => {
  assert.equal(gateAt(UTC(2026, 9, 20, 4, 30), DEFAULT_SCHEDULE).gated, false);
  assert.equal(gateAt(UTC(2026, 9, 20, 5, 40), DEFAULT_SCHEDULE).gated, false);
});

test('the second window and its pre margin gate as well', () => {
  const pre = gateAt(UTC(2026, 9, 20, 5, 55), DEFAULT_SCHEDULE);
  assert.equal(pre.kind, 'pre-margin');
  assert.equal(pre.resumeAt, UTC(2026, 9, 20, 10, 10));
  const inside = gateAt(UTC(2026, 9, 20, 9, 59), DEFAULT_SCHEDULE);
  assert.equal(inside.kind, 'peak');
  assert.equal(formatClock(inside.resumeAt, SP), '07:10');
});

test('weekends are off-peak in full', () => {
  for (const day of [24, 25]) { // Sat 24, Sun 25 Oct 2026
    assert.equal(gateAt(UTC(2026, 9, day, 2, 0), DEFAULT_SCHEDULE).gated, false);
    assert.equal(gateAt(UTC(2026, 9, day, 7, 0), DEFAULT_SCHEDULE).gated, false);
  }
  // Friday 23 Oct 02:00 UTC is still peak; Saturday 00:55 UTC is already free.
  assert.equal(gateAt(UTC(2026, 9, 23, 2, 0), DEFAULT_SCHEDULE).gated, true);
  assert.equal(gateAt(UTC(2026, 9, 24, 0, 55), DEFAULT_SCHEDULE).gated, false);
});

test('holidays are excluded by Beijing calendar date', () => {
  const holiday = normalizeSchedule({ holidays: ['2026-10-20'] });
  assert.equal(gateAt(UTC(2026, 9, 20, 2, 0), holiday).gated, false);
  assert.equal(gateAt(UTC(2026, 9, 21, 2, 0), holiday).gated, true);
  // 2026-10-20T02:00Z is 10:00 in Beijing on the same date.
  assert.equal(beijingDate(UTC(2026, 9, 20, 2, 0)), '2026-10-20');
});

test('margins can widen a window past the UTC midnight it starts on', () => {
  const wide = normalizeSchedule({ preMarginMs: 2 * HOUR_MS, postMarginMs: 0 });
  // 00:00 UTC Tuesday is inside the widened (23:00 Monday → 04:00) window.
  const gate = gateAt(UTC(2026, 9, 20, 0, 0), wide);
  assert.equal(gate.gated, true);
  assert.equal(gate.kind, 'pre-margin');
  assert.equal(gate.peakStartAt, UTC(2026, 9, 20, 1, 0));
  // The neighbouring day is scanned, so Monday's window still resolves.
  assert.ok(gateIntervalsAround(UTC(2026, 9, 20, 0, 0), wide).length >= 2);
});

test('a zero-margin schedule gates exactly on the window bounds', () => {
  const tight = normalizeSchedule({ preMarginMs: 0, postMarginMs: 0 });
  assert.equal(gateAt(UTC(2026, 9, 20, 0, 59), tight).gated, false);
  assert.equal(gateAt(UTC(2026, 9, 20, 1, 0), tight).gated, true);
  assert.equal(gateAt(UTC(2026, 9, 20, 4, 0), tight).gated, false);
});

test('normalizeSchedule rejects malformed configuration', () => {
  assert.throws(() => normalizeSchedule({ peakWindowsUtc: [] }), /non-empty/);
  assert.throws(() => normalizeSchedule({ peakWindowsUtc: [[2]] }), /pair/);
  assert.throws(() => normalizeSchedule({ peakWindowsUtc: [[1, 25]] }), /between 0 and 24/);
  assert.throws(() => normalizeSchedule({ peakWindowsUtc: [[2, 2]] }), /distinct/);
  assert.throws(() => normalizeSchedule({ holidays: '2026-10-20' }), /array/);
  assert.throws(() => normalizeSchedule({ holidays: ['20/10/2026'] }), /YYYY-MM-DD/);
  assert.throws(() => normalizeSchedule({ preMarginMs: -1 }), /non-negative/);
});

test('formatSpan and describeGate read like the messages they feed', () => {
  assert.equal(formatSpan(2 * HOUR_MS + 5 * MINUTE_MS), '2h05m');
  assert.equal(formatSpan(42 * MINUTE_MS), '42m');
  assert.equal(formatSpan(35_000), '35s');
  assert.equal(describeGate(gateAt(UTC(2026, 9, 20, 2, 0), DEFAULT_SCHEDULE), SP), `off-peak in 2h10m (01:10 ${SP})`);
  assert.equal(describeGate(gateAt(UTC(2026, 9, 20, 4, 30), DEFAULT_SCHEDULE), SP), 'off-peak now');
});

test('formatClock prints midnight as 00:00, not 24:00', () => {
  assert.equal(formatClock(UTC(2026, 9, 20, 3, 0), SP), '00:00');
  assert.equal(formatClock(UTC(2026, 9, 20, 0, 0), 'UTC'), '00:00');
});

test('nextClockOccurrence resolves the next local occurrence', () => {
  // Local time at 02:00Z on 20 Oct is 23:00 on 19 Oct in Sao Paulo.
  assert.equal(nextClockOccurrence('01:10', UTC(2026, 9, 20, 2, 0), SP), UTC(2026, 9, 20, 4, 10));
  assert.equal(nextClockOccurrence('00:00', UTC(2026, 9, 20, 2, 0), SP), UTC(2026, 9, 20, 3, 0));
  // A clock time already passed today rolls to tomorrow.
  assert.equal(nextClockOccurrence('22:00', UTC(2026, 9, 20, 2, 0), SP), UTC(2026, 9, 21, 1, 0));
  assert.throws(() => nextClockOccurrence('25:00', UTC(2026, 9, 20, 2, 0), SP), /not a valid time/);
  assert.throws(() => nextClockOccurrence('soon', UTC(2026, 9, 20, 2, 0), SP), /expected HH:MM/);
});

// Differential check against a deliberately naive reading of the published
// rule: walk a full week minute by minute and require agreement. This is what
// catches an off-by-one at a window edge, a lost day shift from the margins, or
// a weekday leaking into the weekend — bugs a handful of samples can miss.
test('a full week of minutes agrees with the naive published rule', () => {
  const schedule = normalizeSchedule({ holidays: ['2026-10-21'] });
  const naive = (ts) => {
    const weekday = new Date(ts).getUTCDay();
    if (weekday === 0 || weekday === 6) return false;
    if (schedule.holidays.includes(beijingDate(ts))) return false;
    const dayStart = Math.floor(ts / DAY_MS) * DAY_MS;
    return [[1, 4], [6, 10]].some(([start, end]) => (
      ts >= dayStart + start * HOUR_MS - schedule.preMarginMs
      && ts < dayStart + end * HOUR_MS + schedule.postMarginMs
    ));
  };
  const begin = UTC(2026, 9, 19, 0, 0); // Monday 19 Oct 2026, 00:00 UTC
  let mismatches = 0;
  let gated = 0;
  const minutes = 7 * 24 * 60;
  for (let minute = 0; minute < minutes; minute += 1) {
    const ts = begin + minute * MINUTE_MS;
    const expected = naive(ts);
    if (expected) gated += 1;
    if (gateAt(ts, schedule).gated !== expected) mismatches += 1;
  }
  assert.equal(mismatches, 0, `${mismatches} of ${minutes} minutes disagreed with the naive rule`);
  // 5 weekdays in range, one excluded as holiday. Window widths come from the
  // windows themselves: 01:00-04:00 + margins = 200min, 06:00-10:00 + margins = 260min.
  assert.equal(gated, 4 * ((3 * 60 + 20) + (4 * 60 + 20)));
});
