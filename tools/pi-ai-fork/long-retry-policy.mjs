// Deployment intent, not a retry engine: the provider adapter resolves this
// through dsh-llm; only the official retry plugin schedules or cancels waits.
export const longCodexRetryConfig = Object.freeze({
  mode: 'normal',
  maxRetries: 9,
  backoff: Object.freeze({ initialDelayMs: 5000, maxDelayMs: 1_200_000, jitterRatio: 0.1 }),
});
export const longCodexNominalDelays = Object.freeze([5000, 10000, 20000, 40000, 80000, 160000, 320000, 640000, 1_200_000]);
