import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PINS, RUNTIME_DIRECTORY, parseArguments, verifyManifest } from './browser-runtime.mjs';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('./browser-runtime.mjs', import.meta.url));
const fixture = () => ({
  manifest: { dependencies: { ...PINS } },
  lock: { lockfileVersion: 3, packages: { '': { dependencies: { ...PINS } }, ...Object.fromEntries(Object.entries(PINS).map(([name, version]) => [`node_modules/${name}`, { version }])), 'node_modules/playwright-core': { version: PINS.playwright } } },
});

test('default is metadata-only doctor; install must be explicit', () => {
  assert.deepEqual(parseArguments([]), { mode: 'doctor', engines: ['chromium'] });
  assert.deepEqual(parseArguments(['--doctor']), { mode: 'doctor', engines: ['chromium'] });
  assert.deepEqual(parseArguments(['--install']), { mode: 'install', engines: ['chromium'] });
});
test('only curated unique engines and fixed modes are accepted', () => {
  assert.deepEqual(parseArguments(['--install', '--engine', 'firefox', '--engine', 'webkit']), { mode: 'install', engines: ['firefox', 'webkit'] });
  for (const argv of [['--install', '--doctor'], ['--engine'], ['--engine', 'chrome'], ['--engine', 'chromium', '--engine', 'chromium'], ['--env', 'NODE_OPTIONS=evil'], ['--cache', '/tmp/product'], ['--with-deps'], ['--no-sandbox'], ['--command', 'npm'], ['--install;touch'], ['--help', '--install']]) assert.throws(() => parseArguments(argv));
});
test('manifest and lock must have exact direct pins plus stable core', () => {
  const { manifest, lock } = fixture();
  assert.doesNotThrow(() => verifyManifest(manifest, lock));
  for (const name of Object.keys(PINS)) {
    const bad = structuredClone(manifest); bad.dependencies[name] = `^${PINS[name]}`;
    assert.throws(() => verifyManifest(bad, lock));
    const badLock = structuredClone(lock); badLock.packages[`node_modules/${name}`].version = '0.0.0';
    assert.throws(() => verifyManifest(manifest, badLock));
  }
});
test('new packages, overrides, SDK1/alpha drift and broken locks fail closed', () => {
  const { manifest, lock } = fixture();
  assert.throws(() => verifyManifest({ dependencies: { ...manifest.dependencies, '@modelcontextprotocol/sdk': '1.32.1' } }, lock));
  assert.throws(() => verifyManifest({ ...manifest, overrides: { playwright: 'alpha' } }, lock));
  assert.throws(() => verifyManifest({ ...manifest, devDependencies: {} }, lock));
  const bad = structuredClone(lock); bad.packages['node_modules/playwright-core'].version = '1.64.0-alpha';
  assert.throws(() => verifyManifest(manifest, bad));
  assert.throws(() => verifyManifest(manifest, undefined));
});
test('invalid CLI is sanitized JSON and performs no command', async () => {
  const error = await run(process.execPath, [helper, '--install', '--engine', 'not-an-engine'], { cwd: tmpdir() }).then(() => null, failure => failure);
  assert.equal(error.code, 1);
  const result = JSON.parse(error.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BROWSER_RUNTIME_CHECK_FAILED');
  assert.equal(error.stderr, '');
});
test('real doctor from unrelated cwd ignores caller browser-cache override without launching', async () => {
  const { stdout, stderr } = await run(process.execPath, [helper, '--doctor'], { cwd: tmpdir(), env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/deliberately-not-a-product-cache' }, timeout: 15000 });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.runtimeDirectory, RUNTIME_DIRECTORY);
  assert.notEqual(result.browserCache, '/deliberately-not-a-product-cache');
  assert.equal(result.noBrowserLaunched, true);
  assert.equal(result.profilesModified, false);
  assert.equal(result.targetProjectModified, false);
  assert.ok(result.packages.every(item => item.matched));
  assert.equal(result.ready.videoRecording, true);
  assert.equal(result.ready.videoInspection, true);
});
