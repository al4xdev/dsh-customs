#!/usr/bin/env node
/**
 * Selective research activation. No manifest sync, plugin execution, or network IO.
 *
 * CLI: --check (default), --write, --rollback RECEIPT [--write], --profiles-dir DIR,
 *      --root DIR. Exit: 0 current/success, 1 pending/conflicts, 2 invalid/ambiguous.
 * All five profiles are mandatory. Future writes append a private patch block and
 * create local immutable preset artifacts; never rewrite the original patch body.
 * Config patches replace (not merge) objects in the real include implementation.
 * YAML ASTs retain !!js as tagged data, NEVER execute it. Dynamic target configs,
 * aliases, duplicate ids, unknown includes and managed drift fail closed.
 * Receipts contain snapshots and hashes, and are private files under .dumps.
 * Rollback is per-file: edited files are reported and left alone. Preimage checks
 * detect intervening changes, not a filesystem-wide transaction: stop other config
 * writers during apply. Interrupted writes can be recovered using the saved receipt.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILES = ['web', 'headless', 'tui', 'dsh-tui', 'companion'];
export const RESEARCH_ID = 'alex-research';
const WEB = '@deepseek-ai/dsh-tool-web';
const PRESET = '@deepseek-ai/dsh-agent-preset';
const INCLUDE = '@deepseek-ai/cordis-plugin-include';
const BEGIN = '# BEGIN alex-research activation v1\n';
const END = '# END alex-research activation v1\n';
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PROFILES = join(process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'), 'profiles');
export const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };

export function loadYaml(profilesDir = DEFAULT_PROFILES) {
  for (const base of [import.meta.url, join(profilesDir, 'noop.cjs')]) {
    try { return createRequire(base)('yaml'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  fail('yaml package unavailable');
}

export function makeCodec(YAML = loadYaml()) {
  function parse(text, label = 'YAML') {
    const doc = YAML.parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }], uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) fail(`${label}: ${[...doc.errors, ...doc.warnings].map(e => e.message).join('; ')}`);
    YAML.visit(doc, { Alias() { fail(`${label}: aliases are ambiguous for selective migration`); } });
    return doc;
  }
  const seq = (node, label) => { if (!YAML.isSeq(node)) fail(`${label}: expected static sequence`); return node.items; };
  const map = (node, label) => { if (!YAML.isMap(node)) fail(`${label}: expected static mapping`); return node; };
  const scalar = (node, label) => { if (!YAML.isScalar(node) || node.tag) fail(`${label}: expected untagged scalar`); return node.value; };
  const get = (node, key) => node?.get?.(key, true);
  const val = (node, key) => { const n = get(node, key); return n === undefined ? undefined : scalar(n, key); };
  const render = node => { const d = new YAML.Document(); d.contents = node; return d.toString({ lineWidth: 0 }); };
  return { YAML, parse, seq, map, scalar, get, val, render };
}

/** Mirrors applyEntryPatches: only group.config is indexed; presets are separate scopes. */
export function compose(entries, patches, codec, { allowMissing = true } = {}) {
  const { seq, map, get, val } = codec;
  const result = entries.clone();
  function index() {
    const ids = new Map();
    function walk(list) { for (const row of seq(list, 'entries')) {
      map(row, 'entry');
      const id = val(row, 'id');
      if (id) { if (ids.has(id)) fail(`duplicate entry id: ${id}`); ids.set(id, row); }
      if (val(row, 'group') === true) walk(get(row, 'config'));
    } }
    walk(result); return ids;
  }
  let ids = index();
  for (const patch of seq(patches, 'patches')) {
    map(patch, 'patch'); const id = val(patch, 'id'), insert = get(patch, 'insert');
    const target = ids.get(id);
    if (insert) {
      let destination = result;
      if (id) {
        if (!target || val(target, 'group') !== true) fail(`ambiguous insert target: ${id}`);
        destination = get(target, 'config');
      }
      seq(destination, 'insert destination').push(...seq(insert, 'insert').map(n => n.clone()));
      ids = index(); continue;
    }
    if (!target) { if (allowMissing) continue; fail(`missing patch target: ${id}`); }
    if (val(patch, 'name') && val(patch, 'name') !== val(target, 'name')) fail(`patch name mismatch: ${id}`);
    for (const pair of patch.items) if (!['id', 'name'].includes(pair.key.value)) target.set(pair.key.value, pair.value.clone());
    ids = index();
  }
  return result;
}

