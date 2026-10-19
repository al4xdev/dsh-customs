// Peak/off-peak schedule for DeepSeek's official API, shared by the `wait`
// tool (cooperative pauses) and the `peak-gate` middleware (enforcement).
//
// Source: https://api-docs.deepseek.com/quick_start/pricing
//   "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00
//    and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public
//    holidays. All other hours are off-peak, including weekends and Chinese
//    public holidays in full."
//
// Two deliberate choices:
//   * Windows are declared in UTC because that is how the provider states them;
//     display is delegated to Intl with an explicit timeZone so nothing here
//     depends on the host's TZ.
//   * Chinese holidays are excluded by Beijing-local date, not UTC date: the
//     provider means the Chinese calendar day, and UTC+8 is the only place a
//     holiday can flip. Both shipped windows start at 09:00/14:00 Beijing, so
//     the distinction never bites today, but it keeps the model correct if a
//     window ever moves.

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const BEIJING_OFFSET_MS = 8 * HOUR_MS;

/** Shipped peak windows as [startHourUtc, endHourUtc) pairs. */
export const PEAK_WINDOWS_UTC = Object.freeze([
  Object.freeze([1, 4]),
  Object.freeze([6, 10]),
]);

/**
 * Default schedule. `holidays` stays empty until DeepSeek publishes the
 * Chinese calendar for the year: without it the gate over-triggers (a real
 * holiday is treated as peak), which only costs idle time, never money.
 */
export const DEFAULT_SCHEDULE = Object.freeze({
  peakWindowsUtc: PEAK_WINDOWS_UTC,
  weekdaysOnly: true,
  holidays: Object.freeze([]),
  preMarginMs: 10 * MINUTE_MS,
  postMarginMs: 10 * MINUTE_MS,
});

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Beijing-local calendar date ('YYYY-MM-DD') of one instant.
 * @param epochMs - instant in milliseconds.
 * @returns the Chinese calendar date carrying that instant.
 */
export function beijingDate(epochMs) {
  const shifted = new Date(epochMs + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Validate and normalize one schedule configuration.
 * @param config - raw `peakWindowsUtc`/`weekdaysOnly`/`holidays`/margin fields.
 * @returns a frozen schedule with defaults applied.
 */
export function normalizeSchedule(config = {}) {
  const windows = config.peakWindowsUtc ?? PEAK_WINDOWS_UTC;
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error('schedule: peakWindowsUtc must be a non-empty array of [startHour, endHour] UTC pairs');
  }
  const normalizedWindows = windows.map((window) => {
    if (!Array.isArray(window) || window.length !== 2) {
      throw new Error('schedule: every peak window must be a [startHour, endHour] pair');
    }
    const [start, end] = window;
    for (const hour of [start, end]) {
      if (!Number.isFinite(hour) || hour < 0 || hour > 24) {
        throw new Error(`schedule: peak window hours must be between 0 and 24; received ${hour}`);
      }
    }
    if (start === end) throw new Error('schedule: a peak window must have distinct start and end hours');
    return Object.freeze([start, end]);
  });

  const holidays = config.holidays ?? [];
  if (!Array.isArray(holidays)) throw new Error('schedule: holidays must be an array of YYYY-MM-DD strings');
  for (const date of holidays) {
    if (typeof date !== 'string' || !ISO_DATE.test(date)) {
      throw new Error(`schedule: holiday entries must be YYYY-MM-DD strings; received ${JSON.stringify(date)}`);
    }
  }

  const marginFor = (name, fallback) => {
    const value = config[name] ?? fallback;
    if (!Number.isFinite(value) || value < 0) throw new Error(`schedule: ${name} must be a non-negative number of milliseconds`);
    return value;
  };

  return Object.freeze({
    peakWindowsUtc: Object.freeze(normalizedWindows),
    weekdaysOnly: config.weekdaysOnly ?? DEFAULT_SCHEDULE.weekdaysOnly,
    holidays: Object.freeze([...new Set(holidays)]),
    preMarginMs: marginFor('preMarginMs', DEFAULT_SCHEDULE.preMarginMs),
    postMarginMs: marginFor('postMarginMs', DEFAULT_SCHEDULE.postMarginMs),
  });
}

/**
 * Gate intervals (peak window widened by its margins) for the UTC days
 * touching one instant. Margins can push a window into a neighbouring day, so
 * every lookup scans one day either side instead of assuming same-day bounds.
 * @param epochMs - instant in milliseconds.
 * @param schedule - normalized schedule.
 * @returns candidate intervals, unsorted.
 */
export function gateIntervalsAround(epochMs, schedule = DEFAULT_SCHEDULE) {
  const midnight = Math.floor(epochMs / DAY_MS) * DAY_MS;
  const intervals = [];
  for (const offset of [-1, 0, 1]) {
    const dayStart = midnight + offset * DAY_MS;
    const weekday = new Date(dayStart).getUTCDay();
    if (schedule.weekdaysOnly && (weekday === 0 || weekday === 6)) continue;
    for (const [startHour, endHour] of schedule.peakWindowsUtc) {
      const peakStartAt = dayStart + startHour * HOUR_MS;
      const peakEndAt = dayStart + endHour * HOUR_MS;
      const cnDate = beijingDate(peakStartAt);
      if (schedule.holidays.includes(cnDate)) continue;
      intervals.push({
        peakStartAt,
        peakEndAt,
        gateStartAt: peakStartAt - schedule.preMarginMs,
        gateEndAt: peakEndAt + schedule.postMarginMs,
        cnDate,
      });
    }
  }
  return intervals;
}

/**
 * Decide whether one instant sits inside a gated interval.
 * @param epochMs - instant in milliseconds.
 * @param schedule - normalized schedule.
 * @returns `{ gated: false }` outside every window, otherwise the matched
 * interval plus `kind` (which part of the window) and `waitMs` until it ends.
 */
export function gateAt(epochMs, schedule = DEFAULT_SCHEDULE) {
  const match = gateIntervalsAround(epochMs, schedule)
    .find((interval) => epochMs >= interval.gateStartAt && epochMs < interval.gateEndAt);
  if (match === undefined) return { gated: false, resumeAt: null, waitMs: 0 };
  const kind = epochMs < match.peakStartAt ? 'pre-margin' : epochMs < match.peakEndAt ? 'peak' : 'post-margin';
  return {
    gated: true,
    kind,
    resumeAt: match.gateEndAt,
    waitMs: match.gateEndAt - epochMs,
    ...match,
  };
}

/**
 * Format one instant as HH:MM in an explicit IANA time zone.
 * @param epochMs - instant in milliseconds.
 * @param timeZone - IANA zone name.
 * @returns zero-padded local clock time.
 */
export function formatClock(epochMs, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    // h23, not hour12: false: the latter reports local midnight as "24:00".
    hourCycle: 'h23',
  }).format(new Date(epochMs));
}

