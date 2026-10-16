/** Portable terminal evidence only: no retries, SDK imports, scheduler, or async context. */
export const PROVIDER_FAILURE_OBSERVER_VERSION = 1 as const;
export const PROVIDER_FAILURE_APIS = Object.freeze([
  "openai-completions", "mistral-conversations", "openai-responses", "azure-openai-responses",
  "openai-codex-responses", "anthropic-messages", "bedrock-converse-stream",
  "google-generative-ai", "google-vertex", "pi-messages",
] as const);
export interface ProviderFailure {
  readonly provider: string;
  readonly api?: string;
  readonly code: string;
  readonly message: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly providerRetryAfterMs?: number;
}
export type ProviderFailureListener = (failure: Readonly<ProviderFailure>) => void | Promise<void>;
const listeners = new Set<ProviderFailureListener>();
export function subscribeProviderFailures(listener: ProviderFailureListener): () => void {
  if (typeof listener !== "function") throw new TypeError("Provider failure listener must be a function");
  const entry: ProviderFailureListener = failure => listener(failure);
  listeners.add(entry);
  return () => { listeners.delete(entry); };
}
// Deliberately do not traverse prototypes, invoke getters, coerce values, or enumerate arbitrary keys.
function field(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try { const d = Object.getOwnPropertyDescriptor(value, key); return d && "value" in d ? d.value : undefined; }
  catch { return undefined; }
}
function machine(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 80 && /^[A-Za-z][A-Za-z0-9_]*$/.test(value) ? value.toLowerCase() : undefined;
}
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim().length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}
function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}
function delay(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2_147_483_647 ? value : undefined;
}
export function providerRetryAfterMs(headers: Pick<Headers, "get">, now = Date.now()): number | undefined {
  try {
    const ms = headers.get("retry-after-ms");
    if (ms !== null && (ms.length > 128 || /[\x00-\x1f\x7f]/.test(ms))) return undefined;
    if (ms !== null && /^\d+(?:\.\d+)?$/.test(ms.trim())) return delay(Number(ms));
    const raw = headers.get("retry-after");
    if (raw === null || raw.length > 128 || /[\x00-\x1f\x7f]/.test(raw)) return undefined;
    const text = raw.trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) return delay(Number(text) * 1000);
    if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return undefined;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && Number.isFinite(now) ? delay(Math.max(0, parsed - now)) : undefined;
  } catch { return undefined; }
}
// Unknown objects cannot supply a callable get(). Use the genuine platform Headers brand/method only.
function trustedHeaders(value: unknown): Pick<Headers, "get"> | undefined {
  try {
    if (typeof Headers === "undefined" || !(value instanceof Headers)) return undefined;
    const get = Headers.prototype.get;
    get.call(value, "retry-after");
    return { get: key => get.call(value, key) };
  } catch { return undefined; }
}
function headerRequestId(headers: Pick<Headers, "get">): string | undefined {
  for (const key of ["x-request-id", "request-id", "x-ms-request-id", "x-amzn-requestid"]) {
    const value = headers.get(key);
    if (identity(value)) return value;
  }
  return undefined;
}
const auth = new Set(["invalid_api_key", "invalid_credentials", "authentication_error", "unauthorized", "permission_denied", "access_denied", "forbidden", "account_deactivated", "accessdeniedexception", "unrecognizedclientexception"]);
const quota = new Set(["insufficient_quota", "usage_limit_reached", "usage_not_included", "quota_exceeded", "billing_error", "billing_hard_limit_reached", "monthly_usage_limit_reached", "free_usage_limit_error", "go_usage_limit_error", "servicequotaexceededexception"]);
const context = new Set(["context_length_exceeded", "context_window_exceeded"]);
const invalid = new Set(["invalid_request", "invalid_request_error", "bad_request", "content_policy_violation", "policy_violation", "request_too_large", "payload_too_large", "validationexception", "content_filter", "content_filtered", "refusal", "safety", "blocklist", "prohibited_content", "recitation", "spii", "malformed_function_call"]);
const server = new Set(["server_error", "overloaded_error", "internal_server_error", "service_unavailable", "internalserverexception", "serviceunavailableexception", "modelstreamerrorexception"]);
const rate = new Set(["rate_limit_exceeded", "rate_limit_error", "throttlingexception"]);
const network = new Set(["transport_error", "econnreset", "econnrefused", "epipe", "enotfound", "enetunreach", "eai_again", "und_err_socket", "und_err_connect_timeout"]);
const messages: Record<string, string> = {
  AUTH: "Provider authentication or access was rejected", QUOTA: "Provider quota or billing limit was reached",
  INVALID_REQUEST: "Provider rejected the request", CONTEXT_WINDOW_EXCEEDED: "Provider context window was exceeded",
  SERVER: "Provider server is temporarily unavailable", RATE_LIMIT: "Provider request was rate limited",
  TRANSPORT: "Provider transport failed", TIMEOUT: "Provider request timed out", ABORTED: "Provider request was cancelled",
};
/** Bounded evidence graph: at most 24 nodes and three edges deep; never inspect display strings. */
export function classifyProviderFailure(error: unknown, provider: string, api: string | undefined, aborted = false): Readonly<ProviderFailure> | undefined {
  if (!identity(provider) || (api !== undefined && !identity(api))) return undefined;
  const facts: unknown[] = [error];
  const seen = new Set<unknown>(facts);
  for (let start = 0, end = 1, depth = 0; depth < 3; depth++) {
    for (let i = start; i < end; i++) for (const key of ["payload", "error", "response", "cause", "$metadata"]) {
      const value = field(facts[i], key);
      if (value !== undefined && !seen.has(value) && facts.length < 24) { facts.push(value); seen.add(value); }
    }
    start = end; end = facts.length;
  }
  const codes = facts.flatMap(v => [machine(field(v, "code")), machine(field(v, "type")), machine(field(v, "name"))]).filter((v): v is string => v !== undefined);
  // fetch/AbortSignal expose inherited DOMException names, not own Error fields.
  // Invoke only the platform brand-checked getter, never an instance override.
  try {
    const getter = typeof DOMException === "undefined" ? undefined : Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;
    if (getter) for (const fact of facts) {
      try { const name = machine(getter.call(fact)); if (name === "aborterror" || name === "timeouterror") codes.push(name); } catch {}
    }
  } catch {}
  const statuses = facts.map(v => httpStatus(field(v, "status")) ?? httpStatus(field(v, "statusCode")) ?? httpStatus(field(v, "httpStatusCode"))).filter((v): v is number => v !== undefined);
  // A wrapper's transient status must not erase a nested permanent HTTP fact.
  const status = statuses.find(v => v === 401 || v === 403)
    ?? statuses.find(v => v >= 400 && v < 500 && ![408, 409, 429].includes(v)) ?? statuses[0];
  let hint = facts.map(v => delay(field(v, "providerRetryAfterMs"))).find(v => v !== undefined);
  let requestId = facts.flatMap(v => [field(v, "requestId"), field(v, "request_id"), field(v, "_request_id")]).find(identity);
  for (const fact of facts) {
    const headers = trustedHeaders(field(fact, "headers"));
    if (headers) { hint ??= providerRetryAfterMs(headers); requestId ??= headerRequestId(headers); }
  }
  const has = (set: Set<string>): boolean => codes.some(v => set.has(v));
  let code: string | undefined;
  if (aborted || codes.includes("aborterror") || codes.includes("abort_error")) code = "ABORTED";
  else if (has(auth) || status === 401 || status === 403) code = "AUTH";
  else if (has(quota)) code = "QUOTA";
  else if (has(context)) code = "CONTEXT_WINDOW_EXCEEDED";
  else if (has(invalid) || (status !== undefined && status >= 400 && status < 500 && ![408, 409, 429].includes(status))) code = "INVALID_REQUEST";
  else if (codes.includes("timeout_error") || codes.includes("timeouterror") || status === 408 || codes.includes("und_err_connect_timeout")) code = "TIMEOUT";
  else if (has(rate) || status === 429) code = "RATE_LIMIT";
  else if (has(server) || (status !== undefined && status >= 500)) code = "SERVER";
  else if (has(network)) code = "TRANSPORT";
  if (code === undefined) return undefined;
  return Object.freeze({ provider, ...(api === undefined ? {} : { api }), code, message: messages[code],
    ...(status === undefined ? {} : { status }), ...(requestId === undefined ? {} : { requestId }),
    ...(hint === undefined ? {} : { providerRetryAfterMs: hint }) });
}
/** Call only at terminal settlement, not at recoverable transport attempts. */
export function reportProviderFailure(error: unknown, provider: string, api: string | undefined, aborted = false): void {
  const failure = classifyProviderFailure(error, provider, api, aborted);
  if (failure === undefined) return;
  for (const listener of [...listeners]) {
    try { const result = listener(failure); if (result !== undefined) void Promise.resolve(result).catch(() => {}); }
    catch { /* Observability cannot break settlement. */ }
  }
}
export function classifyCodexFailure(error: unknown, aborted = false): Readonly<ProviderFailure> | undefined {
  return classifyProviderFailure(error, "openai-codex", undefined, aborted);
}
export function reportCodexFailure(error: unknown, provider: string, aborted = false): void {
  if (provider === "openai-codex") reportProviderFailure(error, provider, undefined, aborted);
}
/** This explicit HTTP boundary may decode JSON, never free-form text. Returned facts contain no body. */
export function codexHttpFailureFacts(status: number, headers: Pick<Headers, "get">, raw: string): {
  status: number; code?: string; type?: string; requestId?: string; providerRetryAfterMs?: number;
} {
  let decoded: unknown;
  try { decoded = raw.length <= 1_048_576 ? JSON.parse(raw) : undefined; } catch { decoded = undefined; }
  const error = field(decoded, "error") ?? decoded;
  const code = machine(field(error, "code")), type = machine(field(error, "type"));
  const trusted = trustedHeaders(headers);
  const hint = trusted ? providerRetryAfterMs(trusted) : undefined;
  const requestId = trusted ? headerRequestId(trusted) : undefined;
  return { status, ...(code === undefined ? {} : { code }), ...(type === undefined ? {} : { type }),
    ...(requestId === undefined ? {} : { requestId }), ...(hint === undefined ? {} : { providerRetryAfterMs: hint }) };
}
