import { MAX_DELAY_MS, MAX_RETRIES, QUOTA_CODE, isEligibleFailure, localDelay, policyFromKey, policyKey, resolveConfig, resolvePolicy } from './policy.mjs';

/** One policy and cancellable timer owner; callers reserve their operation once. */
export function createController(config = {}, internals = {}) {
  const resolved = resolveConfig(config);
  const random = internals.random ?? Math.random;
  const setTimer = internals.setTimeout ?? internals.clock?.setTimeout?.bind(internals.clock) ?? setTimeout;
  const clearTimer = internals.clearTimeout ?? internals.clock?.clearTimeout?.bind(internals.clock) ?? clearTimeout;
  const lifetime = new AbortController();
  const waits = new Set();
  const policyFor = (provider, registeredPolicy) => resolvePolicy(resolved, provider, registeredPolicy);

  function plan({ provider, failure, previousRetry = 0, registeredPolicy, policy = policyFor(provider, registeredPolicy) }) {
    // Detached snapshots make explicit supplied policies as safe as policyFor's
    // immutable result; malformed/unbounded policies cannot widen this engine.
    if (registeredPolicy?.mode === 'normal' && registeredPolicy.maxRetries === 0) return;
    let captured;
    try { captured = policy?.mode === 'normal' && policyFromKey(provider, policyKey(policy)); } catch { return; }
    if (!captured) return;
    const current = policyFor(provider, registeredPolicy);
    const maxDelayMs = Math.min(captured.maxDelayMs, current.maxDelayMs, MAX_DELAY_MS);
    policy = Object.freeze({ ...captured,
      maxRetries: Math.min(captured.maxRetries, current.maxRetries, MAX_RETRIES),
      initialDelayMs: Math.min(captured.initialDelayMs, maxDelayMs), maxDelayMs,
      sourceExtension: Object.freeze({ antigravityQuotaReset: provider === 'google-antigravity' && policy.sourceExtension?.antigravityQuotaReset === true && current.sourceExtension.antigravityQuotaReset }),
    });
    if (lifetime.signal.aborted || !Number.isSafeInteger(previousRetry) || previousRetry < 0 || previousRetry >= policy.maxRetries || !isEligibleFailure(provider, failure, policy)) return;
    const retry = previousRetry + 1;
    const hint = failure.providerRetryAfterMs;
    const quota = failure.code === QUOTA_CODE;
    // An explicitly invalid/too-large server minimum must not become an earlier
    // local retry. Quota always requires its freshly captured positive hint.
    const hasHint = hint !== undefined;
    if ((hasHint || quota) && (!Number.isFinite(hint) || hint <= 0 || hint > policy.maxDelayMs)) return;
    // A server minimum may extend an interval, never collapse the exponential
    // schedule or create a separate quota-reset timer above the shared ceiling.
    const nominal = localDelay(policy, retry, random);
    const delayMs = hasHint ? Math.max(nominal, hint) : nominal;
    return Object.freeze({ provider, policy, policyKey: policyKey(policy), retry, delayMs, phase: 'recovery' });
  }

  function selfHealPlan(cycle) {
    // Compatibility view only: same backoff, not another recovery allowance.
    const policy = resolved.selfHeal;
    if (lifetime.signal.aborted || !Number.isSafeInteger(cycle) || cycle < 1 || cycle > policy.maxCycles) return;
    return Object.freeze({ phase: 'self-heal', retry: cycle, delayMs: localDelay(policy, cycle, random), policyKey: JSON.stringify(['self-heal', policy.maxCycles, policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio]) });
  }

  function wait(decision, signal) {
    signal = signal || undefined;
    if (lifetime.signal.aborted || signal?.aborted) return Promise.resolve(false);
    if (!decision || !Number.isFinite(decision.delayMs) || decision.delayMs < 0 || decision.delayMs > MAX_DELAY_MS) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      let timer, settled = false;
      const detach = () => {
        clearTimer(timer);
        signal?.removeEventListener('abort', onAbort);
        waits.delete(onAbort);
      };
      const finish = elapsed => {
        if (settled) return;
        settled = true;
        detach();
        resolve(elapsed && !signal?.aborted && !lifetime.signal.aborted);
      };
      const onAbort = () => finish(false);
      // One disposal walk rather than a lifetime listener per wait avoids Node's
      // listener warning for legitimate concurrent auxiliary/main recoveries.
      waits.add(onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      try { timer = setTimer(() => finish(true), Math.ceil(decision.delayMs)); }
      catch (error) { settled = true; detach(); reject(error); return; }
      // Also handle unusual injected signals/clocks that abort during setup.
      if (settled) clearTimer(timer);
      else if (signal?.aborted || lifetime.signal.aborted) finish(false);
    });
  }

  async function dispose() {
    lifetime.abort(new Error('llm-resilience disposed'));
    for (const cancel of [...waits]) cancel();
  }

  return Object.freeze({ recoveryVersion: 2, recoveryHistoryVersion: 2, config: resolved, policyFor, plan, selfHealPlan, wait, signal: lifetime.signal, dispose });
}
