/** Select facts, never redact an arbitrary remote error into purportedly safe text. */
const codes = new Set(['PI_AI_ERROR', 'EMPTY_RESPONSE', 'INVALID_REQUEST']);
const blockedStatus = new Set([401, 402, 403, 429]);
const summaries = Object.freeze({
  PI_AI_ERROR: 'The previous model request returned an unclassified provider error.',
  EMPTY_RESPONSE: 'The previous model request returned no actionable answer.',
  INVALID_REQUEST: 'The previous model response contained a malformed function call.',
});
export function own(value, key) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; } catch { return undefined; }
}
export function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
/** A normalized host failure is frozen. Accessors/proxies are never evaluated. */
export function sanitizeFailure(failure, provider) {
  try {
    if (!failure || !Object.isFrozen(failure)) return undefined;
    const code = own(failure, 'code'), message = own(failure, 'message');
    const status = own(failure, 'status'), hint = own(failure, 'providerRetryAfterMs');
    if (!codes.has(code) || typeof message !== 'string') return undefined;
    if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599 || blockedStatus.has(status))) return undefined;
    if (hint !== undefined && (!Number.isSafeInteger(hint) || hint < 0 || hint > 2147483647)) return undefined;
    // Other 4xx errors are not evidence of a safely correctable request.
    if (status !== undefined && status >= 400 && status < 500) return undefined;
    let phase, terminalCategory;
    if (provider === 'google-antigravity' && message.length <= 256) {
      if (message === 'Anti Gravity returned an invalid response. [stage=sse]') phase = 'sse';
      if (message === 'Anti Gravity rejected this request by policy. [stage=sse-terminal; terminal=malformed-function-call]') {
        phase = 'sse-terminal'; terminalCategory = 'malformed-function-call';
      }
      // Known block/financial/guard/hook failures cannot be disguised as unknown
      // recoverable errors through a generic host wrapper code.
      if (/^Anti Gravity (?:authorization|billing|rejected this request by policy)/.test(message) && terminalCategory === undefined) return undefined;
    }
    if (code === 'INVALID_REQUEST' && terminalCategory !== 'malformed-function-call') return undefined;
    return Object.freeze({ code, summary: summaries[code],
      ...(status === undefined ? {} : { status }), ...(hint === undefined ? {} : { providerRetryAfterMs: hint }),
      ...(phase === undefined ? {} : { phase }), ...(terminalCategory === undefined ? {} : { terminalCategory }) });
  } catch { return undefined; }
}
/** Only configured public provider/model families are named, never error fields. */
export function routeFacts(provider, model) {
  if (provider !== 'openai-codex' && provider !== 'google-antigravity') return { provider: 'other-provider' };
  const knownModel = typeof model === 'string' && model.length <= 100 && /^(?:gpt-[0-9][a-z0-9.-]*|o[1-9][a-z0-9.-]*|claude-(?:opus|sonnet|haiku)-[0-9][a-z0-9-]*|gemini-[0-9][a-z0-9.-]*)$/.test(model);
  return { provider, ...(knownModel ? { model } : {}) };
}
export function usageFacts(usage) {
  const result = {};
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const value = own(usage, field);
    if (Number.isSafeInteger(value) && value >= 0) result[field] = value;
  }
  return result;
}
