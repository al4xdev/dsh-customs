#!/usr/bin/env node
// Small in-memory CST fixture only: no writes, profiles, builds or model calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'), 'profiles/noop.js'));
const YAML = require('yaml');
const generator = readFileSync(join(root, 'tools/activate.mjs'), 'utf8');
const functions = generator.slice(generator.indexOf('// --- rendering'), generator.indexOf('// --- main'));
const fixture = '# untouched\n- id: plan-mode\n  config: { custom: true }\n- insert:\n    - id: alex-old\n      name: /old\n    - id: local\n      name: /custom # retained\n';
const context = vm.createContext({ resolve, existsSync: () => true, readFileSync: () => fixture, writeFileSync: () => { throw Error('Unexpected write'); } });
vm.runInContext(functions, context);
const manifest = { managedIdPrefix: 'alex-', plugins: [
  { id: 'alex-default', module: 'default.mjs' },
  { id: 'alex-explicit', module: 'explicit.mjs', overlay: true, profiles: ['other'] },
  { id: 'alex-isolated', module: 'isolated.mjs', profiles: ['dsh-tui-task10'], overlay: false },
] };
const overlay = context.desiredEntries(manifest, null, root);
assert.deepEqual(Array.from(overlay, entry => entry.id), ['alex-default', 'alex-explicit']);
assert.deepEqual(Array.from(context.desiredEntries(manifest, 'web', root), entry => entry.id), ['alex-default']);
assert.deepEqual(Array.from(context.desiredEntries(manifest, 'dsh-tui-task10', root), entry => entry.id), ['alex-default', 'alex-isolated']);
const result = context.syncFile('/fixture', 'overlay', overlay, { write: false }, YAML, manifest);
assert.equal(result.error, undefined);
assert.ok(!result.block.includes('alex-isolated'));
assert.equal(result.current, '    - id: alex-old\n      name: /old\n');
assert.equal(fixture.replace(result.current, result.block).split('    - id: local')[1], '\n      name: /custom # retained\n');
console.log('PASS: default-preserving overlay exclusion and narrow CST replacement');
