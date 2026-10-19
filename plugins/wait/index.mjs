import { defineTool, stringOutput, assertActive } from '../common.mjs';

export const name = 'alex-wait';
export const inject = ['tools'];

export const DEFAULT_WAIT_SECONDS = 1;
export const MIN_WAIT_SECONDS = 0.01;
export const MAX_WAIT_SECONDS = 86400; // 24 hours (1 day maximum)

/**
 * Formats a duration in seconds into a friendly string (e.g. "5s", "120s (~2.0m)", "7200s (~2.0h)").
 */
export function formatDuration(seconds) {
  if (seconds >= 3600) {
    const hours = (seconds / 3600).toFixed(1).replace(/\.0$/, '');
    return `${seconds}s (~${hours}h)`;
  }
  if (seconds >= 60) {
    const mins = (seconds / 60).toFixed(1).replace(/\.0$/, '');
    return `${seconds}s (~${mins}m)`;
  }
  return `${seconds}s`;
}

/**
 * Validates and normalizes parameters for the wait tool.
 * Accepts `seconds` as primary, but also supports `minutes`, `hours`, `duration`,
 * or millisecond variants (`ms`, `duration_ms`) to be resilient.
 */
export function parseWaitArgs(args = {}) {
  let totalSeconds;

  if (args.hours !== undefined) {
    const hrs = Number(args.hours);
    if (!Number.isFinite(hrs) || Number.isNaN(hrs)) {
      throw new Error(`hours must be a finite positive number; received: ${args.hours}`);
    }
    totalSeconds = hrs * 3600;
  } else if (args.minutes !== undefined) {
    const mins = Number(args.minutes);
    if (!Number.isFinite(mins) || Number.isNaN(mins)) {
      throw new Error(`minutes must be a finite positive number; received: ${args.minutes}`);
    }
    totalSeconds = mins * 60;
  } else {
    let rawSec = args.seconds;
    if (rawSec === undefined && args.duration !== undefined) rawSec = args.duration;
    if (rawSec === undefined && (args.ms !== undefined || args.duration_ms !== undefined)) {
      rawSec = (args.ms ?? args.duration_ms) / 1000;
    }
    if (rawSec === undefined) {
      rawSec = DEFAULT_WAIT_SECONDS;
    }
    totalSeconds = Number(rawSec);
  }

  if (!Number.isFinite(totalSeconds) || Number.isNaN(totalSeconds)) {
    throw new Error(`seconds must be a finite positive number; received: ${args.seconds}`);
  }
  if (totalSeconds < MIN_WAIT_SECONDS) {
    throw new Error(`Duration must be at least ${MIN_WAIT_SECONDS}s; received: ${totalSeconds}s`);
  }
  if (totalSeconds > MAX_WAIT_SECONDS) {
    throw new Error(`Duration cannot exceed ${MAX_WAIT_SECONDS}s (24 hours); received: ${totalSeconds}s`);
  }

  let reason = '';
  if (args.reason !== undefined && args.reason !== null) {
    if (typeof args.reason !== 'string') {
      throw new Error('reason must be a string if provided');
    }
    reason = args.reason.trim();
  }

  return { seconds: totalSeconds, reason };
}

/**
 * Pauses execution for the requested duration.
 * Hooks into AbortSignal for immediate, graceful cancellation.
 */
export async function waitDuration(seconds, reason, signal) {
  signal?.throwIfAborted();
  const ms = Math.round(seconds * 1000);

  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Wait operation aborted'));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      const suffix = reason ? ` (${reason})` : '';
      resolve(`Waited ${formatDuration(seconds)}${suffix}.`);
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: 'wait',
      description:
        'Wait for a specified duration before continuing. Use this instead of running sleep via bash or busy-polling when waiting for external conditions (e.g. servers starting, build watchers, ports opening, long-running external tasks, or debounce). Supports up to 24 hours (86400s).',
      parameters: {
        seconds: {
          type: 'number',
          description: `Duration to wait in seconds (e.g. 1, 2.5, 10, 300). Minimum ${MIN_WAIT_SECONDS}s, maximum ${MAX_WAIT_SECONDS}s (24h). Defaults to ${DEFAULT_WAIT_SECONDS}s.`,
        },
        minutes: {
          type: 'number',
          description: 'Alternative duration in minutes (e.g. 5, 30, 60). Converted to seconds.',
        },
        hours: {
          type: 'number',
          description: 'Alternative duration in hours (e.g. 1, 2, 8). Maximum 24 hours.',
        },
        reason: {
          type: 'string',
          description: 'Optional description of what is being waited for (e.g. "Waiting for Vite dev server on port 5173").',
        },
      },
      output: stringOutput,
      async execute(args, exec) {
        assertActive(exec);
        const { seconds, reason } = parseWaitArgs(args);
        return waitDuration(seconds, reason, exec.signal);
      },
    })
  );
}
