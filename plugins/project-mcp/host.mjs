import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

/** Resolve the complete native graph from one host anchor, never mix CLI installs. */
export function hostRequire() {
  const anchors = [process.argv[1], join(homedir(), '.dsh', 'profiles', 'package.json')];
  for (const anchor of anchors) {
    if (!anchor || !isAbsolute(anchor)) continue;
    try {
      const require = createRequire(anchor);
      for (const id of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-mcp-client']) require.resolve(id);
      return require;
    } catch { /* An npx host is preferred; standalone tests use the shared profile. */ }
  }
  throw new Error('Cannot resolve native DSH packages from the running host or shared profile');
}

export async function nativeMcp() {
  const require = hostRequire();
  const path = require.resolve('@deepseek-ai/dsh-mcp-client');
  const fromMcp = createRequire(path);
  // Scope tags use a module-local Symbol. A second installation would make scoped
  // registrations accidentally global, so fail before launching any server.
  for (const id of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-scope']) {
    if (fromMcp.resolve(id) !== require.resolve(id)) throw new Error(`Native MCP package identity mismatch: ${id}`);
  }
  return import(path);
}
