import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// Machine-relative locations shared by the Companion plugins, the 3082 proxy and
// their tests. Same rules as plugins/common.mjs and the fish `dsh` launcher, but
// side-effect free: common.mjs eagerly imports dsh-tools, which the policy and
// metadata modules deliberately avoid. With the lab's HOME and no
// XDG_DATA_HOME/DSH_HOME, every value equals the literal it replaced.
// The XDG spec says to ignore a relative XDG_DATA_HOME; a relative anchor would also break createRequire.
const dataHome = isAbsolute(process.env.XDG_DATA_HOME ?? '') ? process.env.XDG_DATA_HOME : join(homedir(), '.local/share');
export const DSH_CLI_PACKAGE = join(dataHome, 'dsh-cli/package.json');
/** Anchor inside the installed CLI, for fixtures that boot the real public SDK. */
export const DSH_CLI_ANCHOR = join(dirname(DSH_CLI_PACKAGE), 'node_modules/@deepseek-ai/dsh/package.json');
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
/** Dedicated Companion cwd: Android-created sessions and session_create projects live below it. */
export const COMPANION_WORKSPACE_ROOT = join(homedir(), 'git/my/dsh-companion-workspace');
/** This checkout (plugins/session/../..), wherever it lives; on the lab, ~/git/my/dsh-customs. */
export const DSH_CUSTOMS_ROOT = resolve(import.meta.dirname, '../..');

/** Running install first (npx and dsh-cli can coexist), then the installed CLI. */
export function resolveInstalled(id, message = `Cannot resolve ${id} from the running DSH install.`) {
  for (const base of [process.argv[1], DSH_CLI_PACKAGE]) {
    if (typeof base !== 'string') continue;
    try { return createRequire(base).resolve(id); } catch { /* Try the next supported runtime resolver. */ }
  }
  throw new Error(message);
}
