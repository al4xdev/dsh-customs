#!/usr/bin/env node
// Read-only recovery doctor: never writes profiles, the SDK, sessions or bundles,
// never reads credentials or session logs, and never contacts a model.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveProfilePath } from '../profile-paths.mjs';
import { LEGACY_RESILIENCE_MODULES, RESILIENCE_MODULES } from './profile.mjs';

const defaultRepo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const AUDIT_EVENT = 'agent/self-heal';
// Paired contract: owner7 binds only to controller6's llmRecoveryUnbounded.
const OWNED = Object.freeze(['alex-llm-resilience', 'alex-agent-self-heal']);

export function defaultPaths(env = process.env) {
  return {
    repoRoot: defaultRepo,
    dshHome: env.DSH_HOME ?? join(env.HOME || homedir(), '.dsh'),
    // Same runtime location rule as the dsh launcher: XDG_DATA_HOME, else ~/.local/share.
    runtimeRoot: join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local/share'), 'dsh-cli'),
  };
}

function loadYaml(repoRoot, runtimeRoot, dshHome) {
  for (const base of [join(repoRoot, 'package.json'), join(runtimeRoot, 'package.json'), join(dshHome, 'profiles/package.json')]) {
    try { return createRequire(base)('yaml'); } catch { /* next public dependency location */ }
  }
  throw new Error('Cannot resolve yaml; install repository dependencies');
}

/** SDK bridge: both static catalog faces must name agent/self-heal, and the real
 * persistence validator must accept a stored owner audit (payload v1 and v2). */
async function checkSdk(runtimeRoot) {
  const result = { id: 'sdk-persistence-bridge', runtimeRoot, ok: false, details: {} };
  let require;
  try { require = createRequire(join(runtimeRoot, 'package.json')); } catch { result.reason = 'runtime-missing'; return result; }
  let sessionRoot;
  // The package root holds lib/index.js; metadata exports are optional.
  try { sessionRoot = dirname(dirname(require.resolve('@deepseek-ai/dsh-session'))); }
  catch { result.reason = 'dsh-session-missing'; return result; }
  for (const face of ['lib/index.js', 'lib/types/known-event-types.js']) {
    const text = existsSync(join(sessionRoot, face)) ? readFileSync(join(sessionRoot, face), 'utf8') : '';
    result.details[face] = text.includes(`'${AUDIT_EVENT}'`) || text.includes(`"${AUDIT_EVENT}"`);
  }
  try {
    const { validateStoredEvents } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence')).href);
    const header = { version: 4, id: 'recovery-doctor-probe', createdAt: 0 };
    for (const version of [1, 2]) validateStoredEvents(header, [{ type: AUDIT_EVENT, seq: 0, time: 0, data: { version, action: 'observed', turn: 1, step: 1, state: { lastHealthyTurn: 0 } } }]);
    let unknownRefused = false;
    try { validateStoredEvents(header, [{ type: 'agent/recovery-doctor-unknown', seq: 0, time: 0, data: {} }]); } catch { unknownRefused = true; }
    result.details.validatorAcceptsOwnerAudit = true;
    result.details.unknownRequiredEventRefused = unknownRefused;
  } catch { result.details.validatorAcceptsOwnerAudit = false; }
  result.ok = Object.values(result.details).every(Boolean);
  if (!result.ok) result.reason = 'bridge-absent-or-incomplete';
  return result;
}

/** Reviewed artifacts: each active bundle must match its sidecar hash. Source
 * drift after the build is reported (a rebuild would differ), not fatal. */
function checkArtifacts(repoRoot) {
  return OWNED.map(id => {
    const module = RESILIENCE_MODULES[id], path = join(repoRoot, 'plugins', module);
    const record = path.replace(/\.mjs$/, '.build.json');
    const result = { id: `artifact:${id}`, module, ok: false };
    if (!existsSync(path) || !existsSync(record)) { result.reason = 'artifact-or-record-missing'; return result; }
    const parsed = JSON.parse(readFileSync(record, 'utf8'));
    result.sha256 = sha(readFileSync(path));
    result.ok = parsed.sha256 === result.sha256;
    if (!result.ok) result.reason = 'artifact-differs-from-record';
    result.sourceDrift = Object.entries(parsed.sourceHashes ?? {}).filter(([source, hash]) => !existsSync(join(repoRoot, source)) || sha(readFileSync(join(repoRoot, source))) !== hash).map(([source]) => source);
    return result;
  });
}

function moduleTarget(profileDir, name) {
  if (typeof name !== 'string') return undefined;
  if (name.startsWith('file://')) { try { return fileURLToPath(name); } catch { return undefined; } }
  const resolved = resolveProfilePath(profileDir, name);
  return isAbsolute(resolved) ? resolve(resolved) : undefined;
}

/** Profiles: exactly one enabled owner, controller and typed-failure bridge row,
 * on the expected contract-3 pair (an older owned path is "outdated", anything
 * else "foreign"), controller before owner, and exactly one native llm-retry
 * row, disabled. Explicit finite caps are reported as warnings, not failures. */
