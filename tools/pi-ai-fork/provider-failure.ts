/** Portable terminal-failure facts. This seam reports evidence, never schedules retries. */
export const PROVIDER_FAILURE_OBSERVER_VERSION = 1 as const;
export interface ProviderFailure {
  readonly provider: "openai-codex";
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
}
export type ProviderFailureListener = (failure: Readonly<ProviderFailure>) => void | Promise<void>;
const listeners = new Set<ProviderFailureListener>();
export function subscribeProviderFailures(listener: ProviderFailureListener): () => void {
  if (typeof listener !== "function") throw new TypeError("Provider failure listener must be a function");
  // Independent registrations of the same callback have independent lifetimes.
  const entry: ProviderFailureListener = failure => listener(failure);
  listeners.add(entry);
  return () => { listeners.delete(entry); };
}

// Own data properties only: unknown error objects may expose getters/prototypes.
function field(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && "value" in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}
function machine(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) ? value.toLowerCase() : undefined;
}
function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}
function delay(value: unknown): number | undefined {
  // Timer-safe; hints above the provider policy cap remain facts for the owner to refuse.
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2_147_483_647 ? value : undefined;
}
export function providerRetryAfterMs(headers: Pick<Headers, "get">, now = Date.now()): number | undefined {
  try {
    const ms = headers.get("retry-after-ms");
    if (ms !== null && /[\x00-\x1f\x7f]/.test(ms)) return undefined;
    if (ms !== null && /^\d+(?:\.\d+)?$/.test(ms.trim())) return delay(Number(ms));
    const raw = headers.get("retry-after");
    if (raw === null || /[\x00-\x1f\x7f]/.test(raw)) return undefined;
    const text = raw.trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return delay(Number(text) * 1000);
    // Reject controls, signs and arbitrary Date.parse coercions (e.g. '-1').
    if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return undefined;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && Number.isFinite(now) ? delay(Math.max(0, parsed - now)) : undefined;
  } catch { return undefined; }
}

const auth = new Set(["invalid_api_key", "invalid_credentials", "authentication_error", "unauthorized", "permission_denied", "access_denied", "forbidden", "account_deactivated"]);
const quota = new Set(["insufficient_quota", "usage_limit_reached", "usage_not_included", "quota_exceeded", "billing_error", "billing_hard_limit_reached", "monthly_usage_limit_reached", "free_usage_limit_error", "go_usage_limit_error"]);
const invalid = new Set(["invalid_request", "invalid_request_error", "bad_request", "content_policy_violation", "policy_violation", "request_too_large", "payload_too_large"]);
const server = new Set(["server_error", "overloaded_error", "internal_server_error", "service_unavailable"]);
const rate = new Set(["rate_limit_exceeded", "rate_limit_error"]);
const network = new Set(["transport_error", "econnreset", "econnrefused", "epipe", "enotfound", "enetunreach", "eai_again", "und_err_socket", "und_err_connect_timeout"]);
const messages: Record<string, string> = {
  AUTH: "Codex authentication or access was rejected",
  QUOTA: "Codex quota or billing limit was reached",
  INVALID_REQUEST: "Codex rejected the request",
  CONTEXT_WINDOW_EXCEEDED: "Codex context window was exceeded",
  SERVER: "Codex server is temporarily unavailable",
  RATE_LIMIT: "Codex request was rate limited",
  TRANSPORT: "Codex transport failed",
  TIMEOUT: "Codex request timed out",
  ABORTED: "Codex request was cancelled",
};

/** Unknown shapes/categories remain unknown; display text is deliberately never inspected. */
export function classifyCodexFailure(error: unknown, aborted = false): Readonly<ProviderFailure> | undefined {
  const payload = field(error, "payload");
  const response = field(payload, "response");
  const nested = field(payload, "error");
  const responseError = field(response, "error");
  const facts = [error, payload, nested, responseError, field(error, "cause")];
  const codes = facts.flatMap(value => [machine(field(value, "code")), machine(field(value, "type"))]).filter((value): value is string => value !== undefined);
  const names = [machine(field(error, "name"))];
  const status = facts.map(value => httpStatus(field(value, "status")) ?? httpStatus(field(value, "statusCode"))).find(value => value !== undefined);
  const hint = delay(field(error, "providerRetryAfterMs"));
  let code: string | undefined;
  const has = (set: Set<string>): boolean => codes.some(value => set.has(value));
  if (aborted || names.includes("aborterror")) code = "ABORTED";
  else if (has(auth) || status === 401 || status === 403) code = "AUTH";
  else if (has(quota)) code = "QUOTA";
  else if (codes.includes("context_length_exceeded") || codes.includes("context_window_exceeded")) code = "CONTEXT_WINDOW_EXCEEDED";
  else if (has(invalid) || (status !== undefined && status >= 400 && status < 500 && ![408, 409, 429].includes(status))) code = "INVALID_REQUEST";
  else if (codes.includes("timeout_error") || names.includes("timeouterror") || status === 408) code = "TIMEOUT";
  else if (has(rate) || status === 429) code = "RATE_LIMIT";
  else if (has(server) || (status !== undefined && status >= 500)) code = "SERVER";
  else if (has(network)) code = "TRANSPORT";
  if (code === undefined) return undefined;
  return Object.freeze({ provider: "openai-codex", code, message: messages[code],
    ...(status === undefined ? {} : { status }), ...(hint === undefined ? {} : { providerRetryAfterMs: hint }) });
}

/** Emit once from the provider's final catch, never from recoverable transport attempts. */
export function reportCodexFailure(error: unknown, provider: string, aborted = false): void {
  if (provider !== "openai-codex") return;
  const failure = classifyCodexFailure(error, aborted);
  if (failure === undefined) return;
  for (const listener of [...listeners]) {
    try { const result = listener(failure); if (result !== undefined) void Promise.resolve(result).catch(() => {}); }
    catch { /* Observability cannot break settlement. */ }
  }
}

/** Preserve only machine facts from an HTTP response; never return body/header/account data. */
export function codexHttpFailureFacts(status: number, headers: Pick<Headers, "get">, raw: string): {
  status: number; code?: string; type?: string; providerRetryAfterMs?: number;
} {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { decoded = undefined; }
  const error = field(decoded, "error");
  const code = machine(field(error, "code"));
  const type = machine(field(error, "type"));
  const hint = providerRetryAfterMs(headers);
  return { status, ...(code === undefined ? {} : { code }), ...(type === undefined ? {} : { type }),
    ...(hint === undefined ? {} : { providerRetryAfterMs: hint }) };
}
