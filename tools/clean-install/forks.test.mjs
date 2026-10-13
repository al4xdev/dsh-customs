import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { antigravityHostPackage, buildForks, loadForkManifest, validateForkManifest } from './forks.mjs';

const agPackage = {
  name: '@deepseek-ai/dsh-llm-pi-ai-antigravity', version: '0.1.0-rc.5', private: true,
  main: 'lib/index.js', exports: { '.': { default: './lib/index.js' }, './client': './lib/client.js' },
  files: ['lib', 'src', 'cordis.patch.yml'], scripts: { bundle: 'unavailable-shared-workspace' },
  peerDependencies: { '@deepseek-ai/dsh-client-runtime': '*', '@deepseek-ai/cordis': '4.0.4' },
  peerDependenciesMeta: { other: { optional: true } }, dependencies: { '@earendil-works/pi-ai': '^0.82.1' },
};

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-clean-forks-'));
  const sourcesRoot = join(root, 'sources'), artifactsRoot = join(root, 'artifacts'), toolchainRoot = join(root, 'tools');
  for (const directory of [sourcesRoot, artifactsRoot, toolchainRoot]) await mkdir(directory);
  const manifest = await loadForkManifest();
  const calls = [];
  async function spawn(command, args, options) {
    calls.push({ command, args, options });
    assert.equal(options.shell, false);
    assert.equal(options.env.HOME, join(root, 'isolated-home'));
    if (overrides.fail?.(command, args, options)) return { status: 1, stdout: '' };
    if (args[0] === '--version') return { status: 0, stdout: command.endsWith('pnpm') ? '11.21.0\n' : `${overrides.esbuildVersion ?? '0.28.2'}\n` };
    if (args.includes('clone')) {
      const source = args.at(-1), id = source.endsWith('/tui') ? 'tui' : 'antigravity';
      const metadata = id === 'tui' ? { name: manifest.components[0].package, version: '0.14.0', packageManager: 'pnpm@11.21.0' } : agPackage;
      await mkdir(join(source, '.git'));
      await mkdir(join(source, 'src'));
      await writeFile(join(source, 'src/index.ts'), id === 'tui' ? 'export const retryPolicies = true;\n' : 'export const v4 = true;\n');
      await writeFile(join(source, 'package.json'), JSON.stringify(metadata));
      for (const name of id === 'tui' ? ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json'] : ['tsconfig.standalone.json']) {
        await writeFile(join(source, name), '{}\n');
      }
      if (id === 'tui') {
        await writeFile(join(source, '.gitmodules'), '[submodule "vendor/dsh-std"]\n path = vendor/dsh-std\n url = https://github.com/T-Auto/dsh-std.git\n');
      } else {
        await mkdir(join(source, 'lib/types'), { recursive: true });
        await writeFile(join(source, 'lib/index.js'), 'committed old host bundle');
        await writeFile(join(source, 'lib/client.js'), 'committed browser face');
        await writeFile(join(source, 'lib/types/index.d.ts'), 'committed declarations');
        await writeFile(join(source, 'cordis.patch.yml'), '- insert: []\n');
      }
      return { status: 0, stdout: '' };
    }
    if (args.includes('submodule')) {
      await mkdir(join(options.cwd, 'vendor/dsh-std'), { recursive: true });
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'rev-parse') {
      const pin = options.cwd.endsWith('/vendor/dsh-std') ? manifest.components[0].submodule.commit : manifest.components[options.cwd.endsWith('/tui') ? 0 : 1].commit;
      return { status: 0, stdout: `${overrides.wrongHead ? '0'.repeat(40) : pin}\n` };
    }
    if (args[0] === 'status') return { status: 0, stdout: overrides.dirty ? ' M src/index.ts\n' : '' };
    if (args[0] === 'compile') {
      await mkdir(join(options.cwd, 'lib'));
      await writeFile(join(options.cwd, 'lib/index.js'), 'compiled TUI OAuth32');
      if (overrides.mutateSource) await writeFile(join(options.cwd, 'src/index.ts'), 'unexpected concurrent change');
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'src/index.ts') {
      await writeFile(args.find(value => value.startsWith('--outfile=')).slice('--outfile='.length), overrides.legacyImport ? 'import "@deepseek-ai/dsh-client-runtime"' : 'compiled V4 host bundle');
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'pack') {
      const metadata = JSON.parse(await readFile(join(options.cwd, 'package.json'), 'utf8'));
      const destination = args.at(-1), filename = overrides.filename ?? `${destination.endsWith('/tui') ? 'tui' : 'antigravity'}.tgz`;
      if (!filename.includes('/')) await writeFile(join(destination, filename), 'synthetic tarball fixture, not a real build');
      const pack = { name: metadata.name, version: metadata.version, filename };
      return { status: 0, stdout: JSON.stringify(overrides.npm12 ? { [metadata.name]: pack } : [pack]) };
    }
    return { status: 0, stdout: '' };
  }
  return { sourcesRoot, artifactsRoot, toolchainRoot, spawn, env: { HOME: join(root, 'isolated-home'), PATH: '/synthetic-only' }, manifest, calls, root };
}

