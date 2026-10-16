export const TRANSIENT_CODES = Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']);
export const RECOVERY_CODES = Object.freeze([...TRANSIENT_CODES, 'PI_AI_ERROR', 'INVALID_REQUEST']);
export const QUOTA_CODE = 'ANTIGRAVITY_QUOTA_RESET';
export const MAX_RETRIES = 10;
export const MAX_DELAY_MS = 3_600_000;
export const MAX_QUOTA_WAIT_MS = MAX_DELAY_MS;
// Anchor the tenth interval at one hour; the ninth is exactly thirty minutes.
export const DEFAULT_POLICY = Object.freeze({ mode: 'normal', maxRetries: MAX_RETRIES, initialDelayMs: MAX_DELAY_MS / 2 ** (MAX_RETRIES - 1), maxDelayMs: MAX_DELAY_MS, jitterRatio: 0, retryableCodes: RECOVERY_CODES });
export const DEFAULT_AUXILIARY = Object.freeze({ maxBufferBytes: 16_777_216, maxChunks: 65_536, replaySafePurposes: Object.freeze(['compaction', 'session-title']) });
export const DEFAULT_SELF_HEAL = Object.freeze({ maxCycles: DEFAULT_POLICY.maxRetries, initialDelayMs: DEFAULT_POLICY.initialDelayMs, maxDelayMs: DEFAULT_POLICY.maxDelayMs, jitterRatio: DEFAULT_POLICY.jitterRatio });

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${path} must be a plain object`);
}
function keys(value, allowed, path) {
  object(value, path);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${path}: unknown key ${key}`);
}
function number(value, path, min, max = Number.MAX_SAFE_INTEGER, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new TypeError(`${path} is out of range`);
  return value;
}
const policyFields = ['maxRetries', 'initialDelayMs', 'maxDelayMs', 'jitterRatio', 'retryableCodes'];
function policyPatch(input, path) {
  keys(input, policyFields, path);
  const patch = {};
  for (const key of policyFields) {
    if (!own(input, key)) continue;
    if (key === 'retryableCodes') {
      if (!Array.isArray(input[key]) || input[key].some(code => !RECOVERY_CODES.includes(code))) throw new TypeError(`${path}.retryableCodes must contain only known recovery codes`);
      patch[key] = Object.freeze([...new Set(input[key])]);
    } else patch[key] = number(input[key], `${path}.${key}`, key === 'maxRetries' || key === 'jitterRatio' ? 0 : 1, key === 'jitterRatio' ? 1 : key === 'maxRetries' ? MAX_RETRIES : MAX_DELAY_MS, key === 'maxRetries');
  }
  return Object.freeze(patch);
}
function backoffInvariant(policy, path) {
  if (policy.initialDelayMs > policy.maxDelayMs) throw new TypeError(`${path}.initialDelayMs must not exceed maxDelayMs`);
  return policy;
}

/** Global authority is explicit, not inferred from a registered resolved default.
 * Providers contain sparse patches in this same flat shape (not native backoff).
 */
export function resolveConfig(input = {}) {
  keys(input, ['policy', 'providers', 'auxiliary', 'selfHeal'], 'llm-resilience');
  const policy = Object.freeze(backoffInvariant({ ...DEFAULT_POLICY, ...policyPatch(input.policy === undefined ? {} : input.policy, 'policy') }, 'policy'));
  const providerInput = input.providers === undefined ? {} : input.providers;
  object(providerInput, 'providers');
  const providers = Object.create(null);
  for (const [provider, value] of Object.entries(providerInput)) {
    if (!provider) throw new TypeError('providers requires nonempty provider names');
    providers[provider] = policyPatch(value, `providers.${provider}`);
    backoffInvariant({ ...policy, ...providers[provider] }, `providers.${provider}`);
  }
  const auxiliaryInput = input.auxiliary === undefined ? {} : input.auxiliary;
  keys(auxiliaryInput, ['maxBufferBytes', 'maxChunks', 'replaySafePurposes'], 'auxiliary');
  const auxiliary = { ...DEFAULT_AUXILIARY, ...auxiliaryInput };
  for (const key of ['maxBufferBytes', 'maxChunks']) number(auxiliary[key], `auxiliary.${key}`, 1, Number.MAX_SAFE_INTEGER, true);
  if (!Array.isArray(auxiliary.replaySafePurposes) || auxiliary.replaySafePurposes.some(value => typeof value !== 'string' || !value.length)) throw new TypeError('auxiliary.replaySafePurposes requires nonempty strings');
  auxiliary.replaySafePurposes = Object.freeze([...new Set(auxiliary.replaySafePurposes)]);
  const selfInput = input.selfHeal === undefined ? {} : input.selfHeal;
  keys(selfInput, ['maxCycles', 'initialDelayMs', 'maxDelayMs', 'jitterRatio'], 'selfHeal');
  // This is an admission envelope, not a second budget or a base-policy cap.
  // Each operation still uses its effective route policy; an explicit route may
  // override a lower/zero base without being disabled only in the main driver.
  const recoveryEnvelope = Object.values(providers).reduce((cap, patch) => Math.max(cap, patch.maxRetries ?? policy.maxRetries), policy.maxRetries);
  const selfHeal = { maxCycles: recoveryEnvelope, initialDelayMs: policy.initialDelayMs, maxDelayMs: policy.maxDelayMs, jitterRatio: policy.jitterRatio };
  // Legacy callers may narrow admission, but cannot create another backoff.
  if (own(selfInput, 'maxCycles')) selfHeal.maxCycles = Math.min(recoveryEnvelope, number(selfInput.maxCycles, 'selfHeal.maxCycles', 0, MAX_RETRIES, true));
  for (const key of ['initialDelayMs', 'maxDelayMs', 'jitterRatio']) {
    if (own(selfInput, key) && selfInput[key] !== policy[key]) throw new TypeError(`selfHeal.${key} must match policy.${key}; recovery has one backoff`);
  }
  return Object.freeze({ policy, providers: Object.freeze(providers), auxiliary: Object.freeze(auxiliary), selfHeal: Object.freeze(selfHeal) });
}

