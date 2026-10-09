#!/usr/bin/env node
// No default side effects, no model calls, no production-profile reads or writes.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const profile = 'dsh-tui-task10';
const target = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'), 'profiles', profile);
const recipe = JSON.parse(readFileSync(join(root, 'tools/task10-frontend/recipe.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const usage = 'Usage: node tools/provision-task10.mjs [--check|--prepare] [--receipt /absolute/artifacts/receipt.json]\nDefault/check is read-only. Prepare only creates an absent or empty isolated profile; never installs or activates.';
try {
  let prepare = false;
  let receiptPath;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prepare') prepare = true;
    else if (args[i] === '--check') prepare = false;
    else if (args[i] === '--receipt' && args[i + 1]) receiptPath = resolve(args[++i]);
    else if (args[i] === '--help') { console.log(usage); process.exit(0); }
    else throw Error(usage);
  }
  const patchPath = join(root, 'tools/task10-frontend', recipe.patch);
  if (hash(readFileSync(patchPath)) !== recipe.patchSha256) throw Error('Portable patch integrity mismatch');
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(target).length)) throw Error(`Refusing existing/nonempty custom profile: ${target}. Nothing changed.`);
  let tarball;
  if (receiptPath) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    for (const key of ['url', 'base', 'pnpm', 'vendorDshStd', 'patchSha256', 'package', 'version']) {
      if (receipt[key] !== recipe[key]) throw Error(`Build receipt mismatch: ${key}`);
    }
    if (typeof receipt.tarball !== 'string' || basename(receipt.tarball) !== receipt.tarball || !receipt.tarball.endsWith('.tgz')) throw Error('Invalid artifact filename');
    tarball = join(dirname(receiptPath), receipt.tarball);
    if (hash(readFileSync(tarball)) !== receipt.tarballSha256) throw Error('Artifact SHA256 mismatch');
    const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
    if (packed.name !== recipe.package || packed.version !== recipe.version || !packed.exports?.['./ui']) throw Error('Wrong frontend package/API');
    const ui = execFileSync('tar', ['-xOf', tarball, 'package/lib/types/ui.js'], { encoding: 'utf8' });
    if (!ui.includes('Markdown') || !ui.includes('markdownSourceRange')) throw Error('Artifact lacks task10 Markdown API');
  }
  console.log(`Target: ${target}\nPatch: ${recipe.patchSha256}\nArtifact: ${tarball ?? 'pending explicit bootstrap/build receipt'}`);
  if (!prepare) { console.log('Read-only check; no profile created, installed or activated.'); process.exit(0); }
  if (!tarball) throw Error('--prepare requires --receipt from the pinned frontend bootstrap');
  // Exclusive files and non-recursive target mkdir prevent overwriting custom profiles.
  // Any partial failure remains visible for manual inspection; never auto-delete it.
  if (!existsSync(dirname(target))) throw Error(`Create the profiles parent explicitly first: ${dirname(target)}`);
  if (!stat) mkdirSync(target);
  const write = (name, data) => writeFileSync(join(target, name), data, { flag: 'wx' });
  write('package.json', JSON.stringify({ name: 'dsh-profile-' + profile, private: true, dependencies: { '@deepseek-ai/dsh-base': '0.2.0-rc.2', yaml: '2.9.1', [recipe.package]: 'file:' + tarball }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', recipe.package] } } }, null, 2) + '\n');
  write('cordis.yml', '# Composed from pinned base/frontend bundles and this profile patch.\n[]\n');
  write('cordis.patch.yml', readFileSync(join(root, 'tools/task10-profile/cordis.patch.yml')));
  console.log('Prepared skeleton only. Pending: fresh profile dependency install, scoped activate --write, then explicit isolated launch (see tools/task10-profile/README.md).');
} catch (error) { console.error(error.message); process.exitCode = 1; }