/**
 * Format a forward duration compactly (e.g. "2h05m", "42m", "35s").
 * @param ms - duration in milliseconds.
 * @returns human-readable duration.
 */
export function formatSpan(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${seconds > 0 ? String(seconds).padStart(2, '0') + 's' : ''}`;
  return `${seconds}s`;
}

/**
 * One-line description of a gated instant for logs, tool output and errors.
 * @param gate - result of {@link gateAt}.
 * @param timeZone - IANA zone used for the resume clock time.
 * @returns e.g. "off-peak in 2h05m (01:10 America/Sao_Paulo)".
 */
export function describeGate(gate, timeZone) {
  if (!gate.gated) return 'off-peak now';
  return `off-peak in ${formatSpan(gate.waitMs)} (${formatClock(gate.resumeAt, timeZone)} ${timeZone})`;
}

/**
 * Resolve a local "HH:MM" clock target to the next instant it occurs.
 * @param clock - "HH:MM" (24h) in `timeZone`.
 * @param nowMs - reference instant.
 * @param timeZone - IANA zone the clock string is read in.
 * @returns the next epoch millisecond strictly after `nowMs`.
 */
export function nextClockOccurrence(clock, nowMs, timeZone) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(clock ?? '').trim());
  if (match === null) throw new Error(`until: expected HH:MM (24h) in ${timeZone}; received ${JSON.stringify(clock)}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`until: ${clock} is not a valid time of day`);
  }
  // Walk forward minute-free: find the local date of `nowMs`, then its UTC offset.
  const desiredMinutes = hours * 60 + minutes;
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(nowMs + dayOffset * DAY_MS));
    const dayMidnight = zonedMidnight(localDate, timeZone);
    const candidate = dayMidnight + desiredMinutes * MINUTE_MS;
    if (candidate > nowMs) return candidate;
  }
  throw new Error(`until: could not resolve ${clock} in ${timeZone}`);
}

/**
 * UTC instant of local midnight for one 'YYYY-MM-DD' date in a zone.
 * @param date - local calendar date.
 * @param timeZone - IANA zone name.
 * @returns epoch milliseconds.
 */
function zonedMidnight(date, timeZone) {
  const [year, month, day] = ISO_DATE.exec(date).slice(1).map(Number);
  let instant = Date.UTC(year, month - 1, day);
  // One correction pass is exact for fixed-offset zones and lands within the
  // transition delta elsewhere; the second pass settles DST edges.
  for (let pass = 0; pass < 2; pass += 1) {
    instant = Date.UTC(year, month - 1, day) - zoneOffsetMs(instant, timeZone);
  }
  return instant;
}

/**
 * UTC offset of one zone at one instant.
 * @param epochMs - instant in milliseconds.
 * @param timeZone - IANA zone name.
 * @returns offset in milliseconds (negative west of Greenwich).
 */
function zoneOffsetMs(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const read = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second')) - epochMs;
}
