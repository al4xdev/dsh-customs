import { MAX_DELAY_MS, MAX_PROVIDER_WAIT_MS, QUOTA_CODE, isEligibleFailure, localDelay, policyFromKey, policyKey, providerMinimum, resolveConfig, resolvePolicy } from './policy.mjs';

/** Fixed refusal reasons: callers may log these verbatim (never failure prose). */
export const REFUSAL_REASONS = Object.freeze(['route-opt-out', 'unrepresentable-policy', 'controller-disposed', 'invalid-retry-ordinal',
  'retries-disabled', 'retry-budget-exhausted', 'ineligible-failure', 'quota-reset-without-hint', 'provider-wait-over-cap',
  // Caller-side classification refusal (status outside 100..599), same vocabulary.
  'invalid-failure-facts']);
const refused = reason => Object.freeze({ kind: 'refused', reason });
// Real waits are re-checked against the wall clock at least this often: Node
// timers follow CLOCK_MONOTONIC, which stops while the machine is suspended, so
// a 5h quota wait would otherwise still have most of it left after an 8h sleep.
export const WALL_CLOCK_SLICE_MS = 60_000;
// A caller's durable notBeforeMs is honored when computed at most this long
// before the wait starts; it may end the wait earlier only by that gap.
const NOT_BEFORE_SKEW_MS = 60_000;

