import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LAYOUT, DEFAULT_PROOFS } from './cold.mjs';

// Post-cut verification is independent of retired installations and safe with a live TUI.
export function status(layout = DEFAULT_LAYOUT, options = {}) {
  const blockers = [], packages = [];
  const attempt = fn => { try { fn(); } catch (error) { blockers.push(error.message); } };
  const canonical = path.join(layout.cli, 'node_modules');
  const inside = (root, target) => target === root || target.startsWith(root + path.sep);
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  let regular = 0, links = 0;
  function inspect(name, file) {
    const entry = fs.lstatSync(file);
    if (!entry.isSymbolicLink()) {
      regular++;
      if (name !== '@deepseek-ai/dsh-llm-llamacpp' || !entry.isDirectory()) throw new Error('Unexpected regular shared package: ' + name);
      return;
    }
    const resolved = fs.realpathSync(file);
    if (!inside(canonical, resolved) || path.resolve(path.dirname(file), fs.readlinkSync(file)) !== path.join(canonical, name)) throw new Error('Noncanonical package link: ' + name);
    const manifest = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8'));
    if (manifest.name !== name) throw new Error('Package name mismatch: ' + name);
    links++; packages.push(name);
  }
  const shared = path.join(layout.profiles, 'node_modules');
  attempt(() => {
    for (const name of fs.readdirSync(shared).sort()) {
      const file = path.join(shared, name);
      if (name.startsWith('@')) {
        if (!fs.lstatSync(file).isDirectory() || fs.realpathSync(file) !== file) throw new Error('Unexpected shared scope redirect');
        for (const child of fs.readdirSync(file).sort()) attempt(() => inspect(`${name}/${child}`, path.join(file, child)));
      } else attempt(() => inspect(name, file));
    }
  });
  attempt(() => inspect('@deepseek-ai/dsh-llm-pi-ai', path.join(layout.profiles, 'dsh-tui/node_modules/@deepseek-ai/dsh-llm-pi-ai')));
  for (const [relative, expected] of Object.entries(options.proofs ?? DEFAULT_PROOFS)) attempt(() => {
    const file = path.resolve(layout.cli, relative);
    if (!inside(layout.cli, fs.realpathSync(file)) || hash(fs.readFileSync(file)) !== expected) throw new Error('Code fingerprint mismatch: ' + relative);
  });
  if (links !== (options.links ?? 404)) blockers.push('Canonical link count mismatch: ' + links);
  if (regular !== (options.regular ?? 1)) blockers.push('Local package count mismatch: ' + regular);
  return { state: blockers.length ? 'needs-attention' : 'complete', canonicalLinks: links,
    localPackages: regular, codeProofs: Object.keys(options.proofs ?? DEFAULT_PROOFS).length,
    blockers, retiredRootsRequired: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = status(); console.log(JSON.stringify(result, null, 2));
  if (result.state !== 'complete') process.exitCode = 2;
}
