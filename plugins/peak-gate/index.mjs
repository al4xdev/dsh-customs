import { resolveHost } from '../common.mjs';
import { formatClock, formatSpan } from '../wait/schedule.mjs';
import { normalizeConfig, planWait, refusalMessage, waitForOffPeak } from './gate.mjs';

// LlmError keeps the refusal inside the harness failure vocabulary, so the
// turn reports a named error instead of an opaque throw from a middleware.
const { LlmError } = await import(resolveHost('@deepseek-ai/dsh-llm'));

export const name = 'alex-peak-gate';
export const inject = ['llm'];

export function apply(ctx, config = {}) {
  return applyWithClock(ctx, config, Date.now);
}

// Explicit test seam: the gate is all about time, so tests drive the clock
// instead of sleeping through a real window.
export function applyWithClock(ctx, config = {}, clock) {
  const settings = normalizeConfig(config);

  ctx.on('llm/stream', function peakGate(options, next) {
    // DSH_PEAK_GATE=off is the owner's escape hatch: a long off-peak batch run
    // must never depend on editing and reloading a profile.
    if (process.env.DSH_PEAK_GATE === 'off') return next();
    const plan = planWait(options, settings, clock());
    if (!plan.wait) return next();

    if (settings.mode === 'refuse' || plan.gate.waitMs > settings.maxWaitMs) {
      throw new LlmError(refusalMessage(plan.gate, settings), 'PEAK_HOURS');
    }

    const label = `${options.provider} held until ${formatClock(plan.gate.resumeAt, settings.timeZone)} ${settings.timeZone}`;
    ctx.logger?.info?.(`peak-gate: ${label} (${formatSpan(plan.gate.waitMs)} left)`);
    return (async function* () {
      // Nothing is yielded before the gate opens: the agent loop only starts
      // the attempt (and its first-token clock) after this first await.
      await waitForOffPeak({ signal: options.signal, settings, clock });
      ctx.logger?.info?.(`peak-gate: released ${options.provider}`);
      yield* next();
    })();
  });
}
