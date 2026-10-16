#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileFiles, serviceFile } from './profile.mjs';
import { DSH_CLI_ANCHOR } from '../../plugins/session/host-paths.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const destination = join(home, 'profiles', 'companion');
const cliPath = process.env.DSH_COMPANION_CLI ?? join(dirname(DSH_CLI_ANCHOR), 'lib/bin.js');
const servicePath = join(homedir(), '.config/systemd/user/dsh-companion.service');
const write = process.argv.includes('--write');
if (process.argv.slice(2).some(arg => !['--write', '--plan'].includes(arg))) throw new Error('Use --plan or --write');
const files = profileFiles(repoRoot);
const unit = serviceFile({ cliPath, repoRoot });
if (write) {
  // Refuse replacement: an existing profile may contain personal choices or live sessions.
  if (existsSync(destination) || existsSync(servicePath)) throw new Error('Destination exists; inspect and edit explicitly instead of overwriting');
  if (!existsSync(join(home, 'profiles'))) throw new Error('DSH profiles parent is missing');
  if (!existsSync(cliPath)) throw new Error('DSH CLI is missing');
  if (!existsSync(join(repoRoot, 'plugins/session/index.mjs'))) throw new Error('Session plugin is missing');
  realpathSync(cliPath);
  mkdirSync(destination, { mode: 0o700 });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(destination, name), content, { mode: 0o600, flag: 'wx' });
  mkdirSync(dirname(servicePath), { recursive: true });
  writeFileSync(servicePath, unit, { mode: 0o600, flag: 'wx' });
}
console.log(JSON.stringify({ mode: write ? 'created' : 'plan', destination, servicePath, cliPath, files: Object.keys(files), networkChanges: false, startsService: false }, null, 2));
