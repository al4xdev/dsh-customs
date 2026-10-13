import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LAYOUT, DEFAULT_PROOFS, PI_VERSION, processGate, webControl } from './cold.mjs';

export const VERSION_PAIRS = Object.freeze({
  '@babel/runtime': ['7.29.7', '7.29.10'],
  '@opentelemetry/resources': ['2.11.0', '2.12.0'],
  'node-addon-native-custom-loader': ['0.1.7', '0.1.9'],
  'node-addon-require-builtin': ['0.1.7', '0.1.9'],
});
const ORIGIN_LOCKS = Object.freeze([
  { file: 'package-lock.json', hash: 'c074ac01fdfff03256637a9761c63171d920d01d646df0004f15ceef73dd8dd6' },
  { file: 'node_modules/.package-lock.json', hash: '9754a698d8bbc3bcf554e9d956daf5136285256aebf3a4de6f2f32a537cdd7a5' },
]);
export const ALIASES = Object.freeze({
  '@tanstack/react-virtual': { oldRelative: 'node_modules/@deepseek-ai/dsh-client-ui-trajectory/node_modules/@tanstack/react-virtual', action: 'retire' },
  'react-dom': { oldRelative: 'node_modules/@deepseek-ai/dsh-client-ui-trajectory/node_modules/react-dom', action: 'retire' },
  'debug': { oldRelative: 'node_modules/express/node_modules/debug', action: 'retarget', version: '2.6.9', locks: ORIGIN_LOCKS },
  'ms': { oldRelative: 'node_modules/express/node_modules/ms', action: 'retarget', version: '2.0.0', locks: ORIGIN_LOCKS },
});
// Public symlink selection, frozen from the approved 203-name audit (no private config).
export const BASELINE = Object.freeze({
  missingDigest: '0463e4aacb6ec0240f12d4f6872ebbec7b05cf6cef3e6a82d90facaa0583e922',
  liveDigest: 'ce562a4fda7775f9f70e670a33eeb389bf7f8b7653d4e398bd87cb6136bfc667',
  missingNames: Object.freeze(`
@aws-crypto/sha256-browser @aws-crypto/sha256-js @aws-crypto/supports-web-crypto @aws-crypto/util @aws-sdk/util-locate-window
@deepseek-ai/cordis-plugin-hmr @deepseek-ai/dsh-agent-presets @deepseek-ai/dsh-client-runtime @deepseek-ai/dsh-client-schema-form
@deepseek-ai/dsh-client-web @deepseek-ai/dsh-client-web-react @deepseek-ai/dsh-code-runtime @deepseek-ai/dsh-code-runtime-worker-thread
@deepseek-ai/dsh-host-apiproxy @deepseek-ai/dsh-settings-file @deepseek-ai/dsh-tool-subagent-report @deepseek-ai/dsh-workflow-worker-thread
@deepseek-ai/node-addon-landlock-run @hono/node-server @lexical/clipboard @lexical/dragon @lexical/extension @lexical/history
@lexical/html @lexical/internal @lexical/list @lexical/plain-text @lexical/selection @lexical/text @lexical/utils
@mistralai/mistralai @modelcontextprotocol/sdk @opentelemetry/exporter-logs-otlp-http @preact/signals-core @shikijs/core
@shikijs/engine-javascript @shikijs/engine-oniguruma @shikijs/langs @shikijs/primitive @shikijs/themes @shikijs/types @shikijs/vscode-textmate
@smithy/is-array-buffer @smithy/util-buffer-from @smithy/util-utf8 @tanstack/virtual-core @types/debug @types/hast @types/katex
@types/mdast @types/ms @types/trusted-types @types/unist @ungap/structured-clone accepts ajv-formats anser body-parser
call-bind-apply-helpers call-bound ccount character-entities character-entities-html4 character-entities-legacy clsx comma-separated-tokens
content-disposition cookie cookie-signature cors decode-named-character-reference depd dequal devlop dunder-proto ee-first encodeurl
es-define-property es-errors es-object-atoms escape-html escape-string-regexp etag express express-rate-limit finalhandler forwarded
fresh function-bind get-intrinsic get-proto gopd has-symbols hasown hast-util-to-html hast-util-whitespace hono html-void-elements
http-errors iconv-lite immer inherits ip-address is-promise json-schema-typed katex lexical longest-streak loose-envify markdown-table
math-intrinsics mdast-util-find-and-replace mdast-util-from-markdown mdast-util-gfm mdast-util-gfm-autolink-literal mdast-util-gfm-footnote
mdast-util-gfm-strikethrough mdast-util-gfm-table mdast-util-gfm-task-list-item mdast-util-math mdast-util-phrasing mdast-util-to-hast
mdast-util-to-markdown mdast-util-to-string media-typer merge-descriptors micromark micromark-core-commonmark micromark-extension-gfm
micromark-extension-gfm-autolink-literal micromark-extension-gfm-footnote micromark-extension-gfm-strikethrough micromark-extension-gfm-table
micromark-extension-gfm-tagfilter micromark-extension-gfm-task-list-item micromark-extension-math micromark-factory-destination
micromark-factory-label micromark-factory-space micromark-factory-title micromark-factory-whitespace micromark-util-character
micromark-util-chunked micromark-util-classify-character micromark-util-combine-extensions micromark-util-decode-numeric-character-reference
micromark-util-decode-string micromark-util-encode micromark-util-html-tag-name micromark-util-normalize-identifier micromark-util-resolve-all
micromark-util-sanitize-uri micromark-util-subtokenize micromark-util-symbol micromark-util-types object-assign object-inspect on-finished once
oniguruma-parser oniguruma-to-es parseurl path-to-regexp property-information proxy-addr qs range-parser raw-body react regex regex-recursion
regex-utilities router safer-buffer scheduler send serve-static setprototypeof shiki side-channel side-channel-list side-channel-map
side-channel-weakmap space-separated-tokens statuses stringify-entities toidentifier trim-lines type-is unist-util-is unist-util-position
unist-util-remove-position unist-util-stringify-position unist-util-visit unist-util-visit-parents unpipe use-sync-external-store vfile
vfile-message wrappy zod-to-json-schema zustand zwitch
`.trim().split(/\s+/).sort()),
});
export const EXPECTED_COUNTS = Object.freeze({ shared: 608, directLive: 401, directMissing: 203, aliases: 4, aliasesRetire: 2, aliasesRepair: 2, scratch: 1, canonical: 0, retarget: 404, retire: 205 });
export const COMPLETED_COUNTS = Object.freeze({ shared: 403, directLive: 401, directMissing: 0, aliases: 2, aliasesRetire: 0, aliasesRepair: 2, scratch: 1, canonical: 404, retarget: 0, retire: 0 });
const ADAPTER = '@deepseek-ai/dsh-llm-pi-ai';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inside = (root, p) => typeof p === 'string' && (p === root || p.startsWith(root + path.sep));
const fail = message => { throw new Error(message); };
const stat = p => { try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const real = p => { try { return fs.realpathSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function directory(p) { if (!stat(p)?.isDirectory() || real(p) !== p) fail('Directory confinement failed: ' + p); }
function attributes(p) {
  const s = stat(p); if (!s) return null;
  return { mode: s.mode & 0o777, uid: s.uid, gid: s.gid, ino: s.ino, dev: s.dev, mtimeMs: s.mtimeMs };
}
function link(p) {
  if (!stat(p)?.isSymbolicLink()) fail('Symlink conflict: ' + p);
  return { ...attributes(p), target: fs.readlinkSync(p), real: real(p) };
}
// For missing targets, resolve the nearest existing ancestor to detect redirected parents.
function confined(root, target) {
  if (!inside(root, target)) fail('Target escapes approved root');
  let p = target;
  while (!stat(p) && p !== root) p = path.dirname(p);
  if (!inside(root, real(p))) fail('Target ancestor escapes approved root');
}
function metadata(p, name, root) {
  confined(root, p);
  const physical = real(p);
  if (!physical || !inside(root, physical)) fail('Missing/escaped package: ' + name);
  const file = path.join(physical, 'package.json');
  if (!stat(file)?.isFile()) fail('Nonregular package manifest: ' + name);
  const bytes = fs.readFileSync(file), m = JSON.parse(bytes);
  if (m.name !== name || typeof m.version !== 'string') fail('Package identity mismatch: ' + name);
  return { name, version: m.version, real: physical, hash: sha(bytes) };
}
function proofs(layout, pins) {
  for (const [relative, expected] of Object.entries(pins)) {
    const p = path.resolve(layout.cli, relative); confined(layout.cli, p);
    if (!stat(p)?.isFile() || sha(fs.readFileSync(p)) !== expected) fail('Static hash mismatch: ' + relative);
  }
}
function adapterBytes(root) {
  const entries = [];
  function visit(p, relative) {
    const s = stat(p);
    if (s?.isDirectory()) for (const n of fs.readdirSync(p).sort()) {
      if (n === 'node_modules') fail('Unexpected nested adapter dependencies');
      visit(path.join(p, n), relative ? relative + '/' + n : n);
    }
    else if (s?.isFile()) entries.push([relative, sha(fs.readFileSync(p))]);
    else fail('Nonregular adapter code');
  }
  visit(root, ''); return entries;
}
function packagePaths(root) {
  directory(root); const out = [];
  for (const name of fs.readdirSync(root).sort()) {
    const p = path.join(root, name);
    if (name.startsWith('@') && stat(p)?.isDirectory()) {
      directory(p);
      for (const child of fs.readdirSync(p).sort()) out.push([name + '/' + child, path.join(p, child)]);
    } else out.push([name, p]);
  }
  return out;
}
function origin(layout, name, rule) {
  const hoisted = metadata(path.join(layout.npx, 'node_modules', name), name, layout.npx);
  if (hoisted.version !== rule.version) fail('Hoisted source version mismatch: ' + name);
  const locks = rule.locks.map(proof => {
    const file = path.resolve(layout.npx, proof.file); confined(layout.npx, file);
    if (!stat(file)?.isFile()) fail('Missing alias origin lock: ' + name);
    const bytes = fs.readFileSync(file), key = 'node_modules/' + name, record = JSON.parse(bytes).packages?.[key];
    if (!record || record.version !== rule.version || (record.name && record.name !== name) || sha(bytes) !== proof.hash) fail('Alias origin lock mismatch: ' + name);
    return { file, key, version: record.version, hash: sha(bytes) };
  });
  return { nestedIdentity: 'UNKNOWN (absent)', proof: 'approved hoisted repair, not nested identity equivalence', version: rule.version, hoisted, locks };
}
function classify(layout, name, p, scratch, options) {
  if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) fail('Invalid package name');
  directory(path.dirname(p));
  const before = link(p), currentTarget = path.resolve(path.dirname(p), before.target);
  if (before.mode !== 0o777 || before.uid !== process.getuid() || before.gid !== process.getgid()) fail('Unsupported symlink attributes: ' + name);
  const oldRoot = scratch ? layout.scratch : layout.npx;
  const direct = path.join(oldRoot, 'node_modules', name), newTarget = path.join(layout.cli, 'node_modules', name);
  const rule = !scratch ? (options.aliases ?? ALIASES)[name] : null;
  const canonical = currentTarget === newTarget && before.real === real(newTarget);
  // Idempotent verification still proves the original package set against retained N/S.
  const oldTarget = canonical ? rule ? path.resolve(layout.npx, rule.oldRelative) : direct : currentTarget;
  const alias = oldTarget !== direct;
  if (alias && (!rule || oldTarget !== path.resolve(layout.npx, rule.oldRelative))) fail('Unapproved alias target: ' + name);
  confined(oldRoot, oldTarget); confined(layout.cli, newTarget);
  const entry = { name, path: p, before, oldTarget, newTarget, kind: scratch ? 'scratch' : alias ? 'alias' : stat(oldTarget) ? 'directLive' : 'directMissing' };
  if (!stat(oldTarget) && !stat(newTarget)) {
    if (scratch || (alias && rule.action !== 'retire')) fail('Unapproved absent target: ' + name);
    return { ...entry, action: 'retire' };
  }
  const next = metadata(newTarget, name, layout.cli);
  let previous;
  if (alias) {
    if (rule.action !== 'retarget' || stat(oldTarget)) fail('Unexpected alias source state: ' + name);
    previous = origin(layout, name, rule);
    if (next.version !== previous.version) fail('Alias canonical version mismatch: ' + name);
  } else {
    previous = metadata(oldTarget, name, oldRoot);
    const pair = VERSION_PAIRS[name];
    const intentional = pair && previous.version === pair[0] && next.version === pair[1];
    const pi = name === '@earendil-works/pi-ai' && ['0.87.1', '0.87.1+alex.codex-default.7f8948d3c423'].includes(previous.version) && next.version === PI_VERSION;
    if (previous.version !== next.version && !intentional && !pi) fail('Unapproved version transition: ' + name);
  }
  if (scratch) {
    const oldBytes = adapterBytes(previous.real), newBytes = adapterBytes(next.real);
    if (!same(oldBytes, newBytes) || oldBytes.length !== (options.adapterFiles ?? 18)) fail('Adapter bytes/count mismatch');
    entry.adapterHash = sha(JSON.stringify(oldBytes));
  }
  return { ...entry, action: canonical ? 'preserve-canonical' : 'retarget', previous, next };
}
export function preview(layout = DEFAULT_LAYOUT, options = {}) {
  const result = { mode: 'preview', blockers: [], entries: [], preserved: [], counts: { shared: 0, directLive: 0, directMissing: 0, aliases: 0, aliasesRetire: 0, aliasesRepair: 0, scratch: 0, canonical: 0, retarget: 0, retire: 0 }, safeNextCleanup: 'Roots N/scratch retained: separately verify helper, candidate/compiler and process references before any removal.' };
  const attempt = fn => { try { return fn(); } catch (e) { result.blockers.push(e.message); return null; } };
  attempt(() => { for (const p of [layout.cli, layout.npx, layout.scratch, layout.profiles]) directory(p); proofs(layout, options.proofs ?? DEFAULT_PROOFS); });
  function collect(name, p, scratch = false) {
    if (!stat(p)?.isSymbolicLink()) { result.preserved.push({ path: p, attributes: attributes(p) }); return; }
    if (!scratch) result.counts.shared++;
    const e = attempt(() => classify(layout, name, p, scratch, options));
    if (!e) return;
    result.counts[e.kind === 'alias' ? 'aliases' : e.kind]++;
    if (e.kind === 'alias') result.counts[e.action === 'retire' ? 'aliasesRetire' : 'aliasesRepair']++;
    if (e.action === 'preserve-canonical') { result.counts.canonical++; result.preserved.push(e); return; }
    result.entries.push(e);
    result.counts[e.action]++;
  }
  for (const [name, p] of attempt(() => packagePaths(path.join(layout.profiles, 'node_modules'))) ?? []) collect(name, p);
  const adapter = path.join(layout.profiles, 'dsh-tui/node_modules', ADAPTER);
  attempt(() => { directory(path.dirname(path.dirname(adapter))); collect(ADAPTER, adapter, true); });
  result.stage = result.entries.length === 0 && result.counts.canonical > 0 ? 'completed' : 'initial';
  const counts = result.stage === 'completed' ? options.completedCounts ?? options.expectedCounts ?? COMPLETED_COUNTS : options.expectedCounts ?? EXPECTED_COUNTS;
  for (const [key, expected] of Object.entries(counts)) if (result.counts[key] !== expected) result.blockers.push('Count drift: ' + key);
  const baseline = options.baseline === undefined ? BASELINE : options.baseline;
  if (baseline) attempt(() => {
    if (sha(baseline.missingNames.join('\n')) !== baseline.missingDigest) fail('Obsolete baseline transcription mismatch');
    const liveNames = [...result.entries, ...result.preserved].filter(e => e.kind === 'directLive').map(e => e.name).sort();
    if (sha(liveNames.join('\n') + '\n') !== baseline.liveDigest) fail('Live package selection digest mismatch');
    if (result.stage === 'initial') {
      const missingNames = result.entries.filter(e => e.kind === 'directMissing').map(e => e.name).sort();
      if (!same(missingNames, baseline.missingNames)) fail('Obsolete selection digest/membership mismatch');
    } else for (const name of [...baseline.missingNames, ...Object.entries(options.aliases ?? ALIASES).filter(([, rule]) => rule.action === 'retire').map(([name]) => name)]) {
      if (stat(path.join(layout.profiles, 'node_modules', name))) fail('Obsolete link reappeared: ' + name);
      const rule = (options.aliases ?? ALIASES)[name];
      const old = rule ? path.resolve(layout.npx, rule.oldRelative) : path.join(layout.npx, 'node_modules', name);
      const next = path.join(layout.cli, 'node_modules', name);
      confined(layout.npx, old); confined(layout.cli, next);
      if (stat(old) || stat(next)) fail('Obsolete target appeared: ' + name);
    }
  });
  result.blockers.push(...(options.gate ?? processGate)(layout));
  result.complete = result.blockers.length === 0;
  return result;
}
function requireGate(layout, gate, afterStop = false) { if (gate(layout, { afterStop }).length) fail('Cold gate rejected: active TUI/consumer'); }
export function apply(layout = DEFAULT_LAYOUT, options = {}) {
  const gate = options.gate ?? processGate, service = options.service ?? webControl;
  requireGate(layout, gate);
  const plan = preview(layout, { ...options, gate });
  if (!plan.complete) fail('Incomplete classified mapping: ' + JSON.stringify(plan.blockers));
  if (plan.entries.length === 0) return { state: 'complete', counts: plan.counts, actions: 0, safeNextCleanup: plan.safeNextCleanup };
  const active = service('is-active') === 'active';
  if (active) service('stop');
  let receipt;
  const record = value => fs.appendFileSync(receipt, JSON.stringify(value) + '\n', { mode: 0o600 });
  try {
    requireGate(layout, gate, true);
    const second = preview(layout, { ...options, gate });
    if (!second.complete || !same(plan.entries, second.entries) || !same(plan.preserved, second.preserved)) fail('Mapping changed after web stop');
    const tempRoot = options.tempRoot ?? '/tmp'; directory(tempRoot);
    const temp = fs.mkdtempSync(path.join(tempRoot, 'dsh-finish-')); fs.chmodSync(temp, 0o700);
    receipt = path.join(temp, 'receipt.jsonl');
    fs.writeFileSync(receipt, JSON.stringify({ approval: 'task7-r9', entries: plan.entries, preserved: plan.preserved, state: 'selected' }) + '\n', { flag: 'wx', mode: 0o600 });
    function guard(e) {
      requireGate(layout, gate, true); proofs(layout, options.proofs ?? DEFAULT_PROOFS);
      if (!same(classify(layout, e.name, e.path, e.kind === 'scratch', options), e)) fail('Target/inode/metadata conflict: ' + e.name);
    }
    for (const e of plan.entries) {
      options.beforeAction?.(e); guard(e); record({ name: e.name, state: 'pending', action: e.action });
      if (e.action === 'retire') { guard(e); fs.unlinkSync(e.path); }
      else {
        const staging = path.join(path.dirname(e.path), '.dsh-finish-' + crypto.randomUUID());
        fs.symlinkSync(e.newTarget, staging);
        try {
          guard(e);
          if (real(staging) !== e.next.real || fs.readlinkSync(staging) !== e.newTarget) fail('Staged target mismatch');
          fs.renameSync(staging, e.path);
        } finally { if (stat(staging)) fs.unlinkSync(staging); }
      }
      record({ name: e.name, state: 'completed', after: stat(e.path)?.isSymbolicLink() ? link(e.path) : null });
    }
    requireGate(layout, gate, true); proofs(layout, options.proofs ?? DEFAULT_PROOFS);
    for (const e of plan.entries) {
      if (e.action === 'retire') { if (stat(e.path)) fail('Retired link reappeared: ' + e.name); }
      else if (fs.readlinkSync(e.path) !== e.newTarget || real(e.path) !== e.next.real || !same(metadata(e.newTarget, e.name, layout.cli), e.next)) fail('Final canonical resolution mismatch: ' + e.name);
    }
    for (const e of plan.preserved) {
      if (e.action === 'preserve-canonical') { if (!same(link(e.path), e.before)) fail('Preserved canonical link changed'); }
      else if (!same(attributes(e.path), e.attributes)) fail('Regular path changed: ' + e.path);
    }
    const final = preview(layout, { ...options, gate });
    if (!final.complete || final.entries.length) fail('Final selected graph validation failed: ' + JSON.stringify(final.blockers));
    record({ state: 'complete', counts: plan.counts });
    return { state: 'complete', receipt, counts: plan.counts, safeNextCleanup: plan.safeNextCleanup };
  } catch (e) { if (receipt) record({ state: 'partial', error: e.message }); throw new Error(e.message + (receipt ? '; progress receipt: ' + receipt : '')); }
  finally { if (active) service('start'); }
}
export function main(args = process.argv.slice(2)) {
  if (args.length === 0 || same(args, ['--preview'])) return preview();
  if (same(args, ['--apply'])) return apply();
  fail('Usage: finish.mjs [--preview | --apply]');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = main(); console.log(JSON.stringify(result, null, 2)); if (result.complete === false) process.exitCode = 2; }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
