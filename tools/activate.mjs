#!/usr/bin/env node
// Syncs the managed `alex-*` loader entries in ~/.dsh/profiles/*/cordis.patch.yml
// from plugins/activation.json.
//
// Why this is a generator instead of hand-edited YAML:
//
//   The profile files are not ours alone. They also carry hand-written
//   per-machine config (local model providers, permission presets, theme,
//   shortcuts) and long explanatory comments. Re-emitting the document with a
//   YAML dumper would silently destroy all of that, and editing the files by
//   hand from several sessions is exactly what made this repo drift from the
//   live profiles. So we locate the contiguous run of managed entries through
//   the YAML CST and splice only that byte range: every other byte of the file,
//   comments included, is copied through untouched.
//
// Paths are resolved against wherever this repo actually lives, so a fresh
// machine only needs `git clone` + `node tools/activate.mjs --write`.
//
// Usage:
//   node tools/activate.mjs                  # check for drift (default, read-only)
//   node tools/activate.mjs --write          # apply the sync
//   node tools/activate.mjs --profile web    # limit to one profile
//   node tools/activate.mjs --root /path/to/repo   # override repo root

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_DEFAULT = dirname(HERE);
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh');
const PROFILES_DIR = join(DSH_HOME, 'profiles');

// --- args ------------------------------------------------------------------

function parseArgs(argv) {
  const options = { write: false, profiles: null, repoRoot: REPO_ROOT_DEFAULT, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') options.write = true;
    else if (arg === '--check') options.write = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--profile') options.profiles = (options.profiles ?? []).concat(argv[++i] ?? []);
    else if (arg === '--root') options.repoRoot = resolve(argv[++i] ?? '.');
    else if (arg === '-h' || arg === '--help') { console.log(USAGE); process.exit(0); }
    else { console.error(`Unknown argument: ${arg}\n\n${USAGE}`); process.exit(2); }
  }
  return options;
}

const USAGE = `Usage: node tools/activate.mjs [--check|--write] [--profile NAME]... [--root DIR] [--json]

  (no flag)      report drift only; exit 1 when a profile is out of sync
  --write        rewrite the managed alex-* entries
  --profile N    only touch profile N (repeatable; default: all in the manifest)
  --root DIR     repo root to resolve module paths against
  --json         machine-readable report`;

// --- yaml resolution -------------------------------------------------------

// The `yaml` package is not vendored here. DSH itself depends on it, so the
// profiles tree is the most reliable place to find it on a fresh machine; a
// repo-local install and the plain resolution chain are tried as well.
function loadYaml() {
  const attempts = [
    ...(options.profiles ?? []).map(profile => join(PROFILES_DIR, profile, 'noop.js')),
    join(PROFILES_DIR, 'noop.js'),
    join(PROFILES_DIR, 'node_modules', 'yaml', 'noop.js'),
    join(options.repoRoot, 'noop.js'),
    fileURLToPath(import.meta.url),
  ];
  const errors = [];
  for (const base of attempts) {
    try {
      return { yaml: createRequire(base)('yaml'), from: base };
    } catch (error) {
      errors.push(`${base}: ${error.code ?? error.message}`);
    }
  }
  console.error(`Cannot resolve the 'yaml' package. Tried:\n  ${errors.join('\n  ')}`);
  console.error(`\nInstall it (npm i yaml) or run where DSH's profile dependencies are visible.`);
  process.exit(3);
}

// --- manifest --------------------------------------------------------------

function loadManifest(repoRoot) {
  const path = join(repoRoot, 'plugins', 'activation.json');
  if (!existsSync(path)) {
    console.error(`Manifest not found: ${path}`);
    process.exit(3);
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof manifest.managedIdPrefix !== 'string' || !Array.isArray(manifest.plugins)) {
    console.error(`Manifest is malformed: ${path}`);
    process.exit(3);
  }
  return manifest;
}

// --- rendering -------------------------------------------------------------

// Emit a plain scalar unless the value would be misread as YAML syntax. Keeps
// untouched lines byte-identical to the hand-written originals (unquoted
// absolute paths) instead of churning the whole block into quoted strings.
function scalar(value) {
  return /^[A-Za-z0-9_./-][A-Za-z0-9_./-]*$/.test(value) ? value : JSON.stringify(value);
}

// Generic overlays retain historical inclusion unless explicitly opted out.
// Isolated replacements must opt out to avoid conflicting with native plugins.
function desiredEntries(manifest, profile, repoRoot) {
  return manifest.plugins
    .filter(plugin => profile === null
      ? plugin.overlay !== false
      : !plugin.profiles || plugin.profiles.includes(profile))
    .map(plugin => ({
      id: plugin.id,
      name: resolve(repoRoot, 'plugins', plugin.module),
      config: plugin.config ?? null,
    }));
}