function checkProfiles({ repoRoot, dshHome }, YAML, manifest) {
  const results = [];
  const profiles = [...new Set(manifest.plugins.filter(plugin => OWNED.includes(plugin.id)).flatMap(plugin => plugin.profiles ?? manifest.profiles))];
  const bridge = 'alex-codex-transient-close';
  for (const profile of profiles) {
    const profileDir = join(dshHome, 'profiles', profile), file = join(profileDir, 'cordis.patch.yml');
    const result = { id: `profile:${profile}`, path: file, ok: false, rows: {}, problems: [], warnings: [] };
    results.push(result);
    if (!existsSync(file)) { result.reason = 'profile-missing'; result.problems.push(result.reason); continue; }
    const doc = YAML.parseDocument(readFileSync(file, 'utf8'));
    if (doc.errors.length) { result.reason = 'invalid-yaml'; result.problems.push(result.reason); continue; }
    // Document order, inserts flattened in place: load order matters for HMR.
    const rows = [];
    for (const item of doc.toJS() ?? []) {
      if (item && Array.isArray(item.insert)) rows.push(...item.insert); else if (item) rows.push(item);
    }
    const expectedModules = { ...RESILIENCE_MODULES, [bridge]: 'codex-transient-close/index.mjs' };
    for (const id of [...OWNED, bridge]) {
      const matches = rows.filter(row => row?.id === id);
      const expected = join(repoRoot, 'plugins', expectedModules[id]);
      const legacy = (LEGACY_RESILIENCE_MODULES[id] ?? []).map(module => join(repoRoot, 'plugins', module));
      const target = moduleTarget(profileDir, matches[0]?.name);
      const status = matches.length !== 1 ? (matches.length ? 'duplicate' : 'missing')
        : matches[0].disabled === true ? 'disabled'
          : target === expected ? 'current' : legacy.includes(target) ? 'outdated' : 'foreign';
      result.rows[id] = { status, module: matches[0]?.name ?? null, index: matches.length === 1 ? rows.indexOf(matches[0]) : null };
    }
    const natives = rows.filter(row => row?.id === 'llm-retry');
    result.rows['llm-retry'] = { status: natives.length > 1 ? 'duplicate' : natives[0]?.disabled === true ? 'disabled' : natives.length ? 'enabled' : 'missing' };
    const controllerRow = result.rows['alex-llm-resilience'], ownerRow = result.rows['alex-agent-self-heal'];
    const statuses = OWNED.map(id => result.rows[id].status);
    if (statuses.includes('current') && statuses.some(status => status !== 'current')) result.problems.push('mismatched-owner-controller-pair');
    else if (statuses.every(status => status === 'outdated')) result.problems.push('outdated-pair');
    else if (statuses.some(status => status !== 'current')) result.problems.push('unexpected-recovery-rows');
    if (result.rows[bridge].status !== 'current') result.problems.push(result.rows[bridge].status === 'missing' ? 'missing-typed-failure-bridge' : 'unexpected-typed-failure-bridge');
    if (natives.length > 1) result.problems.push('duplicate-native-retry');
    else if (result.rows['llm-retry'].status !== 'disabled') result.problems.push('native-retry-not-disabled');
    if (controllerRow.index !== null && ownerRow.index !== null && ownerRow.index < controllerRow.index) result.problems.push('owner-before-controller');
    // Warnings: explicit finite caps narrow the unbounded default (owner choice).
    const controllerConfig = rows.find(row => row?.id === 'alex-llm-resilience')?.config ?? {};
    const finite = (path, value) => { if (Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER) result.warnings.push(`${value === 0 ? 'explicit-opt-out' : 'explicit-finite-cap'}:${path}=${value}`); };
    finite('alex-llm-resilience.policy.maxRetries', controllerConfig?.policy?.maxRetries);
    for (const [route, patch] of Object.entries(controllerConfig?.providers ?? {})) finite(`alex-llm-resilience.providers.${route}.maxRetries`, patch?.maxRetries);
    finite('alex-llm-resilience.selfHeal.maxCycles', controllerConfig?.selfHeal?.maxCycles);
    finite('alex-agent-self-heal.maxCycles', rows.find(row => row?.id === 'alex-agent-self-heal')?.config?.maxCycles);
    result.ok = result.problems.length === 0;
    if (!result.ok) result.reason = result.problems[0];
  }
  return results;
}

export async function doctor(options = {}) {
  const paths = { ...defaultPaths(), ...options };
  for (const key of ['repoRoot', 'dshHome', 'runtimeRoot']) if (!isAbsolute(paths[key])) throw new TypeError(`${key} must be absolute`);
  const repoRoot = realpathSync(paths.repoRoot);
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'plugins/activation.json'), 'utf8'));
  for (const id of OWNED) {
    const declared = manifest.plugins.find(plugin => plugin.id === id)?.module;
    if (declared !== RESILIENCE_MODULES[id]) throw new Error(`activation.json ${id} module differs from the profile migrator target`);
  }
  const YAML = loadYaml(repoRoot, paths.runtimeRoot, paths.dshHome);
  const checks = [await checkSdk(paths.runtimeRoot), ...checkArtifacts(repoRoot), ...checkProfiles({ repoRoot, dshHome: paths.dshHome }, YAML, manifest)];
  return { schema: 1, kind: 'recovery-doctor', ok: checks.every(check => check.ok), expected: { ...RESILIENCE_MODULES }, checks,
    warnings: checks.flatMap(check => (check.warnings ?? []).map(warning => `${check.id}: ${warning}`)),
    writes: 0, sessionsRead: false, credentialsRead: false, modelCalls: 0 };
}

const help = `Usage: node tools/resilience/doctor.mjs [--dsh-home ABS] [--runtime ABS] [--repo ABS]
Read-only. Checks the installed SDK agent/self-heal persistence bridge, the reviewed
owner/controller bundles, and that every managed profile points at the expected
contract-3 pair with native llm-retry disabled. Exit 0 when healthy, 1 otherwise.`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.includes('--help') || args.includes('-h')) { console.log(help); process.exit(0); }
    for (let i = 0; i < args.length; i += 2) {
      const key = { '--dsh-home': 'dshHome', '--runtime': 'runtimeRoot', '--repo': 'repoRoot' }[args[i]];
      if (!key || !args[i + 1] || Object.hasOwn(options, key)) throw new Error('Unknown, duplicate or missing doctor option');
      options[key] = resolve(args[i + 1]);
    }
    const report = await doctor(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
