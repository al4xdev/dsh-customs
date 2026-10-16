#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const profileFiles = Object.freeze(['cordis.yml', 'cordis.patch.yml', 'standard-managed-plugins.yml']);
const yaml = createRequire(join(homedir(), '.local/share/dsh-cli/package.json'))('yaml');
const secretKeys = /^(?:api[-_]?key|password|passwd|secret|client[-_]?secret|client[-_]?id|device[-_]?id|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|credentials?(?:file|path|store)?|access[-_]?token|refresh[-_]?token|id[-_]?token|token|bearer|private[-_]?key)$/i;
const secretLiteral = /(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const credentialPath = /(?:\.codex\/auth\.json|\.dsh\/dsh-auth(?:\/|$)|\bcredentials?\.json\b|\bdevice-id\b)/i;
const publicHosts = new Set(['api.openai.com', 'auth.openai.com', 'api.anthropic.com', 'api.deepseek.com', 'generativelanguage.googleapis.com', 'aiplatform.googleapis.com', 'cloudcode-pa.googleapis.com', 'cloudcode-pa.sandbox.googleapis.com', 'openrouter.ai', 'api.githubcopilot.com', 'api.mistral.ai', 'api.x.ai']);
function absolute(value) { assert(typeof value === 'string' && isAbsolute(value) && resolve(value) === value, 'Normalized absolute path required'); return value; }
const inside = (root, value) => value === root || value.startsWith(root + sep);
function privateUrl(value) {
  const matches = value.match(/https?:\/\/[^\s"'`<>]+/g) ?? [];
  return matches.some(text => {
    try {
      const url = new URL(text.replace(/[),;]+$/, ''));
      return Boolean(url.username || url.password || !publicHosts.has(url.hostname) || [...url.searchParams.keys()].some(key => secretKeys.test(key) || /^(?:code|state)$/i.test(key)));
    } catch { return true; }
  });
}

/** AST-only: !js expressions are retained as text, never evaluated. Private
 * material is removed before serialization; YAML comments are intentionally not
 * transferred because comments may themselves contain credentials or notes. */
export function sanitizeYaml(text, { sourceProfile, targetProfile, repoRoot, targetRepoRoot = repoRoot, pathRemaps = {} } = {}) {
  for (const value of [sourceProfile, targetProfile, repoRoot, targetRepoRoot]) absolute(value);
  const remaps = Object.entries({ [repoRoot]: targetRepoRoot, [sourceProfile]: targetProfile, ...pathRemaps }).sort(([a], [b]) => b.length - a.length);
  for (const [from, to] of remaps) { absolute(from); absolute(to); }
  const document = yaml.parseDocument(text, { logLevel: 'silent', uniqueKeys: true });
  assert.equal(document.errors.length, 0, 'Profile YAML cannot be parsed safely');
  const redactions = [], ids = [], modules = [], jsTags = [];
  function drop(path, reason) { redactions.push({ path, reason }); return false; }
  function string(value, path, isJs) {
    if (secretLiteral.test(value) || credentialPath.test(value)) return drop(path, 'credential-literal-or-storage-reference');
    if (privateUrl(value)) return drop(path, 'private-or-unreviewed-endpoint');
    if (/^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1)/i.test(value)) return drop(path, 'private-endpoint');
    if (isJs) {
      // Pure functions and environment-key references are inert here. Reject
      // resource access/code loaders rather than transporting secret readers.
      const withoutEnv = value.replace(/process\.env\.[A-Z_][A-Z0-9_]*/g, 'ENV_PLACEHOLDER');
      if (/\b(?:require|import|eval|Function|fetch|XMLHttpRequest|WebSocket|readFile|readFileSync|writeFile|writeFileSync|readTextFile|exec|execSync|spawn|spawnSync)\b|\b(?:fs|Deno|Bun|process|globalThis)\s*(?:\.|\[)/.test(withoutEnv)) return drop(path, 'unsafe-js-resource-expression');
      jsTags.push({ path });
    }
    let mapped = value;
    for (const [from, to] of remaps) {
      if (mapped === from || mapped.startsWith(from + '/')) { mapped = to + mapped.slice(from.length); break; }
      if (isJs) mapped = mapped.replaceAll(from + '/', to + '/');
    }
    // Absolute scalar paths outside the selected public roots are not portable.
    if (mapped.startsWith('/') && !inside(targetProfile, mapped) && !inside(targetRepoRoot, mapped) && !Object.values(pathRemaps).some(root => inside(root, mapped))) return drop(path, 'unsupported-absolute-path');
    return mapped;
  }
  function walk(node, path) {
    if (!node) return true;
    delete node.comment; delete node.commentBefore;
    if (node.tag && !yaml.isScalar(node)) return drop(path, 'unsupported-collection-tag');
    if (yaml.isAlias(node)) throw new Error('Profile aliases refused; expand the explicitly selected configuration first');
    if (yaml.isMap(node)) {
      const retained = [];
      for (const pair of node.items) {
        assert(yaml.isScalar(pair.key) && typeof pair.key.value === 'string', 'Only string YAML mapping keys supported');
        delete pair.key.comment; delete pair.key.commentBefore;
        const key = pair.key.value, childPath = path + '/' + key;
        if (secretKeys.test(key)) { drop(childPath, 'credential-key'); continue; }
        if (secretLiteral.test(key)) { drop(path + '/[redacted-key]', 'credential-key-literal'); continue; }
        if (!walk(pair.value, childPath)) continue;
        if (key === 'id' && yaml.isScalar(pair.value) && typeof pair.value.value === 'string') ids.push(pair.value.value);
        if (key === 'name' && yaml.isScalar(pair.value) && typeof pair.value.value === 'string') modules.push(pair.value.value);
        retained.push(pair);
      }
      node.items = retained;
    } else if (yaml.isSeq(node)) {
      node.items = node.items.filter((child, index) => walk(child, path + '/' + index));
    } else if (yaml.isScalar(node)) {
      if (typeof node.value === 'string') {
        const value = string(node.value, path, node.tag === 'tag:yaml.org,2002:js' || node.tag === '!js');
        if (value === false) return false;
        node.value = value;
      }
      if (node.tag && !['tag:yaml.org,2002:js', '!js', 'tag:yaml.org,2002:str', 'tag:yaml.org,2002:int', 'tag:yaml.org,2002:bool', 'tag:yaml.org,2002:null', 'tag:yaml.org,2002:float'].includes(node.tag)) return drop(path, 'unsupported-yaml-tag');
    }
    return true;
  }
  assert(walk(document.contents, ''), 'Root configuration cannot be transferred');
  delete document.comment; delete document.commentBefore;
  const content = document.toString();
  assert(!secretLiteral.test(content) && !credentialPath.test(content), 'Sanitized configuration retained forbidden material');
  return { content, redactions, ids, modules, jsTags };
}

/** Explicit selected-file export only; no profile traversal, runtime writes,
 * credential access, Docker operation, config evaluation or provider calls. */
export async function exportProfile({ sourceProfile, outputRoot, targetProfile, repoRoot, targetRepoRoot = repoRoot, pathRemaps = {} }) {
  for (const path of [sourceProfile, outputRoot, targetProfile, repoRoot, targetRepoRoot]) absolute(path);
  assert.equal(await realpath(sourceProfile), sourceProfile, 'Source profile must be canonical');
  assert.equal(await realpath(repoRoot), repoRoot, 'Repository root must be canonical');
  const privateOutputParent = join(repoRoot, '.dumps/task61');
  assert(inside(privateOutputParent, outputRoot) && outputRoot !== privateOutputParent, 'Export must remain local-only under .dumps/task61');
  assert(!inside(sourceProfile, outputRoot), 'Output cannot overwrite source profile');
  assert(!(await lstat(outputRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; })), 'Export destination must be absent');
  async function selected(file) {
    const path = join(sourceProfile, file);
    assert.equal(await realpath(path), path, 'Selected profile file cannot be a symlink');
    assert((await lstat(path)).isFile(), 'Selected regular file required');
    return readFile(path, 'utf8');
  }
  const manifest = JSON.parse(await selected('package.json'));
  const bundles = manifest.dsh?.profile?.bundles;
  assert(Array.isArray(bundles) && bundles.every(name => typeof name === 'string' && /^@[a-z0-9-]+\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(name)), 'Explicit public package bundles required');
  const dependencies = Object.keys(manifest.dependencies ?? {});
  assert(dependencies.every(name => /^@[a-z0-9-]+\/[a-z0-9-]+$/.test(name)), 'Only public scoped dependency names exported');
  const outputs = [];
  for (const file of profileFiles) outputs.push({ file, ...sanitizeYaml(await selected(file), { sourceProfile, targetProfile, repoRoot, targetRepoRoot, pathRemaps }) });
  // Reserve only after all inputs parse/redact successfully. Partial filesystem
  // failures retain the private directory as evidence and never reuse it.
  assert.equal(await realpath(join(repoRoot, '.dumps')), join(repoRoot, '.dumps'), 'Private scratch root must be canonical');
  const existingParent = await lstat(privateOutputParent).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existingParent) assert(existingParent.isDirectory() && !existingParent.isSymbolicLink(), 'Private output parent must be a regular directory');
  await mkdir(privateOutputParent, { recursive: true, mode: 0o700 });
  assert.equal(await realpath(privateOutputParent), privateOutputParent, 'Private output parent must not escape through a symlink');
  await mkdir(outputRoot, { mode: 0o700 });
  const write = (file, content) => writeFile(join(outputRoot, file), content, { flag: 'wx', mode: 0o600 });
  for (const output of outputs) await write(output.file, output.content);
  const profileManifest = { name: 'dsh-profile-host-test', private: true, dsh: { profile: { bundles } }, dependencies: Object.fromEntries(dependencies.map(name => [name, '*'])) };
  await write('package.json', JSON.stringify(profileManifest, null, 2) + '\n');
  const receipt = { schemaVersion: 1, localPrivateExport: true, sourceFiles: [...profileFiles, 'package.json'], targetProfile, bundles, dependencies, files: outputs.map(({ file, redactions, ids, modules, jsTags }) => ({ file, redactions, ids, modules, jsTags })), credentialsCopied: false, evaluatedJs: false, modelCalls: 0, qualification: 'Selected sanitized profile structure only. Wildcard dependency declarations identify names, not reproducible package pins; caller must wire the existing canonical runtime. Redactions and unavailable services prevent a claim of complete host equivalence.' };
  await write('transfer-receipt.json', JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || (argv.length === 1 && argv[0] === '--help')) return { help: 'Local-only explicit export: --source-profile ABS --output-root ABS --target-profile ABS --repo-root ABS [--target-repo-root ABS] [--path-remaps JSON]. Reads only 3 known YAML files and package.json; never evaluates JS or copies credentials.' };
  const options = {};
  const keys = { '--source-profile': 'sourceProfile', '--output-root': 'outputRoot', '--target-profile': 'targetProfile', '--repo-root': 'repoRoot', '--target-repo-root': 'targetRepoRoot', '--path-remaps': 'pathRemaps' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = keys[argv[i]]; assert(key && !Object.hasOwn(options, key) && argv[i + 1], 'Unknown, duplicate or missing export option');
    options[key] = key === 'pathRemaps' ? JSON.parse(argv[i + 1]) : absolute(argv[i + 1]);
  }
  assert(options.sourceProfile && options.outputRoot && options.targetProfile && options.repoRoot, 'Explicit profile/export roots required');
  return exportProfile(options);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch { console.error('Profile transfer refused; no config values or private diagnostics emitted.'); process.exitCode = 1; }
}
