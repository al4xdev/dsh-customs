import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DSH_CLI_PACKAGE } from '../../../plugins/session/host-paths.mjs';

/** Public persistence metadata only: no agent service, write handle, or event log. */
export async function createSessionCatalog({ root = join(homedir(), '.dsh/sessions'), runtimePackage = DSH_CLI_PACKAGE } = {}) {
  const require = createRequire(runtimePackage);
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
  const [{ Context }, persistence] = await Promise.all([load('cordis'), load('dsh-session-persistence-jsonl')]);
  const ctx = new Context();
  try {
    await ctx.plugin(persistence.default, { root, compression: 'zstd' });
    return {
      list: options => ctx.sessionPersistence.list(options),
      get: (id, options) => ctx.sessionPersistence.stat(id, options),
      close: () => ctx.fiber.dispose(),
    };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

export function companionMetadata(snapshot) {
  if (snapshot?.header?.agentPreset !== 'companion') return null;
  const header = snapshot.header;
  if (typeof header.id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(header.id)) return null;
  const metadata = snapshot.metadataSnapshot ?? snapshot.metadata ?? {};
  const row = { id: header.id };
  // Allowlist scalar metadata; never expose cwd, ancestry, credentials, or events.
  const title = metadata.title ?? snapshot.title;
  if (typeof title === 'string') row.title = title.slice(0, 240);
  for (const key of ['createdAt', 'updatedAt']) {
    const value = metadata[key] ?? snapshot[key] ?? header[key];
    if (typeof value === 'number' && Number.isFinite(value)) row[key] = value;
    else if (typeof value === 'string' && value.length <= 64) row[key] = value;
  }
  return row;
}