export function resolvePolicy(config, provider, registeredPolicy) {
  const optedOut = registeredPolicy?.mode === 'normal' && registeredPolicy.maxRetries === 0;
  const quota = provider === 'google-antigravity' && registeredPolicy?.mode === 'normal' && Array.isArray(registeredPolicy.retryableCodes) && registeredPolicy.retryableCodes.includes(QUOTA_CODE);
  const effective = { ...config.policy, ...(own(config.providers, provider) ? config.providers[provider] : {}) };
  if (optedOut) effective.maxRetries = 0;
  return Object.freeze({ ...effective, mode: 'normal', retryableCodes: Object.freeze([...effective.retryableCodes, ...(quota ? [QUOTA_CODE] : [])]), sourceExtension: Object.freeze({ antigravityQuotaReset: quota }) });
}

/** Preserve the native finite-policy key layout, including old durable chains. */
export function policyKey(policy) {
  return JSON.stringify(['normal', policy.maxRetries, [...policy.retryableCodes].sort(), policy.initialDelayMs, policy.maxDelayMs, policy.jitterRatio]);
}

/** Restore a pinned native normal chain without changing its budget or key.
 * This is captured event provenance, never a comparison to provider defaults.
 */
export function policyFromKey(provider, key) {
  try {
    const [mode, maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio, ...rest] = JSON.parse(key);
    if (mode !== 'normal' || rest.length || !Array.isArray(retryableCodes) || retryableCodes.some(code => typeof code !== 'string')) return;
    number(maxRetries, 'maxRetries', 0, Number.MAX_SAFE_INTEGER, true);
    number(initialDelayMs, 'initialDelayMs', 1, 2_147_483_647);
    number(maxDelayMs, 'maxDelayMs', 1, 2_147_483_647);
    number(jitterRatio, 'jitterRatio', 0, 1);
    const policy = { mode, maxRetries, retryableCodes: Object.freeze([...retryableCodes]), initialDelayMs, maxDelayMs, jitterRatio, sourceExtension: Object.freeze({ antigravityQuotaReset: provider === 'google-antigravity' && retryableCodes.includes(QUOTA_CODE) }) };
    backoffInvariant(policy, 'captured policy');
    return Object.freeze(policy);
  } catch { return undefined; }
}

/** Typed permanent/cancel facts dominate a conflicting transient routing code. */
export function isEligibleFailure(provider, failure, policy) {
  if (!failure || typeof failure !== 'object' || failure.cancelled === true || failure.aborted === true || failure.permanent === true || failure.invalidFailureFacts === true) return false;
  if (failure.status !== undefined && (!Number.isInteger(failure.status) || failure.status < 100 || failure.status > 599)) return false;
  const malformedCall = failure.code === 'INVALID_REQUEST' && failure.diagnosticCategory === 'malformed-tool-call';
  if (['auth', 'authentication', 'authorization', 'permanent', 'cancel', 'cancelled', 'canceled', 'abort', 'policy', 'context'].includes(failure.category) || failure.category === 'invalid-request' && !malformedCall) return false;
  if (Number.isFinite(failure.status) && failure.status >= 400 && failure.status < 500 && ![408, 429].includes(failure.status)) return false;
  if (failure.code === QUOTA_CODE) return provider === 'google-antigravity' && policy.sourceExtension?.antigravityQuotaReset === true && policy.retryableCodes.includes(QUOTA_CODE);
  if (failure.code === 'INVALID_REQUEST' && !malformedCall) return false;
  return RECOVERY_CODES.includes(failure.code) && policy.retryableCodes.includes(failure.code);
}

export function localDelay(policy, retry, random) {
  // Clamp before multiplication to avoid Infinity * 0 at extreme finite budgets.
  const nominal = Math.min(policy.initialDelayMs * 2 ** Math.min(retry - 1, 1023), policy.maxDelayMs);
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) throw new TypeError('random must return a finite number in [0, 1]');
  return Math.min(nominal * (1 - policy.jitterRatio + 2 * policy.jitterRatio * sample), policy.maxDelayMs);
}
