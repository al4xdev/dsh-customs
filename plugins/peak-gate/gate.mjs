// Pure decision logic for the peak-hour gate. Kept free of host imports so it
// is testable without a DSH install; index.mjs binds it to `llm/stream`.
//
// The gate only delays requests on providers that publish a peak/off-peak
// price (DeepSeek's official API: peak tokens cost double). It never rewrites
// a request, so a gated call is byte-identical to an ungated one once it runs.

import {
  DEFAULT_SCHEDULE,
  describeGate,
  formatClock,
  gateAt,
  normalizeSchedule,
} from '../wait/schedule.mjs';

export const HOUR_MS = 3_600_000;

/**
 * Defaults chosen so the widest gated interval fits inside maxWaitMs: the
 * 06:00-10:00 UTC window is 4h, and both margins add 20m on top.
 */
export const DEFAULT_GATE_CONFIG = Object.freeze({
  providers: Object.freeze(['deepseek-official']),
  mode: 'wait',
  maxWaitMs: 5 * HOUR_MS,
  waitSliceMs: 60_000,
});

/**
 * Validate and normalize plugin configuration.
 * Schedule fields are accepted flat so a profile row stays readable, and the
 * host's own time zone is the display default (configurable for containers).
 * @param config - raw loader config.
 * @returns frozen settings consumed by {@link planWait}.
 */
export function normalizeConfig(config = {}) {
  const providers = config.providers ?? DEFAULT_GATE_CONFIG.providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('peak-gate: providers must be a non-empty array of provider ids');
  }
  for (const provider of providers) {
    if (typeof provider !== 'string' || provider.length === 0) {
      throw new Error(`peak-gate: provider ids must be non-empty strings; received ${JSON.stringify(provider)}`);
    }
  }

  const mode = config.mode ?? DEFAULT_GATE_CONFIG.mode;
  if (mode !== 'wait' && mode !== 'refuse') {
    throw new Error(`peak-gate: mode must be "wait" or "refuse"; received ${JSON.stringify(mode)}`);
  }

  const positive = (name, fallback) => {
    const value = config[name] ?? fallback;
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`peak-gate: ${name} must be a positive number of milliseconds`);
    }
    return value;
  };

  const timeZone = config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone }).format(0);
  } catch {
    throw new Error(`peak-gate: timeZone ${JSON.stringify(timeZone)} is not a valid IANA zone`);
  }

  return Object.freeze({
    providers: Object.freeze([...providers]),
    mode,
    maxWaitMs: positive('maxWaitMs', DEFAULT_GATE_CONFIG.maxWaitMs),
    waitSliceMs: positive('waitSliceMs', DEFAULT_GATE_CONFIG.waitSliceMs),
    timeZone,
    enabled: config.enabled ?? true,
    schedule: normalizeSchedule(config.schedule ?? {
      peakWindowsUtc: config.peakWindowsUtc,
      weekdaysOnly: config.weekdaysOnly,
      holidays: config.holidays,
      preMarginMs: config.preMarginMs,
      postMarginMs: config.postMarginMs,
    }),
  });
}

/**
 * Decide whether one outgoing LLM request must be held.
 * @param options - the request envelope seen at the `llm/stream` waterfall.
 * @param settings - normalized settings.
 * @param nowMs - current instant.
 * @returns `{ wait: false }` or `{ wait: true, gate }` with the matched window.
 */
export function planWait(options, settings, nowMs) {
  if (!settings.enabled) return { wait: false };
  if (!settings.providers.includes(options?.provider)) return { wait: false };
  const gate = gateAt(nowMs, settings.schedule);
  if (!gate.gated) return { wait: false };
  return { wait: true, gate };
}

/**
 * Human-readable refusal, used when the remaining wait exceeds maxWaitMs or
 * mode is "refuse".
 * @param gate - matched gate from {@link planWait}.
 * @param settings - normalized settings.
 * @returns one-line message naming the resume clock time.
 */
export function refusalMessage(gate, settings) {
  return `deepseek peak hours: ${describeGate(gate, settings.timeZone)}; peak tokens cost double `
    + `(01:00-04:00 and 06:00-10:00 UTC, Mon-Fri). Set mode: wait or raise alex-peak-gate `
    + `maxWaitMs to hold the request instead of failing it.`;
}

/**
 * Sleep in bounded slices until the gate opens, re-evaluating every wake so a
 * clock jump, zone change or config reload can never strand the request.
 * @param signal - request abort signal; cancellation rejects immediately.
 * @param settings - normalized settings.
 * @param clock - current-time source.
 * @param onGate - called once with the first gate that is being waited out.
 * @returns the open gate state (snapshot).
 */
export async function waitForOffPeak({ signal, settings, clock = Date.now, onGate }) {
  let announced = false;
  for (;;) {
    signal?.throwIfAborted?.();
    const gate = gateAt(clock(), settings.schedule);
    if (!gate.gated) return gate;
    if (!announced) {
      announced = true;
      onGate?.(gate);
    }
    // Never sleep past a boundary: the next wake recomputes the real remainder.
    const slice = Math.max(1, Math.min(gate.waitMs, settings.waitSliceMs));
    await cancellableSleep(slice, signal);
  }
}

/**
 * Abort-aware sleep.
 * @param ms - duration in milliseconds.
 * @param signal - abort signal.
 * @returns resolves after the delay, rejects with the abort reason.
 */
export function cancellableSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