function renderEntries(entries, listIndent, YAML) {
  const dash = `${' '.repeat(listIndent)}- `;
  const cont = ' '.repeat(listIndent + 2);
  const cfg = ' '.repeat(listIndent + 4);
  const lines = [];
  for (const entry of entries) {
    lines.push(`${dash}id: ${entry.id}`);
    lines.push(`${cont}name: ${scalar(entry.name)}`);
    if (entry.config) {
      lines.push(`${cont}config:`);
      const dumped = YAML.stringify(entry.config).replace(/\n+$/, '');
      for (const line of dumped.split('\n')) lines.push(`${cfg}${line}`);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// --- CST surgery -----------------------------------------------------------

// Returns the max-width indent of the entry's own line, so a generated block
// lands at the same nesting level as the one it replaces.
function listIndentOf(src, offset) {
  const lineStart = src.lastIndexOf('\n', offset) + 1;
  const lineEnd = src.indexOf('\n', lineStart);
  const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  const match = /^([ \t]*)- /.exec(line);
  return match ? match[1].length : 4;
}

function lineStart(src, offset) {
  return src.lastIndexOf('\n', offset) + 1;
}

// YAML node ranges are not consistently inside the line: for a block-mapping
// entry the end offset can already sit on the *next* line, one past the
// trailing newline. Scanning forward from there would swallow the following
// sibling entry, so step back over any line break before looking for the end
// of the line the node actually covers.
function lineEndOfNode(src, offset) {
  let i = offset - 1;
  while (i > 0 && (src[i] === '\n' || src[i] === '\r')) i -= 1;
  const next = src.indexOf('\n', i);
  return next === -1 ? src.length : next + 1;
}

// Finds every maximal run of consecutive managed entries inside any insert
// block. Returns byte spans into src plus the list indent to reproduce.
function locateManagedRuns(doc, src, prefix) {
  const runs = [];
  const top = doc.contents?.items ?? [];
  for (const item of top) {
    const insert = item?.get?.('insert');
    if (!insert?.items) continue;
    let run = null;
    for (const entry of insert.items) {
      const id = entry?.get?.('id');
      const managed = typeof id === 'string' && id.startsWith(prefix);
      if (managed) {
        if (!run) {
          run = { firstOffset: entry.range[0], firstItem: entry, ids: [] };
          runs.push(run);
        }
        run.lastItem = entry;
        run.ids.push(id);
      } else {
        run = null;
      }
    }
  }
  for (const run of runs) {
    run.start = lineStart(src, run.firstOffset);
    run.end = lineEndOfNode(src, run.lastItem.range[2]);
    run.indent = listIndentOf(src, run.firstOffset);
  }
  return runs;
}

// Where a fresh managed block goes when the profile has an insert block but no
// managed entries yet (a brand-new machine, or a profile the user wrote by hand).
function insertionPoint(doc, src) {
  const top = doc.contents?.items ?? [];
  for (const item of top) {
    const insert = item?.get?.('insert');
    if (insert?.items?.length) {
      return { start: lineStart(src, insert.items[0].range[0]), indent: listIndentOf(src, insert.items[0].range[0]) };
    }
  }
  return null;
}

const HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`;

// --- sync one target file --------------------------------------------------

// Splices the desired managed block into `path`. Everything outside the managed
// run is copied through byte-for-byte, which is what keeps the hand-written
// comments and the per-machine (non `alex-*`) siblings alive.
function syncFile(path, label, entries, options, YAML, manifest) {
  const exists = existsSync(path);
  const src = exists ? readFileSync(path, 'utf8') : '';
  const result = { label, path, exists, changed: false, created: false, note: '' };

  if (!entries.length) {
    result.note = 'no plugins declared';
    return result;
  }

  let next;
  if (exists) {
    const doc = YAML.parseDocument(src, { keepSourceTokens: true });
    if (doc.errors?.length) {
      result.note = `YAML parse error: ${doc.errors[0].message}`;
      result.error = true;
      return result;
    }
    const runs = locateManagedRuns(doc, src, manifest.managedIdPrefix);
    if (runs.length > 1) {
      result.note = `${runs.length} separate managed runs; refusing to guess (normalize the file by hand)`;
      result.error = true;
      return result;
    }
    if (runs.length === 1) {
      const run = runs[0];
      const block = renderEntries(entries, run.indent, YAML);
      result.current = src.slice(run.start, run.end);
      result.block = block;
      next = src.slice(0, run.start) + block + src.slice(run.end);
    } else {
      const point = insertionPoint(doc, src);
      if (point) {
        const block = renderEntries(entries, point.indent, YAML);
        next = src.slice(0, point.start) + block + src.slice(point.start);
        result.block = block;
        result.note = 'inserted a new managed block into the existing insert list';
      } else {
        const block = `- insert:\n${renderEntries(entries, 4, YAML)}`;
        next = `${src.replace(/\n*$/, '\n')}${src.trim() ? '' : HEADER}${block}`;
        result.block = block;
        result.note = 'appended a new insert block';
      }
    }
  } else {
    const block = renderEntries(entries, 4, YAML);
    next = `${HEADER}- insert:\n${block}`;
    result.block = block;
    result.created = true;
  }

  result.changed = next !== src;
  if (result.changed && options.write) {
    writeFileSync(path, next, 'utf8');
    result.written = true;
  }
  return result;
}

function syncProfile(profile, options, YAML, manifest) {
  return syncFile(
    join(PROFILES_DIR, profile, 'cordis.patch.yml'),
    profile,
    desiredEntries(manifest, profile, options.repoRoot),
    options,
    YAML,
    manifest,
  );
}

// The repo carries its own `--patch` overlay. It used to be maintained by hand
// and was exactly the copy that drifted from the live profiles, so it is
// generated from the same manifest: one source of truth, no second list.
function syncOverlay(options, YAML, manifest) {
  const entries = desiredEntries(manifest, null, options.repoRoot);
  const result = syncFile(join(options.repoRoot, 'plugins', 'cordis.patch.yml'), 'overlay', entries, options, YAML, manifest);
  result.isOverlay = true;
  return result;
}

// --- orphan audit ----------------------------------------------------------

// Every plugins/<dir>/index.mjs is a plugin somebody wrote. If it is neither
// activated by the manifest nor explicitly recorded as known-inactive, it is
// work that no profile loads and no document explains.
function auditPlugins(options, manifest) {
  const dir = join(options.repoRoot, 'plugins');
  if (!existsSync(dir)) return { orphans: [], missing: [], known: [] };
  const declared = new Set(
    manifest.plugins.map(plugin => plugin.module.split('/')[0]),
  );
  const known = new Set(Object.keys(manifest.knownInactive ?? {}));

  const orphans = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (!existsSync(join(full, 'index.mjs'))) continue;
    if (declared.has(name)) continue;
    if (known.has(name)) continue;
    orphans.push(name);
  }

  // A manifest row whose directory or module vanished would break every profile
  // on the next restart, so surface it before it is written.
  const missing = [];
  for (const plugin of manifest.plugins) {
    const modulePath = join(dir, plugin.module);
    if (!existsSync(modulePath)) missing.push(plugin.module);
  }
  return { orphans, missing, known: [...known] };
}

// --- main ------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2));
const { yaml: YAML, from } = loadYaml();
const manifest = loadManifest(options.repoRoot);

const profiles = options.profiles ?? manifest.profiles ?? [];
const reports = [];

// The repo overlay is a repo artifact, not a profile, so a targeted --profile
// run leaves it alone; a full run keeps it honest with the live profiles.
if (!options.profiles) reports.push(syncOverlay(options, YAML, manifest));

for (const profile of profiles) {
  if (!existsSync(join(PROFILES_DIR, profile))) {
    reports.push({ label: profile, path: join(PROFILES_DIR, profile, 'cordis.patch.yml'), skipped: true, note: 'profile directory does not exist on this machine' });
    continue;
  }
  reports.push(syncProfile(profile, options, YAML, manifest));
}

const audit = auditPlugins(options, manifest);
const drifted = reports.filter(r => r.changed);
const failed = reports.filter(r => r.error);

if (options.json) {
  console.log(JSON.stringify({ mode: options.write ? 'write' : 'check', repoRoot: options.repoRoot, yamlFrom: from, reports, audit }, null, 2));
} else {
  console.log(`repo root : ${options.repoRoot}`);
  console.log(`dsh home  : ${DSH_HOME}`);
  console.log(`mode      : ${options.write ? 'WRITE' : 'check'}\n`);

  for (const report of reports) {
    const label = report.label.padEnd(9);
    if (report.skipped) { console.log(`  ${label} SKIP    ${report.note}`); continue; }
    if (report.error) { console.log(`  ${label} ERROR   ${report.note}`); continue; }
    if (report.created) { console.log(`  ${label} CREATE  ${report.path}`); continue; }
    console.log(`  ${label} ${report.changed ? (report.written ? 'UPDATED' : 'DRIFT  ') : 'in sync'} ${report.changed ? report.path : ''}`);
  }

  if (drifted.length && !options.write) {
    for (const report of drifted) {
      console.log(`\n--- ${report.label} ${'-'.repeat(Math.max(0, 60 - report.label.length))}`);
      if (report.current === undefined) {
        console.log('- (no managed block present yet)');
      } else {
        console.log('- current managed block');
        for (const line of report.current.replace(/\n$/, '').split('\n')) console.log(`  ${line}`);
      }
      console.log(`+ desired managed block${report.note ? ` (${report.note})` : ''}`);
      for (const line of report.block.replace(/\n$/, '').split('\n')) console.log(`  ${line}`);
    }
  }

  console.log('\norphan audit');
  if (audit.missing.length) {
    console.log(`  ! manifest references missing modules: ${audit.missing.join(', ')}`);
  }
  if (audit.orphans.length) {
    console.log(`  ! plugins present but activated by no profile and not recorded as known-inactive:`);
    for (const name of audit.orphans) console.log(`      plugins/${name}`);
  }
  if (audit.known.length) {
    console.log(`  i known-inactive (documented in activation.json): ${audit.known.join(', ')}`);
  }
  if (!audit.missing.length && !audit.orphans.length) console.log('  ok');

  if (drifted.length && !options.write) console.log('\nRun with --write to apply.');
  if (drifted.length && options.write) console.log(`\n${drifted.length} target(s) updated.`);
}

if (failed.length) process.exit(3);
if (!options.write && drifted.length) process.exit(1);
process.exit(0);
