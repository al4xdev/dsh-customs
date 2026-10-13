import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Scoped symbols and HarnessError identity must come from the running host's single graph. */
export function hostRequire() {
  for (const anchor of [process.argv[1], join(homedir(), '.dsh', 'profiles', 'package.json')]) {
    if (!anchor || !isAbsolute(anchor)) continue;
    try {
      const require = createRequire(anchor);
      const toolsPath = require.resolve('@deepseek-ai/dsh-tools');
      const fromTools = createRequire(toolsPath);
      for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-scope']) {
        if (fromTools.resolve(peer) !== require.resolve(peer)) throw new Error('Host peer identity mismatch');
      }
      return fromTools;
    } catch { /* Standalone tests fall back to the shared profile, not a second native installation. */ }
  }
  throw new Error('Cannot resolve browser native services from the running DSH graph.');
}

let native;
export function nativeTools() {
  return native ??= import(hostRequire().resolve('@deepseek-ai/dsh-tools'));
}

export async function nativeFailure(error) {
  const { HarnessError } = await import(hostRequire().resolve('@deepseek-ai/dsh-llm'));
  if (error instanceof HarnessError) return error;
  const code = typeof error?.code === 'string' ? error.code : 'BACKEND_ERROR';
  // Engine causes may contain private URLs/headers; only application-owned diagnostics cross this boundary.
  const message = error?.name === 'BrowserError' ? error.message : 'Browser operation failed; inspect owned session state before repeating a mutating action.';
  return new HarnessError(message, code);
}
