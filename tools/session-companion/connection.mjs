import { mkdir, lstat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const name = 'companion-private-connection-link';
export const inject = ['connection', 'webServer'];
export async function apply(ctx) {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'session-companion');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('Companion connection directory must be private and owned by the current user');
  const target = join(root, 'connection.json');
  const previous = await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || (previous.mode & 0o077) || previous.uid !== process.getuid())) throw new Error('Unsafe private connection file');
  const temporary = join(root, `connection-${randomUUID()}.tmp`);
  // Credentials remain in a private file, never stdout, journal or the model prompt.
  await writeFile(temporary, JSON.stringify({ local: ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`), tailscale: ctx.connection.authenticatedUrl('https://dsh.tail37b3d7.ts.net:8443'), createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, target);
}
