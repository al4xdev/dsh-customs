import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { QUOTA_CODE, RECOVERY_CODES, resolveConfig } from '../../plugins/llm-resilience/policy.mjs';
import { profileRelative } from '../profile-paths.mjs';

// Match existing repository tooling's dependency resolution without importing a
// profile writer or depending on a running host's private registration tables.
function loadYaml() {
  for (const base of [import.meta.url, join(homedir(), '.local/share/dsh-cli/package.json'), join(homedir(), '.dsh/profiles/package.json')]) {
    try { return createRequire(base)('yaml'); } catch { /* Try the next public dependency location. */ }
  }
  throw new Error('Cannot resolve yaml; install repository dependencies');
}
const YAML = loadYaml();
export const RESILIENCE_PROFILES = Object.freeze(['web', 'headless', 'tui', 'dsh-tui', 'companion']);
export const RESILIENCE_MODULES = Object.freeze({
  'alex-llm-resilience': 'llm-resilience/lib/index-v6-unified.mjs',
  'alex-codex-transient-close': 'codex-transient-close/index.mjs',
  'alex-agent-self-heal': 'agent-self-heal/lib/index-v7-unified.mjs',
});
// Older owned module paths stay recognized so existing profiles migrate in place.
export const LEGACY_RESILIENCE_MODULES = Object.freeze({
  'alex-llm-resilience': Object.freeze(['index.mjs', 'lib/index-v2-unified.mjs', 'lib/index-v3-unified.mjs', 'lib/index-v4-unified.mjs', 'lib/index-v5-unified.mjs'].map(name => `llm-resilience/${name}`)),
  'alex-agent-self-heal': Object.freeze(['index-v2-persistence.mjs', 'index-v3-resilience.mjs', 'index-v4-unified.mjs', 'index-v5-unified.mjs', 'index-v6-unified.mjs'].map(name => `agent-self-heal/lib/${name}`)),
});
// Shared comment for an enabled AGY reset row. The superseded note (from the
// 60-minute contract) is replaced in place rather than left contradicting it.
export const QUOTA_NOTE = '# Harness recovery: provider reset hints are waited up to the shared 24h provider-wait cap; larger minimums suspend.';
const LEGACY_QUOTA_NOTES = Object.freeze(['# Harness recovery: reset hints never extend the shared cap (at most 60min); larger minimums suspend.']);
export class ProfileMigrationError extends Error {
  constructor(code, path) { super(`Resilience profile migration refused: ${code} at ${path}`); this.name = 'ProfileMigrationError'; this.code = code; this.path = path; }
}
const refuse = (code, path) => { throw new ProfileMigrationError(code, path); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const digest = text => createHash('sha256').update(text).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const scalar = value => /^[A-Za-z0-9_./-]+$/.test(value) ? value : JSON.stringify(value);
function plain(node, path) {
  if (!node) return undefined;
  if (node.anchor || node.tag || YAML.isAlias(node)) refuse('indirect-or-tagged-owned-value', path);
  if (YAML.isScalar(node)) return node.value;
  if (YAML.isSeq(node)) return node.items.map((item, index) => plain(item, `${path}[${index}]`));
  if (!YAML.isMap(node)) refuse('unsupported-owned-value', path);
  const result = Object.create(null);
  for (const pair of node.items) {
    const key = plain(pair.key, path);
    if (typeof key !== 'string') refuse('nonliteral-owned-key', path);
    result[key] = plain(pair.value, `${path}.${key}`);
  }
  return result;
}
function mapping(node, path) { if (!YAML.isMap(node) || node.anchor || node.tag) refuse('expected-literal-map', path); return node; }
const pairOf = (map, key) => map.items.find(pair => pair.key?.value === key);
const child = (map, key) => pairOf(map, key)?.value;
function exactKeys(value, allowed, path) { for (const key of Object.keys(value)) if (!allowed.includes(key)) refuse('unsupported-explicit-field', `${path}.${key}`); }

/** Convert only explicit source fields. Never read or compare resolved native
 * defaults: omitted fields deliberately inherit the new central authority.
 */
function providerPatch(node, provider, path) {
  const policy = plain(mapping(node, path), path);
  exactKeys(policy, ['mode', 'maxRetries', 'retryableCodes', 'backoff'], path);
  if (policy.mode !== undefined && policy.mode !== 'normal') refuse('unsupported-explicit-mode', `${path}.mode`);
  const patch = Object.create(null);
  if (own(policy, 'maxRetries')) patch.maxRetries = policy.maxRetries;
  if (own(policy, 'backoff')) {
    if (!policy.backoff || typeof policy.backoff !== 'object' || Array.isArray(policy.backoff)) refuse('invalid-backoff', `${path}.backoff`);
    exactKeys(policy.backoff, ['initialDelayMs', 'maxDelayMs', 'jitterRatio'], `${path}.backoff`);
    Object.assign(patch, policy.backoff);
  }
  if (own(policy, 'retryableCodes')) {
    if (!Array.isArray(policy.retryableCodes)) refuse('unsupported-explicit-codes', path);
    const allowed = [...RECOVERY_CODES, ...(provider === 'google-antigravity' ? [QUOTA_CODE] : [])];
    if (policy.retryableCodes.some(code => !allowed.includes(code))) refuse('unsupported-explicit-codes', path);
    // Keep the native source policy untouched: its captured AGY code remains
    // the sole quota opt-in. Quota admission still uses the shared authority.
    patch.retryableCodes = policy.retryableCodes.filter(code => code !== QUOTA_CODE);
  }
  // Validate the merged result only after the existing central base is known;
  // a sparse cap can be valid under an explicitly shorter global base.
  return patch;
}
function isKnownBaseline(node, path) {
  const value = plain(node, path);
  if (!value || typeof value !== 'object') return false;
  return Object.keys(value).length === 3 && value.mode === 'normal' && value.maxRetries === 9 && value.backoff && Object.keys(value.backoff).length === 3 && value.backoff.initialDelayMs === 5000 && value.backoff.maxDelayMs === 1200000 && value.backoff.jitterRatio === .1;
}

/** Pure proposal only. It never reads/writes profiles, manifests or installed
 * packages. Parent promotion must validate canonical host compatibility and CAS
 * sourceSha256 before any recoverable, allowlisted publication. Change offsets
 * are UTF-16 string indices (YAML CST), explicitly not UTF-8 Buffer byte offsets.
 */
export function migrateResilienceProfile(sourceText, { repoRoot, profile, profileDir } = {}) {
  if (typeof sourceText !== 'string') throw new TypeError('sourceText must be a string');
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) throw new TypeError('repoRoot must be absolute');
  if (profileDir !== undefined && (typeof profileDir !== 'string' || !isAbsolute(profileDir))) throw new TypeError('profileDir must be absolute');
  if (!RESILIENCE_PROFILES.includes(profile)) refuse('unsupported-profile', 'profile');
  const root = resolve(repoRoot);
  const paths = {
    ...Object.fromEntries(Object.entries(RESILIENCE_MODULES).map(([id, module]) => [id, join(root, 'plugins', module)])),
    'antigravity-quota-retry': join(root, 'plugins/antigravity-quota-retry/index.mjs'),
  };
  const acceptedPaths = Object.fromEntries(Object.entries(paths).map(([id, module]) => [id, [module,
    ...(LEGACY_RESILIENCE_MODULES[id] ?? []).map(legacy => join(root, 'plugins', legacy)),
  ].flatMap(path => [path, pathToFileURL(path).href, ...(profileDir ? [profileRelative(profileDir, path)] : [])])]));
  // With a profile directory, owned rows are emitted relative to it so the same
  // profile text resolves under any HOME; without one, legacy absolute output.
  const emitted = Object.fromEntries(Object.entries(paths).map(([id, path]) => [id, profileDir ? profileRelative(profileDir, path) : path]));
  const ownedModuleIds = new Map(Object.entries(acceptedPaths).flatMap(([id, modules]) => modules.map(module => [module, id])));
  const newline = sourceText.includes('\r\n') ? '\r\n' : '\n';
  const doc = YAML.parseDocument(sourceText, { keepSourceTokens: true, uniqueKeys: true });
  if (doc.errors.length) refuse('invalid-yaml', 'document');
  if (doc.contents && !YAML.isSeq(doc.contents)) refuse('expected-patch-sequence', 'document');
  if (doc.contents?.flow && doc.contents.items.length) refuse('flow-root-needs-review', 'document');
  const edits = [], appends = new Map(), rows = [], seen = new Map(), processedPolicies = new Set();
  const lineStart = offset => sourceText.lastIndexOf('\n', offset - 1) + 1;
  const indentAt = offset => offset - lineStart(offset);
  const lineEnd = offset => {
    let i = offset - 1;
    while (i >= 0 && /[\r\n]/.test(sourceText[i])) i--;
    const next = sourceText.indexOf('\n', Math.max(0, i));
    return next < 0 ? sourceText.length : next + 1;
  };
  function edit(start, end, replacement, path, reason, priority = 0) {
    if (sourceText.slice(start, end) !== replacement) edits.push({ start, end, replacement, path, reason, priority });
  }
  function removeNode(node, path, reason) { edit(lineStart(node.range[0]), lineEnd(node.range[2]), '', path, reason); }
  function removePair(map, pair, path, reason) {
    if (map.flow) refuse('flow-removal-needs-review', path);
    edit(lineStart(pair.key.range[0]), lineEnd(pair.value?.range?.[2] ?? pair.key.range[2]), '', path, reason);
  }
  function queueAppend(map, values, path, reason) {
    mapping(map, path);
    if (!Object.keys(values).length) return;
    let pending = appends.get(map);
    if (!pending) { pending = { values: Object.create(null), path, reason }; appends.set(map, pending); }
    for (const [key, value] of Object.entries(values)) {
      if (own(pending.values, key) && !same(pending.values[key], value)) refuse('conflicting-migration-fields', `${path}.${key}`);
      pending.values[key] = value;
    }
  }
  function record(node, location, carrier, sequence) {
    mapping(node, location);
    const idNode = child(node, 'id');
    if (idNode && (!YAML.isScalar(idNode) || typeof idNode.value !== 'string' || idNode.tag || idNode.anchor)) refuse('nonliteral-loader-id', location);
    const id = idNode?.value;
    const name = child(node, 'name')?.value;
    const row = { node, id, location, carrier, sequence };
    rows.push(row);
    if (own(paths, id) || id === 'llm-retry') {
      if (seen.has(id)) refuse('duplicate-owned-id', id);
      seen.set(id, row);
      if (id !== 'llm-retry' && !carrier) refuse('owned-plugin-not-global-insert', location);
      if (id === 'llm-retry' && carrier) refuse('inserted-native-engine-needs-review', location);
    }
    const otherOwnedModule = ownedModuleIds.get(name);
    if (otherOwnedModule && !['alex-llm-resilience', 'antigravity-quota-retry'].includes(otherOwnedModule) && id !== otherOwnedModule) refuse('foreign-owned-plugin-id', location);
    if (name === '@deepseek-ai/dsh-llm-retry' || (typeof name === 'string' && /\/(?:llm-resilience\/(?:index|lib\/index-v[2-6]-unified)|antigravity-quota-retry\/index)\.mjs$/.test(name))) {
      const expected = name === '@deepseek-ai/dsh-llm-retry' ? 'llm-retry' : /\/llm-resilience\//.test(name) ? 'alex-llm-resilience' : 'antigravity-quota-retry';
      if (id !== expected) refuse('foreign-retry-engine-id', location);
    }
  }
  for (const [index, node] of (doc.contents?.items ?? []).entries()) {
    mapping(node, `[${index}]`);
    const insert = child(node, 'insert');
    if (insert) {
      if (!YAML.isSeq(insert) || insert.anchor || insert.tag) refuse('indirect-insert-list', `[${index}].insert`);
      for (const [ordinal, entry] of insert.items.entries()) record(entry, `[${index}].insert[${ordinal}]`, node, insert);
    } else record(node, `[${index}]`);
  }
  // Nested preset-owned copies cannot satisfy the global installation contract.
  function scan(node, path) {
    if (YAML.isMap(node)) {
      const id = child(node, 'id')?.value;
      if ((own(paths, id) || id === 'llm-retry') && !rows.some(row => row.node === node)) refuse('nested-owned-plugin', path);
      for (const pair of node.items) {
        const key = pair.key?.value;
        if (['retryPolicy', 'retryPolicies'].includes(key) && !processedPolicies.has(pair.value)) refuse('unmapped-provider-policy', `${path}.${key}`);
        scan(pair.value, `${path}.${key ?? '?'}`);
      }
    } else if (YAML.isSeq(node)) node.items.forEach((item, index) => scan(item, `${path}[${index}]`));
  }
  for (const id of Object.keys(paths)) {
    const row = seen.get(id);
    if (!row) continue;
    const entry = plain(row.node, row.location);
    exactKeys(entry, ['id', 'name', 'config', 'disabled'], row.location);
    if (entry.disabled !== undefined && entry.disabled !== false) refuse('owned-plugin-disabled', row.location);
    if (!acceptedPaths[id].includes(entry.name)) refuse('foreign-owned-module', `${row.location}.name`);
    if (id === 'alex-codex-transient-close' && entry.config !== undefined && (!entry.config || typeof entry.config !== 'object' || Object.keys(entry.config).length)) refuse('foreign-bridge-config', row.location);
    if (id === 'antigravity-quota-retry') {
      const config = entry.config ?? {};
      if (!config || typeof config !== 'object' || Array.isArray(config)) refuse('foreign-fork-config', row.location);
      exactKeys(config, ['maxQuotaWaitMs'], row.location);
      if (config.maxQuotaWaitMs !== undefined && config.maxQuotaWaitMs !== 86400000) refuse('custom-quota-cap-needs-review', row.location);
    }
  }
  const migrated = Object.create(null);
  function remember(provider, patch, path) {
    if (!provider || typeof provider !== 'string') refuse('nonliteral-provider', path);
    if (!Object.keys(patch).length) return;
    const previous = migrated[provider] ?? Object.create(null);
    for (const [key, value] of Object.entries(patch)) {
      if (own(previous, key) && !same(previous[key], value)) refuse('conflicting-source-provider-policy', path);
      previous[key] = value;
    }
    migrated[provider] = previous;
  }
  function removePolicy(row, config, container, pair, path) {
    // Prune only the now-empty owned ancestors, never neighboring config/OAuth.
    if (container.items.length > 1) return removePair(container, pair, path, 'remove-known-managed-baseline');
    const configPair = pairOf(row.node, 'config');
    if (container !== config && config.items.length > 1) return removePair(config, pairOf(config, 'retryPolicies'), path, 'remove-empty-managed-policy-map');
    if (config.items.length === 1 && row.node.items.length === 2 && !row.carrier) return removeNode(row.node, row.location, 'remove-empty-managed-policy-override');
    removePair(row.node, configPair, `${row.location}.config`, 'remove-empty-managed-policy-config');
  }
  for (const row of rows) {
    if (!['dsh-tui-auth', 'llm-pi-ai-antigravity'].includes(row.id)) continue;
    const config = child(row.node, 'config');
    if (!config) continue;
    mapping(config, `${row.location}.config`);
    if (row.id === 'dsh-tui-auth') {
      const policies = child(config, 'retryPolicies');
      if (!policies) continue;
      processedPolicies.add(policies);
      mapping(policies, `${row.location}.config.retryPolicies`);
      for (const pair of policies.items) {
        const provider = plain(pair.key, row.location), path = `${row.location}.config.retryPolicies.${provider}`;
        if (provider === 'openai-codex' && isKnownBaseline(pair.value, path)) removePolicy(row, config, policies, pair, path);
        else remember(provider, providerPatch(pair.value, provider, path), path);
      }
    } else {
      const quota = child(config, 'quotaResetRetry');
      if (YAML.isMap(quota) && !quota.tag && !quota.anchor && child(quota, 'enabled')?.value === true && child(quota, 'maxWaitMs')?.value === 86400000 && !sourceText.includes(QUOTA_NOTE)) {
        let replaced = false;
        for (const legacy of LEGACY_QUOTA_NOTES) {
          const at = sourceText.indexOf(legacy);
          // Only an exact whole comment line is rewritten; anything else is left alone.
          if (at < 0 || lineStart(at) !== at || !/^\r?\n/.test(sourceText.slice(at + legacy.length))) continue;
          edit(at, at + legacy.length, QUOTA_NOTE, `${row.location}.quotaResetRetry`, 'clarify-shared-quota-cap');
          replaced = true; break;
        }
        if (!replaced) {
          const start = lineStart(row.node.range[0]);
          edit(start, start, QUOTA_NOTE + newline, `${row.location}.quotaResetRetry`, 'clarify-shared-quota-cap');
        }
      }
      const pair = pairOf(config, 'retryPolicy');
      if (!pair) continue;
      processedPolicies.add(pair.value);
      const path = `${row.location}.config.retryPolicy`;
      if (isKnownBaseline(pair.value, path)) removePolicy(row, config, config, pair, path);
      else remember('google-antigravity', providerPatch(pair.value, 'google-antigravity', path), path);
    }
  }
  scan(doc.contents, 'document');

  const controllerRow = seen.get('alex-llm-resilience');
  if (controllerRow) {
    const name = child(controllerRow.node, 'name');
    if (name.value !== emitted['alex-llm-resilience']) edit(name.range[0], name.range[1], scalar(emitted['alex-llm-resilience']), `${controllerRow.location}.name`, 'upgrade-managed-controller-module');
  }
  const existingConfigNode = controllerRow && child(controllerRow.node, 'config');
  const existingConfig = existingConfigNode ? plain(mapping(existingConfigNode, 'alex-llm-resilience.config'), 'alex-llm-resilience.config') : {};
  // Counts are unbounded by default; an explicit cap is any nonnegative safe integer.
  const legacyCap = existingConfig.selfHeal?.maxCycles;
  if (legacyCap !== undefined && (!Number.isSafeInteger(legacyCap) || legacyCap < 0)) refuse('unsupported-self-heal-cap', 'alex-llm-resilience.config.selfHeal.maxCycles');
  try { resolveConfig(existingConfig); } catch { refuse('invalid-central-config', 'alex-llm-resilience.config'); }
  const additions = Object.create(null);
  const finalProviders = Object.assign(Object.create(null), existingConfig.providers ?? {});
  for (const [provider, patch] of Object.entries(migrated)) {
    const current = existingConfig.providers?.[provider] ?? {};
    const missing = Object.create(null);
    for (const [key, value] of Object.entries(patch)) {
      const equal = key === 'retryableCodes' && own(current, key) ? same([...current[key]].sort(), [...value].sort()) : same(current[key], value);
      if (own(current, key) && !equal) refuse('conflicting-central-provider-policy', `providers.${provider}.${key}`);
      if (!own(current, key)) missing[key] = value;
    }
    if (Object.keys(missing).length) additions[provider] = missing;
    finalProviders[provider] = { ...current, ...missing };
  }
  const candidateConfig = { ...existingConfig, ...(Object.keys(finalProviders).length ? { providers: finalProviders } : {}) };
  try { resolveConfig(candidateConfig); } catch { refuse('unrepresentable-central-merge', 'alex-llm-resilience.config'); }
  if (controllerRow && Object.keys(additions).length) {
    if (!existingConfigNode) queueAppend(controllerRow.node, { config: { providers: additions } }, controllerRow.location, 'add-explicit-provider-exceptions');
    else {
      const providersNode = child(existingConfigNode, 'providers');
      if (!providersNode) queueAppend(existingConfigNode, { providers: additions }, 'alex-llm-resilience.config', 'add-explicit-provider-exceptions');
      else for (const [provider, patch] of Object.entries(additions)) {
        const providerNode = child(providersNode, provider);
        if (providerNode) queueAppend(providerNode, patch, `providers.${provider}`, 'extend-explicit-provider-exception');
        else queueAppend(providersNode, { [provider]: patch }, 'providers', 'add-explicit-provider-exception');
      }
    }
  }
  const fork = seen.get('antigravity-quota-retry');
  if (fork) {
    if (fork.sequence.flow) refuse('flow-fork-removal-needs-review', fork.location);
    if (fork.sequence.items.length === 1) {
      if (fork.carrier.items.length !== 1) refuse('custom-insert-carrier-needs-review', fork.location);
      removeNode(fork.carrier, fork.location, 'replace-legacy-retry-engine');
    } else removeNode(fork.node, fork.location, 'remove-legacy-retry-engine');
  }
  const native = seen.get('llm-retry');
  if (native) {
    const name = child(native.node, 'name');
    if (name && name.value !== '@deepseek-ai/dsh-llm-retry') refuse('foreign-native-engine-module', native.location);
    const disabled = child(native.node, 'disabled');
    if (disabled) {
      if (!YAML.isScalar(disabled) || typeof disabled.value !== 'boolean') refuse('nonliteral-native-disable', native.location);
      if (!disabled.value) edit(disabled.range[0], disabled.range[1], 'true', `${native.location}.disabled`, 'disable-native-retry-engine');
    } else queueAppend(native.node, { disabled: true }, native.location, 'disable-native-retry-engine');
  }
  const heal = seen.get('alex-agent-self-heal');
  if (heal) {
    const name = child(heal.node, 'name');
    if (name.value !== emitted['alex-agent-self-heal']) edit(name.range[0], name.range[1], scalar(emitted['alex-agent-self-heal']), `${heal.location}.name`, 'upgrade-managed-self-heal-module');
    const configNode = child(heal.node, 'config');
    const config = configNode ? plain(mapping(configNode, 'alex-agent-self-heal.config'), 'alex-agent-self-heal.config') : {};
    exactKeys(config, ['maxCycles'], 'alex-agent-self-heal.config');
    if (own(config, 'maxCycles') && (!Number.isSafeInteger(config.maxCycles) || config.maxCycles < 0)) refuse('invalid-local-self-heal-cap', 'alex-agent-self-heal.config.maxCycles');
    // A written cap remains an opt-down, including the previous default of 3.
    // Only omission inherits the unified budget; migration cannot grant credits.
    if (!configNode) queueAppend(heal.node, { config: {} }, heal.location, 'declare-central-self-heal-default');
  }
  const missingEntries = [];
  for (const id of ['alex-llm-resilience', 'alex-codex-transient-close', 'alex-agent-self-heal']) {
    if (!seen.has(id)) missingEntries.push({ id, name: emitted[id], config: id === 'alex-llm-resilience' ? candidateConfig : {} });
  }
  for (const [map, { values, path, reason }] of appends) {
    if (map.flow) {
      const end = map.range[1] - 1;
      if (sourceText[end] !== '}') refuse('unsupported-flow-map-range', path);
      const pairs = Object.entries(values).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ');
      edit(end, end, `${map.items.length ? ', ' : ''}${pairs}`, path, reason, indentAt(map.range[0]));
    } else {
      const indent = indentAt(map.items[0].key.range[0]);
      const end = lineEnd(map.range[2]);
      const replacement = YAML.stringify(values).trimEnd().split('\n').map(line => ' '.repeat(indent) + line).join(newline) + newline;
      edit(end, end, (end > 0 && sourceText[end - 1] !== '\n' ? newline : '') + replacement, path, reason, indent);
    }
  }
  const tail = [];
  if (!native) tail.push({ id: 'llm-retry', disabled: true });
  if (missingEntries.length) tail.push({ insert: missingEntries });
  if (tail.length) {
    const rendered = YAML.stringify(tail).trimEnd().replaceAll('\n', newline);
    if (doc.contents?.flow && doc.contents.items.length === 0) edit(doc.contents.range[0], doc.contents.range[1], rendered, 'document', 'install-global-resilience-composition', -1);
    else edit(sourceText.length, sourceText.length, `${sourceText.length && !sourceText.endsWith('\n') ? newline : ''}${rendered}${newline}`, 'document', 'install-global-resilience-composition', -1);
  }
  edits.sort((a, b) => a.start - b.start || a.end - b.end || b.priority - a.priority);
  let candidate = '', cursor = 0;
  for (const change of edits) {
    if (change.start < cursor) refuse('overlapping-targeted-edits', change.path);
    candidate += sourceText.slice(cursor, change.start) + change.replacement;
    cursor = change.end;
  }
  candidate += sourceText.slice(cursor);
  const parsed = YAML.parseDocument(candidate, { uniqueKeys: true });
  if (parsed.errors.length) refuse('candidate-yaml-invalid', 'document');
  const changes = Object.freeze(edits.map(({ priority, ...change }) => Object.freeze(change)));
  return Object.freeze({ candidate, changed: candidate !== sourceText, changes, sourceSha256: digest(sourceText), candidateSha256: digest(candidate), profile, offsetEncoding: 'utf16', recoveryVersion: 3, requiresCompatValidation: true });
}
