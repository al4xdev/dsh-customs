import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
const run = promisify(execFile);

test('startup bridge overlays are private and unique; existing patches are never touched', async () => {
  await mkdir(resolve('.dumps/session-tests'), { recursive: true });
  const home = await mkdtemp(resolve('.dumps/session-tests/launch-home-'));
  const script = resolve('tools/session-companion/bridge-overlay.mjs');
  const env = { ...process.env, DSH_HOME: home };
  const paths = [];
  for (let index = 0; index < 2; index++) {
    const { stdout, stderr } = await run(process.execPath, [script], { env });
    assert.equal(stderr, '');
    const file = stdout.trim(); paths.push(file);
    assert.ok(file.startsWith(join(home, 'session-companion/launch-')));
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    const patch = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(patch, [{ insert: [{ id: 'alex-session-bridge', name: resolve('plugins/session/bridge.mjs'), config: { root: join(home, 'session-companion') } }] }]);
  }
  assert.notEqual(paths[0], paths[1]);
  assert.equal((await lstat(join(home, 'session-companion'))).mode & 0o777, 0o700);
});
