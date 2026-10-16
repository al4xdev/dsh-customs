import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Same runtime location rule as the fish `dsh` launcher: XDG_DATA_HOME, else ~/.local/share.
const dshPackage = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'dsh-cli/package.json');
export function resolveHost(id) {
  // Prefer the running DSH install (npx and dsh-cli coexist); tests fall back to dsh-cli.
  for (const base of [process.argv[1], dshPackage]) {
    try { return createRequire(base).resolve(id); } catch {}
  }
  throw new Error(`Cannot resolve ${id} from the running DSH install.`);
}
export const { defineTool } = await import(resolveHost('@deepseek-ai/dsh-tools'));
export const stringOutput = { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] };
export function cwdOf(exec) { return exec.agent?.session.header.cwd ?? process.cwd(); }
export function assertActive(exec) { exec.signal?.throwIfAborted(); }
