export const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * This carrier is the native node:http HTTP/1 server, not an HTTP/2 adapter.
 * Its parser frames bodies by Content-Length, or zero without a length/TE.
 * Refusing chunked input avoids replacing native streams or weakening the
 * attachment-aware SDK budget merely to enforce this smaller wire budget.
 */
export function classifyRequestBudget(req) {
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return { status: 400, code: 'invalid_body_framing' };
  if (req.httpVersionMajor !== undefined && req.httpVersionMajor !== 1) return { status: 400, code: 'unsupported_http_framing' };
  if (Object.hasOwn(headers, 'transfer-encoding')) return { status: 411, code: 'known_body_length_required' };
  if (!Object.hasOwn(headers, 'content-length')) return null;
  const length = headers['content-length'];
  if (typeof length !== 'string' || length.length > 16 || !/^\d+$/.test(length)) return { status: 400, code: 'invalid_body_framing' };
  const bytes = Number(length);
  if (!Number.isSafeInteger(bytes)) return { status: 400, code: 'invalid_body_framing' };
  return bytes > MAX_REQUEST_BYTES ? { status: 413, code: 'request_too_large' } : null;
}
