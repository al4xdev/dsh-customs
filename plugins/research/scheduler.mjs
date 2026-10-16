const MAX_KEYS = 512;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;
const SHARED_KEY = Symbol.for('dsh.research.scheduler.v1');

export class SchedulerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SchedulerError';
    this.code = code;
    Object.assign(this, details);
  }
}

function invalid(message) {
  return new SchedulerError('INVALID_ARGUMENT', message);
}

function checkLimit(value) {
  if (value !== 1 && value !== 2) throw invalid('workers/limit must be 1 or 2');
}

function checkKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
    throw invalid('key must be a nonempty string of at most 256 characters');
  }
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/**
 * Limits and maxQueue apply per backend key, not across independent backends.
 * Pass a fixed backend/origin key, never a URL containing request parameters.
 * Owner configuration uses run(..., { limit: workers }): the minimum ever seen
 * for a key wins for this instance's lifetime, including after its queue empties.
 * Lowering a limit does not cancel already-running work; admissions wait for it.
 * No setWorkers: raising configuration must not widen an established limit.
 *
 * The registry retains at most 512 keys (including idle keys), then fails closed
 * with KEY_CAPACITY. Evicting idle entries would forget reduced limits/cooldowns.
 * Queued closures/listeners are removed on abort, cooldown, or admission.
 */
export function createScheduler({ workers = 2, maxQueue = 64, now = Date.now } = {}) {
  checkLimit(workers);
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) throw invalid('maxQueue must be a nonnegative safe integer');
  if (typeof now !== 'function') throw invalid('now must be a function');
  const states = new Map();

  function stateFor(key) {
    checkKey(key);
    let state = states.get(key);
    if (!state) {
      if (states.size >= MAX_KEYS) throw new SchedulerError('KEY_CAPACITY', 'Backend key capacity reached');
      state = { active: 0, queue: [], limit: workers, cooldownUntil: 0 };
      states.set(key, state);
    }
    return state;
  }

  function remaining(state) {
    return Math.min(MAX_COOLDOWN_MS, Math.max(0, state.cooldownUntil - now()));
  }

  function rateError(ms) {
    return new SchedulerError('RATE_LIMIT', 'Backend is cooling down', { retryAfterMs: ms });
  }

  function detach(entry) {
    entry.signal?.removeEventListener('abort', entry.onAbort);
  }

  function drain(state) {
    const cooldownMs = remaining(state);
    if (cooldownMs > 0) {
      for (const entry of state.queue.splice(0)) {
        detach(entry);
        entry.reject(rateError(cooldownMs));
      }
      return;
    }
    while (state.active < state.limit && state.queue.length > 0) {
      const entry = state.queue.shift();
      if (entry.signal?.aborted) {
        detach(entry);
        entry.reject(abortReason(entry.signal));
        continue;
      }
      start(state, entry);
    }
  }

  function start(state, entry) {
    entry.running = true;
    state.active++;
    // Caller cancellation only rejects its result. The real task owns the slot
    // until settlement, even if it ignores the signal or rejects much later.
    function finish(error, value, failed) {
      detach(entry);
      state.active--;
      if (failed) entry.reject(error);
      else entry.resolve(value);
      drain(state);
    }
    let result;
    try {
      result = entry.task(entry.signal);
    } catch (error) {
      finish(error, undefined, true);
      return;
    }
    // Both outcomes are observed; never race a task against cancellation and
    // release capacity from the caller-facing promise's finally handler.
    Promise.resolve(result).then(
      value => finish(undefined, value, false),
      error => finish(error, undefined, true),
    );
  }

  return Object.freeze({
    run(key, task, { signal, limit = workers } = {}) {
      return new Promise((resolve, reject) => {
        checkKey(key);
        checkLimit(limit);
        if (typeof task !== 'function') throw invalid('task must be a function');
        if (signal != null && (typeof signal.aborted !== 'boolean'
          || typeof signal.addEventListener !== 'function'
          || typeof signal.removeEventListener !== 'function')) throw invalid('signal must be an AbortSignal');
        if (signal?.aborted) {
          reject(abortReason(signal));
          return;
        }
        const state = stateFor(key);
        state.limit = Math.min(state.limit, limit, workers);
        const cooldownMs = remaining(state);
        if (cooldownMs > 0) {
          reject(rateError(cooldownMs));
          return;
        }
        if (state.active >= state.limit && state.queue.length >= maxQueue) {
          reject(new SchedulerError('QUEUE_FULL', 'Backend queue is full'));
          return;
        }
        const entry = { task, signal, resolve, reject, running: false, onAbort: undefined };
        entry.onAbort = () => {
          if (!entry.running) {
            const index = state.queue.indexOf(entry);
            if (index !== -1) state.queue.splice(index, 1);
          }
          detach(entry);
          reject(abortReason(signal));
        };
        signal?.addEventListener('abort', entry.onAbort, { once: true });
        if (state.active < state.limit && state.queue.length === 0) start(state, entry);
        else state.queue.push(entry);
      });
    },

    cooldown(key, retryAfterMs) {
      if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
        throw invalid('retryAfterMs must be a finite nonnegative number');
      }
      const state = stateFor(key);
      state.cooldownUntil = Math.max(state.cooldownUntil, now() + Math.min(MAX_COOLDOWN_MS, retryAfterMs));
      drain(state);
    },

    stats(key) {
      checkKey(key);
      const state = states.get(key);
      return state
        ? { active: state.active, queued: state.queue.length, limit: state.limit, cooldownMs: remaining(state) }
        : { active: 0, queued: 0, limit: workers, cooldownMs: 0 };
    },
  });
}

// Symbol.for survives cache-busted ESM imports and plugin/module reloads in the
// same JS global. Isolated factories deliberately do not use this registry.
export const sharedScheduler = globalThis[SHARED_KEY] ??= createScheduler();
export default sharedScheduler;
