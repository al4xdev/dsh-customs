import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectRecipe, reserveDestination, resolvePaths, sha256, validateManifest } from './core.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scratchParent = join(repo, '.dumps/test-workshop');
mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
const scratch = realpathSync(mkdtempSync(join(scratchParent, 'core-')));
const fixture = () => ({
  schemaVersion: 1,
  runtime: { package: '@deepseek-ai/dsh', version: '0.2.0-rc.2' },
  prerequisites: { nodeMajorMinimum: 24 },
  components: [{ id: 'frontend', role: 'frontend', package: '@scope/frontend', version: '0.14.0', repository: 'https://github.com/example/frontend', commit: 'a'.repeat(40), packageManager: { name: 'pnpm', version: '11.21.0' }, reproduction: { status: 'ready' }, build: { strategy: 'pinned-source', commands: [{ command: 'pnpm', args: ['compile'], cwd: '.' }] } }],
});

test('valid pinned manifest and diverse home resolution', () => {
  const manifest = fixture();
  assert.equal(validateManifest(manifest), manifest);
  const paths = resolvePaths({ repo: scratch, home: '/home/another-user', xdgDataHome: '/mnt/data', dshHome: '/mnt/config/dsh', destination: '/mnt/work/new' });
  assert.equal(paths.runtime, '/mnt/data/dsh-cli');
  assert.equal(paths.dshHome, '/mnt/config/dsh');
  assert.equal(paths.destination, '/mnt/work/new');
  assert.throws(() => resolvePaths({ repo: '.', home: '/home/another-user' }));
  assert.throws(() => resolvePaths({ repo: scratch, home: '/home/user', destination: '../escape' }));
});

test('reject unknown fields, selectors, incomplete pins and malformed commands', () => {
  for (const mutate of [
    m => { m.extra = true; },
    m => { m.runtime.version = '^0.2.0'; },
    m => { m.components[0].version = 'latest'; },
    m => { m.components[0].version = '01.2.3'; },
    m => { m.components[0].version = '1.2.3-01'; },
    m => { m.components[0].commit = 'main'; },
    m => { m.components[0].packageManager.version = '11.x'; },
    m => { m.components[0].packageManager.extra = true; },
    m => { m.components[0].build.commands[0].cwd = '../escape'; },
    m => { m.components[0].build.commands[0].command = 'pnpm compile'; },
    m => { m.components[0].submodules = [{ path: '../vendor', commit: 'b'.repeat(40) }]; },
    m => { m.components.push(structuredClone(m.components[0])); },
    m => { m.components[0].reproduction = { status: 'blocked' }; },
  ]) {
    const m = fixture(); mutate(m); assert.throws(() => validateManifest(m));
  }
});

test('reject repository credentials, ssh, query tokens and local hosts', () => {
  for (const repository of ['git@github.com:example/frontend', 'ssh://github.com/example/frontend', 'https://token@github.com/example/frontend', 'https://github.com/example/frontend?token=secret', 'https://github.com/example/frontend#secret', 'https://localhost/project', 'https://127.0.0.1/project', 'https://host.internal/project']) {
    const m = fixture(); m.components[0].repository = repository;
    assert.throws(() => validateManifest(m));
  }
});

test('inspect checks exact patch bytes without modifying fixture', () => {
  const root = join(scratch, 'recipe'); mkdirSync(root);
  const patch = join(root, 'source.patch'); writeFileSync(patch, 'fixture patch\n');
  const m = fixture(); m.components[0].patch = { path: 'source.patch', sha256: sha256(readFileSync(patch)) };
  assert.equal(inspectRecipe({ repo: root, manifest: m }).ready, true);
  const before = readFileSync(patch);
  m.components[0].patch.sha256 = '0'.repeat(64);
  assert.match(inspectRecipe({ repo: root, manifest: m }).issues[0], /mismatch/);
  assert.deepEqual(readFileSync(patch), before);
  m.components[0].patch.path = 'missing.patch';
  assert.match(inspectRecipe({ repo: root, manifest: m }).issues[0], /ENOENT/);
  const external = join(scratch, 'external.patch'); writeFileSync(external, 'outside');
  symlinkSync(external, join(root, 'escape.patch'));
  m.components[0].patch = { path: 'escape.patch', sha256: sha256(readFileSync(external)) };
  assert.match(inspectRecipe({ repo: root, manifest: m }).issues[0], /escapes/);
  m.components[0].patch.path = '../external.patch';
  assert.throws(() => inspectRecipe({ repo: root, manifest: m }), /traversal/);
});

test('blocked or dirty-source recipe reports limitation honestly', () => {
  const m = fixture(); m.components[0].reproduction = { status: 'blocked', reason: 'Dirty checkout has no committed snapshot' };
  m.components[0].build.commands = [];
  const result = inspectRecipe({ repo: scratch, manifest: m });
  assert.equal(result.ready, false);
  assert.match(result.issues[0], /Dirty checkout/);
  assert.match(result.attestation, /not verified/);
});

test('exclusive reservation accepts scratch, refuses occupied and competing target', () => {
  const target = join(scratch, 'reserved');
  assert.equal(reserveDestination(target), target);
  assert.equal(statSync(target).mode & 0o777, 0o700);
  assert.throws(() => reserveDestination(target), /already exists/);
  const competitor = join(scratch, 'competitor'); mkdirSync(competitor);
  assert.throws(() => reserveDestination(competitor), /already exists/);
  const file = join(scratch, 'occupied'); writeFileSync(file, 'untouched');
  assert.throws(() => reserveDestination(file));
  assert.equal(readFileSync(file, 'utf8'), 'untouched');
});

test('two processes racing a destination cannot both reserve it', async () => {
  const target = join(scratch, 'raced');
  const coreURL = new URL('./core.mjs', import.meta.url).href;
  const script = `import { reserveDestination } from ${JSON.stringify(coreURL)}; try { reserveDestination(${JSON.stringify(target)}); } catch { process.exitCode = 1; }`;
  const attempt = () => new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', code => accept(code));
  });
  assert.deepEqual((await Promise.all([attempt(), attempt()])).sort(), [0, 1]);
  assert.equal(realpathSync(target), target);
});

test('reject traversal, protected overlap, ancestors and symlink parents', () => {
  const forbidden = join(scratch, 'protected'); mkdirSync(forbidden);
  for (const target of ['relative/path', scratch + '/../escape', '/', '/home', join(forbidden, 'child'), scratch]) assert.throws(() => reserveDestination(target, [forbidden]));
  const alias = join(scratch, 'alias'); symlinkSync(forbidden, alias);
  assert.throws(() => reserveDestination(join(alias, 'child')), /canonical/);
  const dangling = join(scratch, 'dangling'); symlinkSync(join(scratch, 'absent'), dangling);
  assert.throws(() => reserveDestination(dangling), /already exists/);
  const aliasRoot = join(scratch, 'protected-alias'); symlinkSync(forbidden, aliasRoot);
  assert.throws(() => reserveDestination(join(forbidden, 'new'), [aliasRoot]), /overlaps/);
});
