#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'session-companion/connection.json');
const stat = await lstat(file);
if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Connection file must be private and owned by the current user');
const link = JSON.parse(await readFile(file, 'utf8'));
const remote = new URL(link.tailscale);
if (remote.protocol !== 'https:' || remote.hostname !== 'dsh.tail37b3d7.ts.net' || remote.port !== '8443' || !remote.searchParams.has('token')) throw new Error('Unexpected companion connection endpoint');
const args = process.argv.slice(2);
if (args.length && !(args.length === 1 && args[0] === '--copy')) throw new Error('Use --copy or no arguments');
if (args[0] === '--copy') {
  // Send the startup secret through stdin, never command arguments or stdout.
  const child = spawn('wl-copy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise((resolve, reject) => { child.once('error', () => reject(new Error('wl-copy is unavailable'))); child.once('close', code => code === 0 ? resolve() : reject(new Error('Clipboard copy failed'))); });
  child.stdin.end(link.tailscale);
  await exited;
  console.log('Authenticated companion link copied. Treat it as a secret; paste only into your own DSH Mobile.');
} else {
  console.log(`Companion: ${remote.origin}\nUse --copy to copy the private startup link without printing its token.`);
}