/** One policy and cancellable timer owner; callers reserve their operation once. */
export function createController(config = {}, internals = {}) {
  const resolved = resolveConfig(config);
  const random = internals.random ?? Math.random;
  const setTimer = internals.setTimeout ?? internals.clock?.setTimeout?.bind(internals.clock) ?? setTimeout;
  const clearTimer = internals.clearTimeout ?? internals.clock?.clearTimeout?.bind(internals.clock) ?? clearTimeout;
  // Elapsed time is the earlier of two views: monotonic (immune to wall-clock
  // steps backwards) and wall clock (keeps advancing through system suspend).
  const now = internals.now ?? internals.clock?.now?.bind(internals.clock) ?? (() => performance.now());
  const wallNow = internals.wallNow ?? internals.clock?.wallNow?.bind(internals.clock) ?? Date.now;
  // Injected (virtual) timers are authoritative time and keep one timer per
  // wait unless a test asks for slicing; real timers are sliced.
  const virtualTimers = Boolean(internals.setTimeout ?? internals.clock?.setTimeout);
  const sliceMs = internals.wallClockSliceMs ?? (virtualTimers ? Infinity : WALL_CLOCK_SLICE_MS);
  if (!(sliceMs > 0)) throw new TypeError('wallClockSliceMs must be positive');
  const sliced = Number.isFinite(sliceMs);
  const lifetime = new AbortController();
  const waits = new Set();
  const policyFor = (provider, registeredPolicy) => resolvePolicy(resolved, provider, registeredPolicy);

  /** Decide one retry or return a fixed refusal reason; never waits or appends. */
  function schedule({ provider, failure, previousRetry = 0, registeredPolicy, policy = policyFor(provider, registeredPolicy) }) {
    // Detached snapshots make explicit supplied policies as safe as policyFor's
    // immutable result; malformed policies cannot widen this engine.
    if (registeredPolicy?.mode === 'normal' && registeredPolicy.maxRetries === 0) return refused('route-opt-out');
    let captured;
    try { captured = policy?.mode === 'normal' && policyFromKey(provider, policyKey(policy)); } catch { return refused('unrepresentable-policy'); }
    if (!captured) return refused('unrepresentable-policy');
    const current = policyFor(provider, registeredPolicy);
    const maxDelayMs = Math.min(captured.maxDelayMs, current.maxDelayMs, MAX_DELAY_MS);
    policy = Object.freeze({ ...captured,
      maxRetries: Math.min(captured.maxRetries, current.maxRetries),
      initialDelayMs: Math.min(captured.initialDelayMs, maxDelayMs), maxDelayMs,
      maxProviderWaitMs: Math.min(current.maxProviderWaitMs, MAX_PROVIDER_WAIT_MS),
      sourceExtension: Object.freeze({ antigravityQuotaReset: provider === 'google-antigravity' && policy.sourceExtension?.antigravityQuotaReset === true && current.sourceExtension.antigravityQuotaReset }),
    });
    if (lifetime.signal.aborted) return refused('controller-disposed');
    if (!Number.isSafeInteger(previousRetry) || previousRetry < 0) return refused('invalid-retry-ordinal');
    if (previousRetry >= policy.maxRetries) return refused(policy.maxRetries === 0 ? 'retries-disabled' : 'retry-budget-exhausted');
    if (!isEligibleFailure(provider, failure, policy)) return refused('ineligible-failure');
    const retry = previousRetry + 1;
    // Any adapter's typed minimum (Retry-After, quota reset) extends the local
    // interval up to the provider-wait ceiling. Absent/malformed minima simply
    // use the local schedule; the typed quota-reset class requires its own hint.
    const minimum = providerMinimum(failure);
    if (failure.code === QUOTA_CODE && minimum === undefined) return refused('quota-reset-without-hint');
    // Retrying before a declared minimum would not satisfy it: above the
    // ceiling the chain suspends visibly instead of starting an earlier retry.
    if (minimum > Math.max(policy.maxDelayMs, policy.maxProviderWaitMs)) return refused('provider-wait-over-cap');
    const nominal = localDelay(policy, retry, random);
    const delayMs = minimum === undefined ? nominal : Math.max(nominal, minimum);
    return Object.freeze({ kind: 'wait', provider, policy, policyKey: policyKey(policy), retry, delayMs, phase: 'recovery',
      ...(minimum === undefined ? {} : { minimumDelayMs: minimum }) });
  }

  function plan(input) {
    const decision = schedule(input);
    return decision.kind === 'wait' ? decision : undefined;
  }

  function selfHealPlan(cycle) {
    // Compatibility view only: same backoff, not another recovery allowance.
    const policy = resolved.selfHeal;
    if (lifetime.signal.aborted || !Number.isSafeInteger(cycle) || cycle < 1 || cycle > policy.maxCycles) return;
    return Object.freeze({ phase: 'self-heal', retry: cycle, delayMs: localDelay(policy, cycle, random), policyKey: JSON.stringify(['self-heal', policy.maxCycles, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio]) });
  }

  /** Resolve true when the retry may start, false on cancellation/disposal.
   * A wait ends when either the monotonic or the wall clock has covered the
   * delay (wall: `notBeforeMs`), re-checked at least every WALL_CLOCK_SLICE_MS.
   * An aborted `wake` signal (e.g. a live human message) ends the local backoff
   * early, but never before a provider-declared minimum (`minimumDelayMs`).
   * `onWoken` is called only when the wake actually shortened a pending wait.
   * A manual forward wall-clock change can end a wait early, like any
   * wall-clock deadline (provider resets are wall-clock instants anyway).
   */
  function wait(decision, signal, { wake, onWoken, notBeforeMs } = {}) {
    signal = signal || undefined;
    wake = wake || undefined;
    if (lifetime.signal.aborted || signal?.aborted) return Promise.resolve(false);
    if (!decision || !Number.isFinite(decision.delayMs) || decision.delayMs < 0 || decision.delayMs > MAX_PROVIDER_WAIT_MS) return Promise.resolve(false);
    const floor = Number.isFinite(decision.minimumDelayMs) && decision.minimumDelayMs > 0 ? Math.min(decision.minimumDelayMs, decision.delayMs) : 0;
    return new Promise((resolve, reject) => {
      let timer, settled = false, woken = false;
      const delay = decision.delayMs;
      const startMono = now(), startWall = wallNow();
      const fullWall = startWall + delay;
      const endWall = Number.isFinite(notBeforeMs) && notBeforeMs <= fullWall && notBeforeMs >= fullWall - NOT_BEFORE_SKEW_MS ? notBeforeMs : fullWall;
      let target = delay;
      const remaining = () => {
        const mono = startMono + target - now(), wall = endWall - (delay - target) - wallNow();
        return Math.min(Number.isFinite(mono) ? mono : 0, Number.isFinite(wall) ? wall : Infinity);
      };
      const detach = () => {
        clearTimer(timer);
        signal?.removeEventListener('abort', onAbort);
        wake?.removeEventListener('abort', onWake);
        waits.delete(onAbort);
      };
      const finish = elapsed => {
        if (settled) return;
        settled = true;
        detach();
        resolve(elapsed && !signal?.aborted && !lifetime.signal.aborted);
      };
      const tick = () => {
        if (settled) return;
        const left = remaining();
        if (!(left > 0)) finish(true); else arm(Math.ceil(Math.min(left, sliceMs)));
      };
      function arm(delayMs) {
        try { timer = setTimer(() => (sliced ? tick() : finish(true)), delayMs); }
        catch (error) { settled = true; detach(); reject(error); }
      }
      const onAbort = () => finish(false);
      const onWake = () => {
        if (settled || woken) return;
        woken = true;
        // Never longer than the original wait, never shorter than the minimum.
        target = Math.min(delay, floor);
        clearTimer(timer);
        try { onWoken?.(); } catch { /* attribution only; never blocks the retry */ }
        if (sliced) { tick(); return; }
        const elapsedMs = Math.max(0, Number.isFinite(now() - startMono) ? now() - startMono : 0);
        const left = Math.min(Math.ceil(delay), Math.max(0, Math.ceil(floor - elapsedMs)));
        if (left <= 0) finish(true); else arm(left);
      };
      // One disposal walk rather than a lifetime listener per wait avoids Node's
      // listener warning for legitimate concurrent auxiliary/main recoveries.
      waits.add(onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      wake?.addEventListener('abort', onWake, { once: true });
      arm(Math.ceil(sliced ? Math.min(delay, sliceMs) : delay));
      if (settled) { clearTimer(timer); return; }
      // Also handle unusual injected signals/clocks that abort during setup.
      if (signal?.aborted || lifetime.signal.aborted) finish(false);
      else if (wake?.aborted) onWake();
    });
  }

  async function dispose() {
    lifetime.abort(new Error('llm-resilience disposed'));
    for (const cancel of [...waits]) cancel();
  }

  // Contract 3: unbounded count by default, provider minima up to the provider
  // wait ceiling, fixed refusal reasons and wakeable waits. Owners of contract 2
  // must not bind to it, so it is published under a new capability name only.
  return Object.freeze({ recoveryVersion: 3, recoveryHistoryVersion: 3, config: resolved, policyFor, plan, schedule, selfHealPlan, wait, signal: lifetime.signal, dispose });
}