function bytes(path) { try { return readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function within(path, root) { const r = relative(root, path); return r !== '' && !r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r); }
function safeTarget(path, profilesDir) {
  if (!within(path, profilesDir) || path.split(sep).includes('node_modules')) fail(`unsafe target: ${path}`);
  const r = relative(profilesDir, path).split(sep);
  if (r.length !== 2 || !PROFILES.includes(r[0]) || !(r[1] === 'cordis.patch.yml' || /^alex-research-[a-f0-9]{16}\.yml$/.test(r[1]))) fail(`unowned target: ${path}`);
  if (realpathSync(dirname(path)) !== dirname(path)) fail(`symlinked target parent: ${path}`);
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) fail(`non-regular target: ${path}`);
}

export function planActivation({ profilesDir = DEFAULT_PROFILES, root = DEFAULT_ROOT, YAML = loadYaml(profilesDir), resolvePackage } = {}) {
  profilesDir = resolve(profilesDir); root = resolve(root);
  const codec = makeCodec(YAML), { parse, seq, map, get, val, render } = codec;
  const modulePath = join(root, 'plugins/research/index.mjs');
  const changes = [], sources = new Map(), reports = [];
  function read(path) { path = resolve(path); const value = readFileSync(path, 'utf8'); sources.set(path, hash(value)); return value; }
  function document(path) {
    const text = read(path), managed = /alex-research-([a-f0-9]{16})\.yml$/.exec(path);
    if (managed && hash(text).slice(0, 16) !== managed[1]) fail(`managed artifact drift: ${path}`);
    return parse(text, path).contents;
  }
  function packagePath(profile, name) { return resolvePackage ? resolvePackage(profile, name) : createRequire(join(profile, 'package.json')).resolve(`${name}/package.json`); }
  function add(path, after) {
    safeTarget(path, profilesDir);
    const planned = changes.find(c => c.path === path);
    if (planned) { if (planned.after !== after) fail(`conflicting planned artifact: ${path}`); return; }
    const before = bytes(path);
    if (before === after) return;
    if (before !== null && path.endsWith('.yml') && !path.endsWith('/cordis.patch.yml')) fail(`managed artifact collision/drift: ${path}`);
    changes.push({ path, before, after, beforeHash: before === null ? null : hash(before), afterHash: hash(after) });
  }
  for (const profileName of PROFILES) {
    const profile = join(profilesDir, profileName), patchPath = join(profile, 'cordis.patch.yml');
    const original = read(patchPath);
    // A committed block is validated through the same composed tree, not stripped
    // and regenerated: removal would otherwise hide user edits inside that block.
    if ((original.match(/# BEGIN alex-research activation/g) ?? []).length > 1 || original.includes(BEGIN) !== original.includes(END)) fail(`${profileName}: malformed managed block`);
    const manifest = JSON.parse(read(join(profile, 'package.json')));
    let entries = document(join(profile, 'cordis.yml'));
    seq(entries, 'profile root');
    for (const name of manifest.dsh?.profile?.bundles ?? []) {
      const p = packagePath(profile, name), pkg = JSON.parse(read(p));
      const patches = pkg.dsh?.bundle?.patch;
      if (!patches) fail(`bundle lacks patch declaration: ${name}`);
      for (const patch of Array.isArray(patches) ? patches : [patches]) entries = compose(entries, document(resolve(dirname(p), patch)), codec);
    }
    entries = compose(entries, parse(original, patchPath).contents, codec);
    const overlay = new YAML.YAMLSeq(), newRows = new YAML.YAMLSeq();
    const counters = { profile: profileName, webScopes: 0, presets: [], research: false };
    const ids = new Set(seq(entries, 'host').map(row => val(row, 'id')));
    const presetIds = new Set();
    for (const row of seq(entries, 'host')) if (val(row, 'name') === PRESET) {
      const id = val(map(get(row, 'config'), 'preset config'), 'id');
      if (typeof id !== 'string' || val(row, 'id') !== `preset-${id}` || presetIds.has(id)) fail(`${profileName}: ambiguous preset identity ${id}`);
      presetIds.add(id);
    }
    const research = seq(entries, 'host').filter(row => val(row, 'id') === RESEARCH_ID || val(row, 'name') === modulePath);
    if (research.length > 1 || research.some(row => val(row, 'id') !== RESEARCH_ID || val(row, 'name') !== modulePath || get(row, 'disabled') !== undefined && val(row, 'disabled') !== false)) fail(`${profileName}: conflicting research plugin`);
    if (!research.length) newRows.add({ id: RESEARCH_ID, name: modulePath });
    counters.research = true;
    const seenIncludes = new Set();
    function transform(list, scope, base = profile) {
      const out = list.clone(); let changed = false;
      const localIds = new Set();
      for (const row of seq(out, scope)) {
        map(row, scope); const id = val(row, 'id'), name = val(row, 'name');
        if (localIds.has(id)) fail(`${scope}: duplicate id ${id}`); if (id) localIds.add(id);
        if (name === PRESET || id === RESEARCH_ID || name === modulePath) fail(`${scope}: nested preset/research scope requires review`);
        if (id === 'tool-web' && name !== WEB) fail(`${scope}: tool-web owned by different plugin`);
        if (name === WEB && get(row, 'disabled')?.value !== true) {
          counters.webScopes++;
          const cfg = get(row, 'config')?.clone() ?? new YAML.YAMLMap(); map(cfg, `${scope}/tool-web config`);
          // Preserve fetch:false where deliberately configured. The schema default
          // is true, so absent fetch must remain absent rather than be disabled.
          if (get(cfg, 'search') && get(cfg, 'search').tag) fail(`${scope}: dynamic search flag`);
          if (val(cfg, 'search') !== false) { cfg.set('search', false); row.set('config', cfg); changed = true; }
        }
        if (val(row, 'group') === true) {
          const result = transform(get(row, 'config'), `${scope}/${id}`, base);
          if (result.changed) { row.set('config', result.list); changed = true; }
        }
        if (name === INCLUDE) {
          const cfg = map(get(row, 'config'), `${scope}/include`), pathValue = val(cfg, 'path');
          if (typeof pathValue !== 'string') fail(`${scope}: dynamic include path`);
          const path = pathValue.startsWith('file:') ? fileURLToPath(pathValue) : resolve(base, pathValue);
          if (seenIncludes.has(path)) fail(`${scope}: cyclic/repeated include: ${path}`);
          seenIncludes.add(path);
          let included = document(path);
          if (get(cfg, 'patches')) included = compose(included, get(cfg, 'patches'), codec, { allowMissing: false });
          const result = transform(included, `${scope}/${id}`, dirname(path));
          seenIncludes.delete(path);
          if (!isAbsolute(pathValue) && !pathValue.startsWith('file:')) {
            cfg.set('path', path); changed = true;
          }
          if (result.changed) {
            const artifact = artifactFor(result.list);
            const next = cfg.clone(); next.set('path', artifact); next.delete('patches');
            row.set('config', next); changed = true;
          }
        }
        if (typeof name === 'string' && /^\.{1,2}\//.test(name)) {
          row.set('name', resolve(base, name)); changed = true;
        }
      }
      return { list: out, changed };
    }
    function artifactFor(list) {
      const text = '# Managed research activation derivative; original scopes and expressions retained.\n' + render(list);
      const path = join(profile, `alex-research-${hash(text).slice(0, 16)}.yml`);
      add(path, text); return path;
    }
    // Declare fallback presets before the adapter registers them. Minimal is not
    // copied: it has no web tools, and preserving that narrow scope is intentional.
    if (profileName === 'dsh-tui') {
      for (const preset of ['standard', 'ptc', 'cordis']) {
        if (ids.has(`preset-${preset}`)) continue;
        const pkg = packagePath(profile, '@deepseek-ai/dsh-web-app');
        const fallback = compose(new YAML.YAMLSeq(), document(join(dirname(pkg), `presets/${preset}.patch.yml`)), codec);
        const rows = seq(fallback, 'fallback');
        if (rows.length !== 1 || val(rows[0], 'name') !== PRESET) fail('unexpected fallback preset format');
        entries.add(rows[0]); newRows.add(rows[0].clone()); ids.add(`preset-${preset}`);
      }
      if (!ids.has('preset-liangshen')) {
        const pkg = packagePath(profile, '@deepseek-harness-tui/dsh-tui');
        const dir = join(dirname(pkg), 'presets/liangshen');
        const metadata = parse(read(join(dir, 'preset.yml'))).toJS();
        const row = new YAML.Document({ id: 'preset-liangshen', name: PRESET, config: {
          id: 'liangshen', name: metadata.name, description: metadata.description, order: metadata.order,
          plugins: [{ id: 'liangshen-plugins', name: INCLUDE, config: { path: join(dir, 'agent.cordis.yml') } }],
        } }).contents;
        entries.add(row); newRows.add(row.clone());
      }
    }
    for (const row of seq(entries, 'host')) {
      const name = val(row, 'name'), id = val(row, 'id');
      if (name === PRESET) {
        if (get(row, 'disabled') && val(row, 'disabled') === true) continue;
        const cfg = map(get(row, 'config'), `${id} config`);
        const result = transform(get(cfg, 'plugins'), id);
        if (result.changed) {
          const next = cfg.clone(); next.set('plugins', new YAML.Document([{ id: `alex-research-${val(cfg, 'id')}-plugins`, name: INCLUDE, config: { path: artifactFor(result.list) } }]).contents);
          overlay.add({ id, name, config: next }); counters.presets.push(val(cfg, 'id'));
        }
      } else if (name === WEB || val(row, 'group') === true || name === INCLUDE) {
        const one = new YAML.YAMLSeq(); one.add(row);
        const result = transform(one, 'host');
        if (result.changed) overlay.add({ id, name, config: get(result.list.items[0], 'config').clone() });
      } else if (id === 'tool-web') fail(`${profileName}: tool-web identity mismatch`);
    }
    if (original.includes(BEGIN) && (overlay.items.length || newRows.items.length)) fail(`${profileName}: activation drift; rollback/review before replanning`);
    if (newRows.items.length || overlay.items.length) {
      const appended = new YAML.YAMLSeq();
      if (newRows.items.length) appended.add({ insert: newRows });
      appended.items.push(...overlay.items);
      const after = original + (original.endsWith('\n') ? '' : '\n') + BEGIN + render(appended) + END;
      // Flow-style empty documents or explicit YAML terminators cannot accept an
      // append without touching owner bytes. Refuse those instead of rewriting.
      seq(parse(after, `${profileName}: appended patch`).contents, 'appended patches');
      add(patchPath, after);
    }
    reports.push(counters);
  }
  return { version: 1, profilesDir, root, changes, sources: [...sources].map(([path, sha256]) => ({ path, sha256 })), reports };
}

function verifyChange(change, profilesDir, expectedHash) {
  safeTarget(change.path, profilesDir);
  const current = bytes(change.path);
  return (current === null ? null : hash(current)) === expectedHash;
}
function replace(path, text) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { flag: 'wx', mode: existsSync(path) ? lstatSync(path).mode & 0o777 : 0o600 });
  renameSync(tmp, path);
}
export function applyPlan(plan) {
  if (plan.version !== 1) fail('unsupported plan');
  for (const source of plan.sources) if (hash(readFileSync(source.path)) !== source.sha256) fail(`source changed since check: ${source.path}`);
  for (const change of plan.changes) if (!verifyChange(change, plan.profilesDir, change.beforeHash)) fail(`concurrent edit: ${change.path}`);
  if (!plan.changes.length) return { receipt: null, changed: 0 };
  const dir = join(plan.root, '.dumps/research-activation', randomUUID());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const receipt = join(dir, 'receipt.json');
  // Persist all intended pre/postimages before the first target write: recovery
  // recognizes old/new/conflicting states even if the process dies mid-commit.
  writeFileSync(receipt, JSON.stringify({ ...plan, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600, flag: 'wx' });
  for (const change of plan.changes) {
    if (!verifyChange(change, plan.profilesDir, change.beforeHash)) fail(`concurrent edit; receipt ${receipt}: ${change.path}`);
    if (change.before === null) writeFileSync(change.path, change.after, { flag: 'wx', mode: 0o600 });
    else replace(change.path, change.after);
  }
  return { receipt, changed: plan.changes.length };
}

export function rollback(receiptPath, { write = false, profilesDir = DEFAULT_PROFILES, root = DEFAULT_ROOT } = {}) {
  root = resolve(root); profilesDir = resolve(profilesDir); receiptPath = resolve(receiptPath);
  if (!within(receiptPath, join(root, '.dumps/research-activation'))) fail('receipt must be under root/.dumps/research-activation');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.version !== 1 || receipt.profilesDir !== profilesDir || receipt.root !== root || !Array.isArray(receipt.changes)) fail('receipt scope/version mismatch');
  const paths = new Set();
  for (const c of receipt.changes) {
    safeTarget(c.path, profilesDir);
    if (paths.has(c.path)) fail('duplicate receipt target'); paths.add(c.path);
    if ((c.before === null ? null : hash(c.before)) !== c.beforeHash || hash(c.after) !== c.afterHash) fail('receipt snapshot hash mismatch');
  }
  const results = [];
  // Patches are added after artifacts. Undo patches first; if any patch conflicts,
  // keep all artifacts so a still-live include never loses its target.
  let keepArtifacts = receipt.changes.some(c => c.path.endsWith('/cordis.patch.yml')
    && !verifyChange(c, profilesDir, c.beforeHash) && !verifyChange(c, profilesDir, c.afterHash));
  for (const c of [...receipt.changes].reverse()) {
    const patch = c.path.endsWith('/cordis.patch.yml');
    if (!patch && keepArtifacts) { results.push({ path: c.path, state: 'retained-dependency' }); continue; }
    if (verifyChange(c, profilesDir, c.beforeHash)) { results.push({ path: c.path, state: 'already-restored' }); continue; }
    if (!verifyChange(c, profilesDir, c.afterHash)) {
      if (patch) keepArtifacts = true;
      results.push({ path: c.path, state: 'conflict' }); continue;
    }
    if (write) {
      if (!verifyChange(c, profilesDir, c.afterHash)) fail(`concurrent rollback edit: ${c.path}`);
      if (c.before === null) unlinkSync(c.path); else replace(c.path, c.before);
    }
    results.push({ path: c.path, state: write ? 'restored' : 'would-restore' });
  }
  return results;
}

export function main(argv = process.argv.slice(2)) {
  const options = {}; let write = false, receipt, mode;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write' || a === '--check') { if (mode && mode !== a) fail('choose --check or --write'); mode = a; write = a === '--write'; }
    else if (['--root', '--profiles-dir', '--rollback'].includes(a)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) fail(`missing value: ${a}`);
      if (a === '--root') options.root = resolve(value);
      else if (a === '--profiles-dir') options.profilesDir = resolve(value); else receipt = value;
    } else if (a === '--help') {
      console.log('research-activation [--check|--write] [--root DIR] [--profiles-dir DIR] [--rollback RECEIPT]\nDefault is read-only. Five profiles required. Exit 0=current, 1=changes/conflicts, 2=refused.'); return 0;
    } else fail(`unknown argument: ${a}`);
  }
  if (receipt) {
    const results = rollback(receipt, { ...options, write }); console.log(JSON.stringify(results, null, 2));
    return results.some(r => ['conflict', 'retained-dependency', 'would-restore'].includes(r.state)) ? 1 : 0;
  }
  const plan = planActivation(options);
  const result = write ? applyPlan(plan) : { check: true, changes: plan.changes.map(c => ({ path: c.path, beforeHash: c.beforeHash, afterHash: c.afterHash })) };
  console.log(JSON.stringify({ ...result, reports: plan.reports }, null, 2));
  return !write && plan.changes.length ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(`research-activation: ${error.message}`); process.exitCode = 2; }
}
