// Read-only view of the peak schedule: what is gated, when it opens, and the
// next intervals. Used by `npm run peak:plan` and importable for tests.
//
// Why this exists: an owner deciding whether to keep `mode: wait` needs to see
// tonight's real boundaries in his own clock, not a doc table in UTC.

import { pathToFileURL } from 'node:url';
import { normalizeSchedule, gateAt, gateIntervalsAround, formatClock, formatSpan } from '../wait/schedule.mjs';
import { normalizeConfig } from './gate.mjs';

const stamp = (epochMs, timeZone) => {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(epochMs));
  return `${date} ${formatClock(epochMs, timeZone)}`;
};

/** Which published UTC window an interval came from, e.g. "01:00-04:00 UTC". */
function windowLabel(interval) {
  const hours = (ms) => String(new Date(ms).getUTCHours()).padStart(2, '0');
  return `${hours(interval.peakStartAt)}:00-${hours(interval.peakEndAt)}:00 UTC`;
}

/**
 * Gate intervals that start after `nowMs`, sorted.
 * @param nowMs - reference instant.
 * @param schedule - normalized schedule.
 * @param days - how far ahead to scan.
 * @returns intervals with `gateStartAt` in the future.
 */
export function upcomingIntervals(nowMs, schedule, days = 7) {
  const seen = new Set();
  const intervals = [];
  for (let offset = 0; offset <= days; offset += 1) {
    for (const interval of gateIntervalsAround(nowMs + offset * 86_400_000, schedule)) {
      const key = `${interval.peakStartAt}`;
      if (seen.has(key) || interval.gateStartAt <= nowMs) continue;
      seen.add(key);
      intervals.push(interval);
    }
  }
  return intervals.sort((a, b) => a.gateStartAt - b.gateStartAt);
}

/**
 * Render the current state and next intervals as plain lines.
 * @param nowMs - reference instant.
 * @param settings - result of {@link normalizeConfig}.
 * @param options - `{ days, limit }`.
 * @returns `{ state, lines }` where `state` is the current gate decision.
 */
export function renderPlan(nowMs, settings, { days = 7, limit = 12 } = {}) {
  const timeZone = settings.timeZone;
  const state = gateAt(nowMs, settings.schedule);
  const head = state.gated
    ? `now ${stamp(nowMs, timeZone)} ${timeZone} — GATED (${state.kind}, ${formatSpan(state.waitMs)} left, opens ${formatClock(state.resumeAt, timeZone)})`
    : `now ${stamp(nowMs, timeZone)} ${timeZone} — open`;
  const lines = upcomingIntervals(nowMs, settings.schedule, days)
    .slice(0, limit)
    .map((interval) => {
      const width = interval.gateEndAt - interval.gateStartAt;
      const localPeak = `${formatClock(interval.peakStartAt, timeZone)}-${formatClock(interval.peakEndAt, timeZone)}`;
      return `${stamp(interval.gateStartAt, timeZone)} → ${stamp(interval.gateEndAt, timeZone)}`
        + `  (${formatSpan(width)}, window ${windowLabel(interval)}, peak ${localPeak} local)`;
    });
  return { state, lines: [head, ...lines] };
}

function parseArgs(argv) {
  const options = { days: 7, limit: 12, timeZone: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days') options.days = Number(argv[++i]);
    else if (arg === '--limit') options.limit = Number(argv[++i]);
    else if (arg === '--tz') options.timeZone = argv[++i];
    else if (arg === '--json') options.json = true;
    else if (arg === '-h' || arg === '--help') { options.help = true; }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node plugins/peak-gate/plan.mjs [--days 7] [--limit 12] [--tz America/Sao_Paulo] [--json]');
    return 0;
  }
  if (!Number.isFinite(options.days) || options.days < 0) throw new Error('--days must be a non-negative number');
  if (!Number.isFinite(options.limit) || options.limit < 1) throw new Error('--limit must be a positive number');
  const settings = normalizeConfig({ timeZone: options.timeZone });
  const plan = renderPlan(Date.now(), settings, { days: options.days, limit: options.limit });
  if (options.json) {
    console.log(JSON.stringify({ state: plan.state, schedule: settings.schedule, timeZone: settings.timeZone }, null, 2));
  } else {
    for (const line of plan.lines) console.log(line);
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`peak-gate plan: ${error.message}`);
    process.exitCode = 2;
  }
}