test('manifest pins current OAuth32 and AGV4 quota-policy forks rather than historical workshop', async () => {
  const manifest = await loadForkManifest();
  assert.equal(manifest.components[0].commit, 'ebea5d738481bbc7c35006410ad9ce1a998dc883');
  assert.equal(manifest.components[1].commit, '77c0c0fe39c0ddfa9647400db6d4726720aa7852');
  assert.match(manifest.components[1].qualification, /committed-prebuilt/);
  assert.match(manifest.components[1].qualification, /quota-reset-24h/);
  assert.match(manifest.components[1].qualification, /opt-in\/default off/);
});

test('rejects credentials in manifest URLs and unreviewed strategy changes', async () => {
  const manifest = await loadForkManifest();
  const credentials = structuredClone(manifest);
  credentials.components[0].repository = 'https://user:secret@github.com/al4xdev/dsh-TUI.git';
  assert.throws(() => validateForkManifest(credentials), /credential-free/);
  const strategy = structuredClone(manifest);
  strategy.components[1].strategy = 'all-source-rebuilt';
  assert.throws(() => validateForkManifest(strategy));
});

test('host metadata patch preserves dependencies and auxiliary export declarations', () => {
  const patched = antigravityHostPackage(agPackage, 'export const host = true;');
  assert.deepEqual(patched.dependencies, agPackage.dependencies);
  assert.deepEqual(patched.exports, agPackage.exports);
  assert.deepEqual(patched.scripts, {});
  assert.equal(patched.peerDependenciesMeta['@deepseek-ai/dsh-client-runtime'].optional, true);
  assert.equal(patched.peerDependenciesMeta.other.optional, true);
  assert.equal(agPackage.peerDependenciesMeta['@deepseek-ai/dsh-client-runtime'], undefined);
});

test('optional legacy peer guard refuses generated JS imports and changed peer context', () => {
  assert.throws(() => antigravityHostPackage(agPackage, 'import "@deepseek-ai/dsh-client-runtime"'), /references legacy/);
  assert.throws(() => antigravityHostPackage({ ...agPackage, peerDependencies: {} }, ''), /context changed/);
});

test('fixture build verifies independent Git pins, compiles TUI and only AG host entry', async () => {
  const input = await fixture();
  const result = await buildForks(input);
  assert.equal(result.components.tui.sourceCommit, input.manifest.components[0].commit);
  assert.equal(result.components.antigravity.sourceCommit, input.manifest.components[1].commit);
  assert.deepEqual(Object.keys(result.components.antigravity.compiledFiles), ['index.js']);
  assert.deepEqual(Object.keys(result.components.antigravity.prebuiltFiles), ['lib/client.js', 'lib/types/index.d.ts']);
  assert.match(result.components.antigravity.qualification, /not rebuilt/);
  assert.equal(result.components.tui.profileActivated, false);
  assert(input.calls.some(call => call.args[0] === 'verify:oauth'));
  assert(!input.calls.some(call => call.args[0] === 'install' && call.options.cwd.endsWith('/antigravity')));
  const compiler = input.calls.find(call => call.args[0] === 'src/index.ts');
  assert(compiler.args.includes('--packages=external'));
  assert(compiler.args.includes('--target=node22'));
  assert.equal(await readFile(join(input.artifactsRoot, 'antigravity/package/lib/client.js'), 'utf8'), 'committed browser face');
  const patched = JSON.parse(await readFile(join(input.artifactsRoot, 'antigravity/package/package.json'), 'utf8'));
  assert.equal(patched.peerDependenciesMeta['@deepseek-ai/dsh-client-runtime'].optional, true);
  assert.equal(result.components.antigravity.artifactSha256.length, 64);
});

