export const MAX_REQUEST_BYTES = 1024 * 1024;
// Shared host <-> app contract (task132 A1): the native raw-byte upload route
// receives ONE file per request; the app caps a file at 20 MiB. The headroom
// absorbs nothing but rounding in the client's own size accounting: the body
// is the raw file, so there is no envelope to budget for.
export const UPLOAD_PATH = '/api/session/uploadFileBinary';
export const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_FILE_BYTES + 64 * 1024;

/**
 * Exact raw request-target match, before any decoding or normalization: an
 * encoded or dot-segment variant falls back to the smaller general budget,
 * which fails closed instead of widening some other route.
 */
export function isUploadRequest(req) {
  const target = req?.url;
  if (req?.method !== 'POST' || typeof target !== 'string') return false;
  const query = target.indexOf('?');
  return (query < 0 ? target : target.slice(0, query)) === UPLOAD_PATH;
}

/**
 * This carrier is the native node:http HTTP/1 server, not an HTTP/2 adapter.
 * Its parser frames bodies by Content-Length, or zero without a length/TE.
 * Refusing chunked input avoids replacing native streams or weakening the
 * attachment-aware SDK budget merely to enforce this smaller wire budget.
 * The upload route additionally REQUIRES a declared length: without one the
 * larger budget could only be enforced by buffering or a counting stream.
 */
export function classifyRequestBudget(req) {
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return { status: 400, code: 'invalid_body_framing' };
  if (req.httpVersionMajor !== undefined && req.httpVersionMajor !== 1) return { status: 400, code: 'unsupported_http_framing' };
  if (Object.hasOwn(headers, 'transfer-encoding')) return { status: 411, code: 'known_body_length_required' };
  const upload = isUploadRequest(req);
  if (!Object.hasOwn(headers, 'content-length')) return upload ? { status: 411, code: 'known_body_length_required' } : null;
  const length = headers['content-length'];
  if (typeof length !== 'string' || length.length > 16 || !/^\d+$/.test(length)) return { status: 400, code: 'invalid_body_framing' };
  const bytes = Number(length);
  if (!Number.isSafeInteger(bytes)) return { status: 400, code: 'invalid_body_framing' };
  return bytes > (upload ? MAX_UPLOAD_REQUEST_BYTES : MAX_REQUEST_BYTES) ? { status: 413, code: 'request_too_large' } : null;
}
