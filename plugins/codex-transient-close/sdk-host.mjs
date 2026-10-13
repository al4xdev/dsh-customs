import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveHost } from '../common.mjs';

/** Resolve the import-only SDK from the actual adapter, not the plugin's tree. */
export function resolveHostSdkEntry() {
  const adapter = realpathSync(resolveHost('@deepseek-ai/dsh-llm-pi-ai'));
  const roots = createRequire(adapter).resolve.paths('@earendil-works/pi-ai') ?? [];
  for (const root of roots) {
    const packageRoot = join(root, '@earendil-works/pi-ai');
    const manifestPath = join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // The reviewed SDK has a direct import condition. Refuse an unknown export
    // shape rather than selecting another installed SDK or a private subscriber.
    const entry = manifest.exports?.['.']?.import;
    if (manifest.name !== '@earendil-works/pi-ai' || typeof entry !== 'string' || !entry.startsWith('./')) throw new Error('Unsupported host pi-ai import export');
    const target = resolve(packageRoot, entry);
    if (!target.startsWith(resolve(packageRoot) + sep)) throw new Error('Host pi-ai export escaped package');
    return pathToFileURL(realpathSync(target)).href;
  }
  throw new Error('Cannot resolve pi-ai from the running host adapter');
}
