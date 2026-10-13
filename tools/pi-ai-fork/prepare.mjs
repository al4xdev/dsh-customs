import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function reserveArtifactOutput(output) {
  assert.equal(output, resolve(output), 'Artifact output must be an absolute normalized path');
  let occupied = false;
  try { await lstat(output); occupied = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(!occupied, 'Artifact output already exists; preserve it and choose a fresh output root');
  await mkdir(dirname(output), { recursive: true });
  // Exclusive mkdir also fences another preparation racing the same source/catalog.
  await mkdir(output, { mode: 0o700 });
}

export async function copyUpstreamLicense(checkout, staged) {
  const bytes = await readFile(join(checkout, 'LICENSE'));
  // The monorepo license is not inside packages/ai; npm must carry its full notice.
  await writeFile(join(staged, 'LICENSE'), bytes, { flag: 'wx' });
  return createHash('sha256').update(bytes).digest('hex');
}

async function prepare() {
  const checkout = resolve(process.argv[2] ?? join(repo, 'sources/pi-ai'));
  // Git searches ancestors: a vendored snapshot must never borrow the workshop HEAD.
  const ownGit = await lstat(join(checkout, '.git')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert(ownGit, 'This legacy preparer requires an independent Pi Git checkout; use tools/clean-install/pi.mjs for the verified snapshot');
  assert.equal(resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: checkout, encoding: 'utf8' }).trim()), checkout, 'Pi checkout must own its Git history');
  const installRoot = process.env.DSH_INSTALL_ROOT ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'dsh-cli');
  const officialRoot = resolve(process.argv[3] ?? join(installRoot, 'node_modules'));
  // The portable workshop supplies an isolated donor and durable artifact root;
  // legacy callers keep their historical scratch output until explicitly migrated.
  const outputRoot = resolve(process.argv[4] ?? join(repo, '.dumps/pi-ai-fork'));
  const ai = join(checkout, 'packages/ai');
  const manifest = JSON.parse(await readFile(join(ai, 'package.json'), 'utf8'));
  const official = JSON.parse(await readFile(join(officialRoot, '@earendil-works/pi-ai/package.json'), 'utf8'));
  assert.equal(manifest.version, '0.87.1');
  assert(official.version === manifest.version || /^0\.87\.1\+alex\.codex-default\.[a-f0-9]{12}$/.test(official.version),
    'Catalog source must be the compatible 0.87.1 host or this pinned fork');
  const source = await readFile(join(ai, 'src/api/openai-codex-responses.ts'), 'utf8');
  assert(!source.includes('body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" }'));
  const hash = createHash('sha256').update(source).digest('hex');
  const catalog = join(officialRoot, '@earendil-works/pi-ai/dist/providers/data');
  const catalogDigest = createHash('sha256');
  for (const name of (await readdir(catalog)).sort()) {
    catalogDigest.update(name).update(await readFile(join(catalog, name)));
  }
  const catalogHash = catalogDigest.digest('hex');
  const output = join(outputRoot, `${hash.slice(0, 12)}-${catalogHash.slice(0, 12)}`);
  // Fail before staging/compilation if the required upstream notice is absent.
  await readFile(join(checkout, 'LICENSE'));
  // Never reuse a completed or partial artifact directory, even for the same inputs.
  await reserveArtifactOutput(output);
  // Build in a fresh tree: never replace catalogs in the checkout or a previous artifact.
  // The selected compatible donor supplies the published model data.
  const build = await mkdtemp(join(output, 'build-'));
  await cp(join(checkout, 'tsconfig.base.json'), join(build, 'tsconfig.base.json'));
  await symlink(join(checkout, 'node_modules'), join(build, 'node_modules'), 'dir');
  const buildAI = join(build, 'packages/ai');
  await mkdir(buildAI, { recursive: true });
  await cp(join(ai, 'src'), join(buildAI, 'src'), {
    recursive: true, filter: (path) => path !== join(ai, 'src/providers/data'),
  });
  await cp(join(ai, 'scripts'), join(buildAI, 'scripts'), { recursive: true });
  await cp(join(ai, 'package.json'), join(buildAI, 'package.json'));
  await cp(join(ai, 'tsconfig.build.json'), join(buildAI, 'tsconfig.build.json'));
  const buildCatalog = join(buildAI, 'src/providers/data');
  await cp(catalog, buildCatalog, { recursive: true });
  // This installation has local model additions but its old manifest hashes were
  // not refreshed. Recompute only the scratch manifest; keep every model JSON byte.
  const modelData = await import(pathToFileURL(join(buildAI, 'scripts/model-data.ts')).href);
  const publishedStamp = JSON.parse(await readFile(join(buildCatalog, '.manifest.json'), 'utf8'));
  const contents = {};
  for (const name of (await readdir(buildCatalog)).sort()) {
    if (name.endsWith('.json') && name !== '.manifest.json') contents[name] = await readFile(join(buildCatalog, name), 'utf8');
  }
  const buildStamp = modelData.createModelDataManifest(modelData.readModelDataStructure(buildAI), contents, publishedStamp.generatedAt);
  await writeFile(join(buildCatalog, '.manifest.json'), `${JSON.stringify(buildStamp)}\n`);
  execFileSync(process.execPath, [join(buildAI, 'scripts/check-model-data.ts')], { cwd: buildAI, stdio: 'inherit' });
  // AI imports telemetry contracts; compile the unchanged workspace dependency first.
  execFileSync(join(checkout, 'node_modules/.bin/tsgo'), ['-p', 'tsconfig.build.json'], {
    cwd: join(checkout, 'packages/telemetry'), stdio: 'inherit',
  });
  execFileSync(join(checkout, 'node_modules/.bin/tsgo'), ['-p', 'tsconfig.build.json'], { cwd: buildAI, stdio: 'inherit' });
  // tsgo emits imported JSON too. Preserve the exact published catalog bytes in the
  // fresh package staging tree, rather than its differently formatted JSON output.
  const staged = join(output, `package-${basename(build)}`);
  await mkdir(staged);
  await cp(join(buildAI, 'dist'), join(staged, 'dist'), {
    recursive: true, filter: (path) => path !== join(buildAI, 'dist/providers/data'),
  });
  await cp(buildCatalog, join(staged, 'dist/providers/data'), { recursive: true });
  await cp(join(ai, 'README.md'), join(staged, 'README.md'));
  const licenseSha256 = await copyUpstreamLicense(checkout, staged);
  const telemetryVersion = JSON.parse(await readFile(join(officialRoot, '@earendil-works/pi-telemetry/package.json'), 'utf8')).version;
  const version = `${manifest.version}+alex.codex-default.${hash.slice(0, 12)}`;
  await writeFile(join(staged, 'package.json'), `${JSON.stringify({
    ...manifest, version, scripts: {}, devDependencies: {},
    dependencies: { ...manifest.dependencies, '@earendil-works/pi-telemetry': telemetryVersion },
  }, null, 2)}\n`);
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], {
    cwd: staged, encoding: 'utf8',
  }));
  // npm 12 returns a package-name map; older npm versions return an array.
  const pack = Array.isArray(packed) ? packed[0] : packed[manifest.name];
  assert(pack?.filename && pack.integrity, 'npm pack did not return artifact metadata');
  const artifact = join(output, pack.filename);
  const provenance = {
    fork: 'https://github.com/al4xdev/pi', upstreamVersion: manifest.version, version,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(),
    sourceHash: hash, artifact, integrity: pack.integrity, catalogHash, catalogSource: catalog, licenseSha256,
  };
  await writeFile(join(output, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(provenance, null, 2));
}

// Importing the narrow packaging seams must not build or inspect a live donor.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await prepare();
