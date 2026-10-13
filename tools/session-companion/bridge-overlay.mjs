#!/usr/bin/env node
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRoot } from '../../plugins/session/bridge-security.mjs';

if (process.argv.length !== 2) throw new Error('No arguments: prints a private overlay path for a new DSH launch');
const { root } = await prepareRoot();
// Each launch gets a different file: no update to a profile patch watched by
// existing TUIs, and subsequent launches cannot hot-reload this one's overlay.
const directory = await mkdtemp(join(root, 'launch-'));
await chmod(directory, 0o700);
const overlay = join(directory, 'bridge.patch.json');
await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'alex-session-bridge', name: fileURLToPath(new URL('../../plugins/session/bridge.mjs', import.meta.url)), config: { root } }] }]), { mode: 0o600, flag: 'wx' });
console.log(overlay);
