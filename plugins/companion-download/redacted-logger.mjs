export const CARRIER_EVENT = 'Companion carrier event; details redacted.';

/** Ignore ALL untrusted payloads before the actual SDK Logger can buffer/export.
 * Severity survives; URL, body, stack, code, names and hostile getters never do.
 * This intentionally sacrifices carrier diagnostics, not persisted tool results.
 */
export function redactedCarrierLogger(logger) {
  const sink = logger('companion-download-carrier');
  const facade = {};
  for (const level of ['error', 'warn', 'info', 'debug']) {
    const emit = sink[level].bind(sink);
    facade[level] = function () { emit(CARRIER_EVENT); };
  }
  Object.freeze(facade);
  const adapter = function () { return facade; };
  return Object.freeze(Object.assign(adapter, facade));
}