test('accepts npm12 pack name-keyed result without trusting arbitrary filenames', async () => {
  const result = await buildForks(await fixture({ npm12: true }));
  assert(result.components.antigravity.artifact.endsWith('/antigravity.tgz'));
  await assert.rejects(buildForks(await fixture({ filename: '../escape.tgz' })), /Unsafe tarball/);
});

test('requires explicit runner/environment; library import never starts a command', async () => {
  await assert.rejects(buildForks(), /runner required/);
  await assert.rejects(buildForks({ spawn: () => { throw new Error('must not run'); } }), /environment required/);
});

test('refuses wrong cached tool versions before reserving source or artifact output', async () => {
  const input = await fixture({ esbuildVersion: '0.28.3' });
  await assert.rejects(buildForks(input), /Pinned esbuild/);
  assert.deepEqual(await readdir(input.sourcesRoot), []);
  assert.deepEqual(await readdir(input.artifactsRoot), []);
});

test('refuses reused successful outputs without overwriting receipts or cloning again', async () => {
  const input = await fixture();
  await buildForks(input);
  const receipt = await readFile(join(input.artifactsRoot, 'tui/receipt.json'));
  const clones = input.calls.filter(call => call.args.includes('clone')).length;
  await assert.rejects(buildForks(input), { code: 'EEXIST' });
  assert.equal(input.calls.filter(call => call.args.includes('clone')).length, clones);
  assert.deepEqual(await readFile(join(input.artifactsRoot, 'tui/receipt.json')), receipt);
});

test('failed clone retains exclusive source/artifact directories; no retry reuse', async () => {
  const input = await fixture({ fail: (_command, args) => args.includes('clone') });
  await assert.rejects(buildForks(input), /subprocess failed/);
  assert.deepEqual(await readdir(input.sourcesRoot), ['tui']);
  assert.deepEqual(await readdir(input.artifactsRoot), ['tui']);
  await assert.rejects(buildForks(input), { code: 'EEXIST' });
});

test('wrong source pin and dirty source fail before dependency installation', async () => {
  for (const overrides of [{ wrongHead: true }, { dirty: true }]) {
    const input = await fixture(overrides);
    await assert.rejects(buildForks(input), /pin differs|must be clean/);
    assert(!input.calls.some(call => call.args[0] === 'install'));
  }
});

test('host optional-peer import refusal does not pack an invalid AG artifact', async () => {
  const input = await fixture({ legacyImport: true });
  await assert.rejects(buildForks(input), /references legacy/);
  assert(!input.calls.some(call => call.args[0] === 'pack' && call.options.cwd.endsWith('/antigravity/package')));
});

test('concurrent source changes fail before packing or claiming immutable provenance', async () => {
  const input = await fixture({ mutateSource: true });
  await assert.rejects(buildForks(input), /Source changed during compilation/);
  assert(!input.calls.some(call => call.args[0] === 'pack'));
});

test('symlink root and overlapping source/artifact roots are refused', async () => {
  const input = await fixture();
  const link = join(input.root, 'source-link');
  await symlink(input.sourcesRoot, link);
  await assert.rejects(buildForks({ ...input, sourcesRoot: link }), /Symlink/);
  await assert.rejects(buildForks({ ...input, artifactsRoot: input.sourcesRoot }), /disjoint/);
  assert.equal(input.calls.length, 0);
});
