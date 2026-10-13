export class BrowserError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new BrowserError(code, message, details);
}

/** Do not serialize a raw engine/SDK cause chain: it may contain credentials or page text. */
export function safeError(error) {
  if (error instanceof BrowserError) {
    return { ...error.details, code: error.code, message: error.message };
  }
  return { code: 'BACKEND_ERROR', message: 'Browser operation failed. Inspect owned session state before repeating a mutating action.', effectState: 'unknown', retryable: false };
}
