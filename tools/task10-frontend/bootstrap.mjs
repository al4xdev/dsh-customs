#!/usr/bin/env node
// Explicit network/build operation, never invoked by the provisioner's check.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const recipe = JSON.parse(readFileSync(join(here, 'recipe.json'), 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
const patch = join(here, recipe.patch);
function run(command, args, cwd) { return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim(); }
try {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--bootstrap') throw Error('Usage: node tools/task10-frontend/bootstrap.mjs --bootstrap ABSENT_SOURCE_DIR ABSENT_ARTIFACT_DIR');
  const source = resolve(args[1]);
  const artifacts = resolve(args[2]);
  if (source === artifacts || source.startsWith(artifacts + '/') || artifacts.startsWith(source + '/')) throw Error('Source and artifact directories must be disjoint');
  if (existsSync(source) || existsSync(artifacts)) throw Error('Refusing existing source/artifact directory; choose fresh paths. No cleanup or overwrite is performed.');
  if (hash(readFileSync(patch)) !== recipe.patchSha256) throw Error('Patch integrity mismatch');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major >= 24 || major === 22 && minor >= 19)) throw Error(`Requires Node ${recipe.node}`);
  run('git', ['clone', '--no-checkout', recipe.url, source]);
  run('git', ['checkout', '--detach', recipe.base], source);
  // pnpm selects the checkout's packageManager version; the global CLI may be newer.
  if (run('pnpm', ['--version'], source) !== recipe.pnpm) throw Error(`Requires pnpm ${recipe.pnpm} in the pinned checkout`);
  run('git', ['submodule', 'update', '--init', '--recursive'], source);
  if (run('git', ['-C', 'vendor/dsh-std', 'rev-parse', 'HEAD'], source) !== recipe.vendorDshStd) throw Error('Vendor pin mismatch');
  run('git', ['apply', '--check', patch], source);
  run('git', ['apply', patch], source);
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], source);
  // Compile includes the pinned vendor builds, but intentionally not the broad verification suite.
  run('pnpm', ['compile'], source);
  run('node', ['--input-type=module', '-e', "const ui=await import('./lib/types/ui.js'); if(!ui.Markdown || typeof ui.markdownSourceRange !== 'function' || typeof ui.markdownSourceBlocks !== 'function') throw Error('Missing task10 UI API'); await import('./lib/types/index.js');"], source);
  mkdirSync(artifacts);
  // The upstream verification path uses npm pack; pnpm pack refuses bundled
  // workspace dependencies under its isolated node linker.
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', artifacts], source);
  const tarballs = readdirSync(artifacts).filter(name => name.endsWith('.tgz'));
  if (tarballs.length !== 1) throw Error('Expected exactly one packed artifact');
  const tarball = tarballs[0];
  writeFileSync(join(artifacts, 'receipt.json'), JSON.stringify({ ...recipe, tarball, tarballSha256: hash(readFileSync(join(artifacts, tarball))), node: process.versions.node }, null, 2) + '\n', { flag: 'wx' });
  console.log(`Built ${join(artifacts, tarball)}; receipt: ${join(artifacts, 'receipt.json')}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
