import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve only public installed packages, both in-tree and in the normal CLI runtime.
// Never inspect a profile, credential record or private launch token to find imports.
const bases = [import.meta.url, join(homedir(), '.local/share/dsh-cli/package.json')];
export async function sdk(name) {
  for (const base of bases) {
    let filename;
    try { filename = createRequire(base).resolve(`@deepseek-ai/${name}`); } catch { continue; }
    return import(pathToFileURL(filename).href);
  }
  throw new Error('Companion download public SDK unavailable.');
}
