#!/usr/bin/env node
// Converts a restored profile's absolute paths to profile-relative spellings
// (see profile-paths.mjs), so one dotfiles copy works under any HOME.
//
// Only what the loader resolves against the profile directory is rewritten:
// the `name` of loader rows, include `config.path` (cordis-plugin-include) and
// package.json `link:` specs. Other config strings that merely look like paths
// are left alone: plugins read those themselves, not through baseUrl.
// research-activation names its derivatives by content hash and refuses drift,
// so rewritten `alex-research-<hash>.yml` files get their new hash and every
// include pointing at them is updated, cascading until the names are stable.
// Proof before any write: mapping each new value back through the profile dir
// (and new names back to old ones) must reproduce every original document.
//
// Usage:
//   node tools/profile-portable.mjs --profile dsh-tui                    # check
//   node tools/profile-portable.mjs --profile dsh-tui --write
//   node tools/profile-portable.mjs --profile dsh-tui --from-home /home/alex
//     (--from-home: the HOME the files were generated under, default $HOME)

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProfileRelative, profileRelative } from './profile-paths.mjs';

const INCLUDE = '@deepseek-ai/cordis-plugin-include';
const RESEARCH = /^alex-research-([a-f0-9]{16})\.yml$/;
const hash16 = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function loadYaml(profileDir) {
  // Same order as tools/resilience/profile.mjs: repo deps, then the installed runtime.
  for (const base of [import.meta.url, join(homedir(), '.local/share/dsh-cli/package.json'), join(profileDir, 'package.json'), join(profileDir, '..', 'package.json')]) {
    try { return createRequire(base)('yaml'); } catch { /* next location */ }
  }
  throw new Error('Cannot resolve yaml; install repository dependencies');
}

// Every map with string id+name is a loader row, wherever it is nested (insert
// lists, preset plugin lists, group configs, included documents).
function rowEdits(YAML, text, convert) {
  // `!!js` scalars stay opaque strings here (never rewritten); no tag warnings.
  const doc = YAML.parseDocument(text, { keepSourceTokens: true, logLevel: 'error' });
  assert.equal(doc.errors.length, 0, `YAML parse error: ${doc.errors[0]?.message}`);
  const edits = [];
  const scalarEdit = node => {
    if (!YAML.isScalar(node) || typeof node.value !== 'string' || node.tag) return;
    const next = convert(node.value);
    if (next !== node.value) edits.push({ start: node.range[0], end: node.range[1], value: next });
  };
  YAML.visit(doc, {
    Map(_, map) {
      const id = map.get('id'), name = map.get('name', true);
      if (typeof id !== 'string' || !YAML.isScalar(name)) return;
      scalarEdit(name);
      const config = map.get('config', true);
      if (name.value === INCLUDE && YAML.isMap(config)) scalarEdit(config.get('path', true));
    },
  });
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    const raw = text.slice(edit.start, edit.end);
    const quote = raw.startsWith("'") || raw.startsWith('"') ? raw[0] : '';
    out = out.slice(0, edit.start) + (quote ? JSON.stringify(edit.value) : edit.value) + out.slice(edit.end);
  }
  return { out, count: edits.length };
}

