import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { copyUpstreamLicense, reserveArtifactOutput } from '../pi-ai-fork/prepare.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(repo, '.dumps/workshop-license-tests');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const license = Buffer.from(`MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`);

async function fixture() {
  await mkdir(scratch, { recursive: true });
  return mkdtemp(join(scratch, 'case-'));
}
async function put(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: 'wx' });
}
async function environment(root) {
  const home = join(root, 'home'), userconfig = join(root, 'empty-userconfig'), globalconfig = join(root, 'empty-globalconfig');
  await mkdir(home);
  await writeFile(userconfig, '', { flag: 'wx', mode: 0o600 });
  await writeFile(globalconfig, '', { flag: 'wx', mode: 0o600 });
  return {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig, npm_config_audit: 'false', npm_config_fund: 'false',
  };
}
function packedFile(archive, wanted) {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/, '');
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, '').trim(), 8);
    if (!name) break;
    assert(Number.isSafeInteger(size) && size >= 0);
    if (name === wanted) return tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.fail(`Packed file missing: ${wanted}`);
}

test('offline npm pack retains the exact full upstream notice despite a dist-only files allowlist', async () => {
  const root = await fixture(), checkout = join(root, 'source'), staged = join(root, 'package');
  await put(join(checkout, 'LICENSE'), license);
  await put(join(staged, 'dist/index.js'), 'export const fixture = true;\n');
  await put(join(staged, 'never-run.mjs'), "throw new Error('Lifecycle scripts must stay disabled');\n");
  await put(join(staged, 'package.json'), JSON.stringify({
    name: '@workshop-fixture/pi-license', version: '0.87.1', private: true,
    license: 'MIT', files: ['dist'], scripts: { prepack: 'node never-run.mjs' },
  }));
  assert.equal(await copyUpstreamLicense(checkout, staged), digest(license));
  const result = JSON.parse(execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', root], {
    cwd: staged, env: await environment(root), encoding: 'utf8', timeout: 30_000,
  }));
  const packed = Array.isArray(result) ? result[0] : result['@workshop-fixture/pi-license'];
  assert(packed?.filename && packed.integrity);
  const archive = await readFile(join(root, packed.filename));
  assert.deepEqual(packedFile(archive, 'package/LICENSE'), license);
  assert.deepEqual(await readFile(join(staged, 'LICENSE')), license);
});

test('license copy preserves bytes and fails for missing or already staged notices', async () => {
  const root = await fixture(), checkout = join(root, 'source'), staged = join(root, 'package');
  await mkdir(checkout); await mkdir(staged);
  await assert.rejects(copyUpstreamLicense(checkout, staged), { code: 'ENOENT' });
  assert.deepEqual(await readdir(staged), []);
  const crlf = Buffer.from(license.toString().replaceAll('\n', '\r\n'));
  await put(join(checkout, 'LICENSE'), crlf);
  assert.equal(await copyUpstreamLicense(checkout, staged), digest(crlf));
  await assert.rejects(copyUpstreamLicense(checkout, staged), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(staged, 'LICENSE')), crlf);
});

test('artifact reservation refuses completed, partial, regular-file and dangling-link outputs without changes', async () => {
  const root = await fixture();
  for (const kind of ['completed', 'partial', 'file', 'link']) {
    const output = join(root, kind);
    if (kind === 'completed' || kind === 'partial') {
      await mkdir(output);
      if (kind === 'completed') {
        await put(join(output, 'historical.tgz'), 'immutable artifact sentinel');
        await put(join(output, 'provenance.json'), 'immutable provenance sentinel');
      }
    } else if (kind === 'file') await put(output, 'immutable file sentinel');
    else await symlink(join(root, 'missing'), output);
    const before = await lstat(output);
    await assert.rejects(reserveArtifactOutput(output), /already exists/);
    const after = await lstat(output);
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  }
  assert.equal(await readFile(join(root, 'completed/historical.tgz'), 'utf8'), 'immutable artifact sentinel');
  assert.equal(await readFile(join(root, 'completed/provenance.json'), 'utf8'), 'immutable provenance sentinel');
  await assert.rejects(reserveArtifactOutput('relative'), /absolute/);
});

test('concurrent artifact reservations have exactly one exclusive private winner', async () => {
  const root = await fixture(), output = join(root, 'new-parent/fresh');
  const attempts = await Promise.allSettled([reserveArtifactOutput(output), reserveArtifactOutput(output)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
});

test('real prepare CLI rejects a reused output before staging or compiling source fixtures', async () => {
  const root = await fixture(), checkout = join(root, 'source'), donor = join(root, 'donor'), outputRoot = join(root, 'artifacts');
  const source = 'export const fixture = true;\n', catalogBytes = '{"fixture":true}\n';
  await put(join(checkout, 'LICENSE'), license);
  await put(join(checkout, 'packages/ai/package.json'), JSON.stringify({ name: '@earendil-works/pi-ai', version: '0.87.1' }));
  await put(join(checkout, 'packages/ai/src/api/openai-codex-responses.ts'), source);
  await put(join(checkout, 'untouched.txt'), 'no workspace writes or compiler calls');
  await put(join(donor, '@earendil-works/pi-ai/package.json'), JSON.stringify({ version: '0.87.1' }));
  await put(join(donor, '@earendil-works/pi-ai/dist/providers/data/fixture.json'), catalogBytes);
  const catalogHash = createHash('sha256').update('fixture.json').update(catalogBytes).digest('hex');
  const output = join(outputRoot, `${digest(source).slice(0, 12)}-${catalogHash.slice(0, 12)}`);
  await put(join(output, 'historical.tgz'), 'unchanged tarball');
  await put(join(output, 'provenance.json'), 'unchanged provenance');
  const result = spawnSync(process.execPath, [join(repo, 'tools/pi-ai-fork/prepare.mjs'), checkout, donor, outputRoot], {
    cwd: repo, env: await environment(root), encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 1);
  assert.match(result.stderr, /Artifact output already exists/);
  assert.deepEqual((await readdir(output)).sort(), ['historical.tgz', 'provenance.json']);
  assert.equal(await readFile(join(output, 'historical.tgz'), 'utf8'), 'unchanged tarball');
  assert.equal(await readFile(join(output, 'provenance.json'), 'utf8'), 'unchanged provenance');
  assert.equal(await readFile(join(checkout, 'untouched.txt'), 'utf8'), 'no workspace writes or compiler calls');
  assert.deepEqual((await readdir(checkout)).sort(), ['LICENSE', 'packages', 'untouched.txt']);
});
