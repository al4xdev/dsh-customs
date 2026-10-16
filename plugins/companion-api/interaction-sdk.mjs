import { createRequire } from 'node:module';

// Match the product's running-install-first resolution without importing tool implementations.
export function resolveHost(id) {
  for (const base of [process.argv[1], '/home/alex/.local/share/dsh-cli/package.json']) {
    try { return createRequire(base).resolve(id); } catch {}
  }
  throw new Error('Companion interaction metadata SDK unavailable.');
}
