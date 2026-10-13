#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../plugins/browser/config.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== '--live')) throw new Error('Usage: node tools/browser-tests.mjs [--live]');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'plugins', 'browser');
const tests = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(directory, name));
tests.push(join(directory, 'worker', 'runtime.test.mjs'), join(root, 'tools', 'browser-runtime.test.mjs'));
// Live is an explicit offline-fixture browser run, never a provider/credential call or dependency install.
const env = { ...process.env, DSH_BROWSER_LIVE: args[0] === '--live' ? '1' : '0', PLAYWRIGHT_BROWSERS_PATH: DEFAULT_CONFIG.browserCache };
delete env.NODE_OPTIONS;
const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, env, shell: false, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
