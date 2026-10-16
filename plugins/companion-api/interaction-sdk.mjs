import { resolveInstalled } from '../session/host-paths.mjs';

// Match the product's running-install-first resolution without importing tool implementations.
export function resolveHost(id) {
  return resolveInstalled(id, 'Companion interaction metadata SDK unavailable.');
}