export function planPortable({ profileDir, fromHome = homedir(), home = homedir(), YAML = loadYaml(profileDir) }) {
  profileDir = resolve(profileDir); fromHome = resolve(fromHome); home = resolve(home);
  // Where these files lived when their absolute paths were generated.
  const writtenDir = fromHome === home ? profileDir : join(fromHome, relative(home, profileDir));
  const files = readdirSync(profileDir).filter(name => name.endsWith('.yml') || name === 'package.json').sort();
  const originals = new Map(files.map(name => [name, readFileSync(join(profileDir, name), 'utf8')]));
  const toRelative = value => value.startsWith(fromHome + '/') ? profileRelative(writtenDir, value) : value;
  let renames = new Map();
  const renameRef = value => {
    if (!isProfileRelative(value)) return value;
    const file = basename(value);
    return renames.has(file) ? value.slice(0, -file.length) + renames.get(file) : value;
  };
  let results;
  for (let round = 0; ; round++) {
    assert(round <= files.length, 'research include renames did not converge');
    results = new Map();
    for (const [name, text] of originals) {
      if (name === 'package.json') {
        const pkg = JSON.parse(text);
        let count = 0;
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
            if (typeof spec === 'string' && spec.startsWith('link:/')) {
              const next = 'link:' + toRelative(spec.slice(5));
              if (next !== spec) { pkg[field][dep] = next; count++; }
            }
          }
        }
        results.set(name, { out: count ? JSON.stringify(pkg, null, 2) + (text.endsWith('\n') ? '\n' : '') : text, count });
      } else results.set(name, rowEdits(YAML, text, value => renameRef(toRelative(value))));
    }
    const next = new Map();
    for (const [name, { out }] of results) if (RESEARCH.test(name) && out !== originals.get(name)) next.set(name, `alex-research-${hash16(out)}.yml`);
    if (next.size === renames.size && [...next].every(([k, v]) => renames.get(k) === v)) break;
    renames = next;
  }
  // Structural proof: normalize both sides the same way (profile-relative values
  // resolved from writtenDir, new research names mapped back to the old ones);
  // the documents must then be identical.
  const back = new Map([...renames].map(([oldName, newName]) => [newName, oldName]));
  const absolute = (value, names) => {
    if (!isProfileRelative(value)) return value;
    const file = basename(value);
    return resolve(writtenDir, names.has(file) ? value.slice(0, -file.length) + names.get(file) : value);
  };
  const normalizePackage = (text, names) => {
    const pkg = JSON.parse(text);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
      if (typeof spec === 'string' && spec.startsWith('link:')) pkg[field][dep] = 'link:' + absolute(spec.slice(5), names);
    }
    return pkg;
  };
  const normalizeYaml = (text, names) => YAML.parse(rowEdits(YAML, text, value => absolute(value, names)).out, { logLevel: 'error' });
  const missing = [];
  for (const [name, { out }] of results) {
    if (out === originals.get(name)) continue;
    if (name === 'package.json') {
      assert.deepEqual(normalizePackage(out, back), normalizePackage(originals.get(name), new Map()), `${name}: rewrite is not equivalent`);
      for (const spec of Object.values(JSON.parse(out).dependencies ?? {})) {
        if (typeof spec === 'string' && spec.startsWith('link:') && isProfileRelative(spec.slice(5)) && !existsSync(resolve(profileDir, spec.slice(5)))) missing.push(`${name}: ${spec}`);
      }
      continue;
    }
    assert.deepEqual(normalizeYaml(out, back), normalizeYaml(originals.get(name), new Map()), `${name}: rewrite is not equivalent`);
    // Targets that do not exist yet on this machine (e.g. fork checkouts) are reported, not fatal.
    rowEdits(YAML, out, value => {
      if (isProfileRelative(value) && !back.has(basename(value)) && !existsSync(resolve(profileDir, value))) missing.push(`${name}: ${value}`);
      return value;
    });
  }
  const changes = [...results].filter(([name, { out }]) => out !== originals.get(name)).map(([name, { out, count }]) => ({ file: name, newFile: renames.get(name) ?? name, rewrites: count, out }));
  return { profileDir, writtenDir, changes, renames: Object.fromEntries(renames), missing, proven: true };
}

export function applyPortable(plan) {
  const at = name => join(plan.profileDir, name);
  // A renamed target may only pre-exist with the exact planned bytes (a rerun after
  // a partial write); anything else is someone else's file.
  for (const change of plan.changes) {
    if (change.newFile !== change.file && existsSync(at(change.newFile))) {
      assert.equal(readFileSync(at(change.newFile), 'utf8'), change.out, `refusing to overwrite ${change.newFile}`);
    }
  }
  // Previous bytes stay recoverable. Copy instead of rename: /tmp is often another
  // device (tmpfs), where rename fails with EXDEV.
  const backup = mkdtempSync(join(tmpdir(), 'profile-portable-'));
  for (const change of plan.changes) writeFileSync(join(backup, change.file), readFileSync(at(change.file)));
  // New research names first, then in-place files (temp + same-dir rename, atomic),
  // and only then drop the old names: no reader ever sees a dangling include.
  const ordered = [...plan.changes.filter(change => change.newFile !== change.file), ...plan.changes.filter(change => change.newFile === change.file)];
  for (const change of ordered) {
    const temp = at(`.${change.newFile}.portable-tmp`);
    writeFileSync(temp, change.out, { flag: 'wx' });
    renameSync(temp, at(change.newFile));
  }
  for (const change of plan.changes) if (change.newFile !== change.file) unlinkSync(at(change.file));
  return backup;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), take = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const profile = take('--profile');
  if (!profile) { console.error('Usage: node tools/profile-portable.mjs --profile NAME [--from-home DIR] [--write]'); process.exit(2); }
  const profileDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile);
  try {
    const plan = planPortable({ profileDir, fromHome: take('--from-home') ?? homedir() });
    const backup = args.includes('--write') && plan.changes.length ? applyPortable(plan) : null;
    console.log(JSON.stringify({ mode: args.includes('--write') ? 'write' : 'check', profileDir: plan.profileDir, writtenDir: plan.writtenDir, proven: plan.proven,
      changes: plan.changes.map(({ file, newFile, rewrites }) => ({ file, newFile, rewrites })), missingTargets: plan.missing, backup }, null, 2));
    process.exitCode = !backup && plan.changes.length ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
