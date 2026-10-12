import { resolveHost } from '../common.mjs';

// The loop marker is a module-local WeakSet: resolve from the running host,
// not a private dependency installation beside this plugin.
const { isAgentLoopRequest } = await import(resolveHost('@deepseek-ai/dsh-llm'));

export const name = 'alex-codex-transient-close';
export const inject = ['llm'];

const nativeClose = /^WebSocket closed (1000|1012)(?: ([^\r\n]*))?$/;
const terminalReason = /auth|unauthori[sz]ed|forbidden|credential|token|quota|billing|usage[ _-]?limit|balance|policy|violation|message too big|payload too large|oversiz/i;

export function apply(ctx) {
  ctx.on('llm/stream', function (options, next) {
    if (options.provider !== 'openai-codex' || options.purpose !== undefined || !isAgentLoopRequest(options)) return next();
    return (async function* () {
      for await (const chunk of next()) {
        if (chunk.type !== 'finish' || chunk.reason.kind !== 'error' || options.signal?.aborted) {
          yield chunk;
          continue;
        }
        const failure = chunk.reason.failure;
        const match = nativeClose.exec(failure.message);
        if (failure.code !== 'PI_AI_ERROR' || /[\r\n]/.test(failure.message) || !match || terminalReason.test(match[2] ?? '') ||
            (failure.status !== undefined && failure.status >= 400 && failure.status < 500)) {
          yield chunk;
          continue;
        }
        // Change routing facts before the loop commits its failed attempt. The
        // official retry plugin alone owns budgets, delays, cancellation and audit.
        yield { ...chunk, reason: { ...chunk.reason, failure: { ...failure, code: 'TRANSPORT' } } };
      }
    })();
  }, { prepend: true });
}
