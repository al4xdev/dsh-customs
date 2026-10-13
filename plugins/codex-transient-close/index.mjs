import { resolveHost } from '../common.mjs';
import { bridgeRequestFailures, captureProviderFailure } from './failure-bridge.mjs';
import { resolveHostSdkEntry } from './sdk-host.mjs';
const hostSdk = await import(resolveHostSdkEntry());

// The loop marker is a module-local WeakSet: resolve from the running host,
// not a private dependency installation beside this plugin.
const { isAgentLoopRequest } = await import(resolveHost('@deepseek-ai/dsh-llm'));

export const name = 'alex-codex-transient-close';
export const inject = ['llm'];

const nativeClose = /^WebSocket closed (1000|1012)(?: ([^\r\n]*))?$/;
const terminalReason = /auth|unauthori[sz]ed|forbidden|credential|token|quota|billing|usage[ _-]?limit|balance|policy|violation|message too big|payload too large|oversiz/i;

export function apply(ctx) { return applyWithObserver(ctx, hostSdk); }

// Explicit test seam, not profile/configuration: candidate SDK tests must use
// the very same package instance that produces the asynchronous error stream.
export function applyWithObserver(ctx, sdk) {
  const observerAvailable = sdk?.PROVIDER_FAILURE_OBSERVER_VERSION === 1 && typeof sdk.subscribeProviderFailures === 'function';
  if (observerAvailable) ctx.effect(() => sdk.subscribeProviderFailures(captureProviderFailure));
  ctx.on('llm/stream', function (options, next) {
    if (options.provider !== 'openai-codex' || options.purpose !== undefined || !isAgentLoopRequest(options)) return next();
    const legacy = (async function* () {
      for await (const chunk of next()) {
        if (chunk.type !== 'finish' || chunk.reason.kind !== 'error' || options.signal?.aborted) {
          yield chunk;
          continue;
        }
        const failure = chunk.reason.failure;
        const match = nativeClose.exec(failure.message);
        // Pi emits this exact fallback when a socket error event has no details.
        // Its cause is opaque: allow only bounded official recovery, not a broad
        // WebSocket/PI_AI_ERROR catch-all that would retry known permanent errors.
        const opaqueSocketError = failure.message === 'WebSocket error';
        if (failure.code !== 'PI_AI_ERROR' || /[\r\n]/.test(failure.message) || (!match && !opaqueSocketError) || terminalReason.test(match?.[2] ?? '') ||
            (failure.status !== undefined && failure.status >= 400 && failure.status < 500)) {
          yield chunk;
          continue;
        }
        // Change routing facts before the loop commits its failed attempt. The
        // official retry plugin alone owns budgets, delays, cancellation and audit.
        yield { ...chunk, reason: { ...chunk.reason, failure: { ...failure, code: 'TRANSPORT' } } };
      }
    })();
    return observerAvailable ? bridgeRequestFailures(options, () => legacy) : legacy;
  }, { prepend: true });
}
