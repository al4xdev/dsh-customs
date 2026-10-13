import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareRoot, readKey, privateStat, validId } from './bridge-security.mjs';

export const EXCLUDED_RUNNERS = new Set(['@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-headless/startup']);
const MAX_LOG_EVENTS = 20_000;
export function canonical(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export const hashValue = value => createHash('sha256').update(canonical(value)).digest('hex');
export function signPayload(payload, key) { return { payload, mac: createHmac('sha256', key).update(canonical(payload)).digest('hex') }; }
export function verifyPayload(signed, key) {
  if (!signed?.payload || !/^[a-f0-9]{64}$/.test(signed.mac ?? '')) return false;
  return timingSafeEqual(Buffer.from(signed.mac, 'hex'), Buffer.from(signPayload(signed.payload, key).mac, 'hex'));
}
export async function atomicPrivate(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(tmp, file);
}
export async function privateDirectory(root, child) {
  const dir = path.join(root, child);
  await fs.mkdir(dir, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await privateStat(dir, 'dir', 0o700);
  return dir;
}
export async function readPrivateJson(file) {
  await privateStat(file, 'file', 0o600);
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (stat.size > 1024 * 1024 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw new Error('Unsafe private document');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
export async function runtimeModules(installAnchor) {
  const require = createRequire(installAnchor);
  return { boot: await import(require.resolve('@deepseek-ai/dsh-app-boot')), scope: await import(require.resolve('@deepseek-ai/dsh-scope')), agents: await import(require.resolve('@deepseek-ai/dsh-agent')) };
}
export async function profileFingerprint(origin) {
  if (!origin || !validId(origin.name) || origin.name === 'companion' || !['dir', 'patchPath', 'installAnchor', 'home'].every(key => typeof origin[key] === 'string' && path.isAbsolute(origin[key]))) throw new Error('Original profile context unavailable');
  if (!Array.isArray(origin.overlays) || origin.overlays.length !== 0 || !Array.isArray(origin.startedBundles)) throw new Error('Original overlay and bundle metadata are not admitted or proven');
  const { boot } = await runtimeModules(origin.installAnchor);
  const dir = await fs.realpath(origin.dir), installAnchor = await fs.realpath(origin.installAnchor), home = await fs.realpath(origin.home);
  if (dir !== path.join(home, 'profiles', origin.name) || path.resolve(origin.patchPath) !== path.join(origin.dir, 'cordis.patch.yml')) throw new Error('Profile root identity changed');
  const profile = boot.loadProfileDirectory('session-resume', dir, installAnchor);
  if (profile.skippedBundles.length || profile.layers.some(layer => /tui|web|acp|sdk|schedule|team/i.test(layer.packageName))) throw new Error('Only proven noninteractive headless composition is admitted');
  if (canonical(profile.layers.map(layer => layer.packageName)) !== canonical(origin.startedBundles)) throw new Error('Profile bundle order changed');
  const files = [installAnchor, path.join(dir, 'package.json'), path.join(dir, 'cordis.yml'), path.join(dir, 'cordis.patch.yml'), path.join(home, 'cordis.patch.yml'), path.join(home, 'profile-compatibility.json')];
  for (const layer of profile.layers) files.push(path.join(layer.packageDir, 'package.json'), ...layer.patchPaths);
  const hashes = [];
  for (const file of [...new Set(files)]) {
    try { hashes.push({ path: file, realpath: await fs.realpath(file), hash: createHash('sha256').update(await fs.readFile(file)).digest('hex') }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; hashes.push({ path: file, absent: true }); }
  }
  const current = { name: origin.name, dir, patchPath: path.join(dir, 'cordis.patch.yml'), installAnchor, home, cwd: origin.cwd, startedBundles: profile.layers.map(layer => layer.packageName), overlays: [], telemetryDisabledEnv: origin.telemetryDisabledEnv ? '1' : undefined };
  return { origin: current, files: hashes, fingerprint: hashValue({ current, hashes }) };
}
export function rootComposition(ctx) {
  if (!ctx.loader?.entries) throw new Error('Public Loader composition unavailable');
  const entries = [...ctx.loader.entries()];
  const active = entries.filter(entry => !entry.disabled && !entry.options?.group && entry.options?.name !== 'cordis:include');
  if (active.some(entry => /tui|web-app|api-session|schedule|sdk|acp|agent-team/.test(entry.options.name ?? '') && !String(entry.options.name).endsWith('/dsh-adapter/oauth/index.js'))) throw new Error('Interactive or autonomous composition not admitted');
  const loop = active.find(entry => entry.options.name === '@deepseek-ai/dsh-agent-loop');
  const configured = loop?.fiber?.config?.agents;
  // The factory must exist with an explicitly empty declarative agent list.
  if (!Array.isArray(configured) || configured.length) throw new Error('Declarative agent startup is not proven empty');
  const resolveModule = specifier => {
    if (specifier.startsWith('file:')) return fileURLToPath(specifier);
    if (path.isAbsolute(specifier)) return specifier;
    for (const anchor of [path.join(ctx.profileContext.dir, 'package.json'), ctx.profileContext.installAnchor]) {
      try { return createRequire(anchor).resolve(specifier); } catch {}
    }
    throw new Error('Current plugin module cannot be fingerprinted');
  };
  const rows = active.filter(entry => !EXCLUDED_RUNNERS.has(entry.options.name) && entry.options.name !== import.meta.url && !String(entry.options.name).endsWith('/resume-worker.mjs'))
    .map(entry => {
      const modulePath = realpathSync(resolveModule(entry.options.name));
      return { id: entry.id, name: entry.options.name, configHash: hashValue(entry.options.config), modulePath, moduleHash: createHash('sha256').update(readFileSync(modulePath)).digest('hex'), isolate: entry.options.isolate, intercept: entry.options.intercept };
    });
  return { rows, hash: hashValue(rows), excluded: active.filter(entry => EXCLUDED_RUNNERS.has(entry.options.name)).map(entry => ({ id: entry.id, name: entry.options.name })) };
}
export async function persistedSnapshot(ctx, sessionId, signal) {
  signal?.throwIfAborted();
  const before = await ctx.sessionPersistence.stat(sessionId, { signal });
  if (!before) throw new Error('Session not found');
  const handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal });
  const read = { events: [] };
  let bytes = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const page = await handle.read(read.events.length, 128, { signal });
      for (const event of page.events) {
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (bytes > 8 * 1024 * 1024 || read.events.length >= MAX_LOG_EVENTS) throw new Error('Session exceeds provenance read budget');
        read.events.push(event);
      }
      if (page.events.length < 128) break;
    }
  } finally { await handle.close(); }
  const after = await ctx.sessionPersistence.stat(sessionId, { signal });
  if (before.revision !== after?.revision) throw new Error('Session changed during provenance read');
  return { header: before.header, revision: before.revision, events: read.events, eventCount: read.events.length, eventHash: hashValue(read.events), headerHash: hashValue(before.header) };
}
export function foldExecution(header, events) {
  let preset = header.agentPreset ?? null, model, sandbox, approval;
  let openTurn = false;
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'agent-preset/selected') preset = data.agentPreset;
    if (event.type === 'request/header') {
      const config = data.config ?? data.header?.config;
      if (config?.provider && config?.model) model = { provider: config.provider, model: config.model, ...(config.reasoningEffort === undefined || (data.header ?? data).adapterDefaults?.reasoningEffort === true ? {} : { reasoningEffort: config.reasoningEffort }) };
    }
    if (event.type === 'model/selection') model = { provider: data.provider, model: data.model, ...(data.reasoningEffort === undefined ? {} : { reasoningEffort: data.reasoningEffort }) };
    if (event.type === 'sandbox/mode') sandbox = data.mode;
    if (event.type === 'approval/policy') approval = data.policy;
    if (event.type === 'turn/start') openTurn = true;
    if (event.type === 'turn/end') openTurn = false;
  }
  if (preset !== null && (typeof preset !== 'string' || !preset)) throw new Error('Recorded preset invalid');
  return { preset, model, sandbox, approval, openTurn };
}
export async function executionProof(ctx, agent, snapshot) {
  const fold = foldExecution(snapshot.header, snapshot.events);
  if (!fold.model?.provider || !fold.model?.model) throw new Error('No durable model route');
  if (!ctx.sessionProjections?.stateOf) throw new Error('Session projections unavailable');
  const inbox = ctx.sessionProjections.stateOf(agent.session, 'inbox');
  if (!inbox || Object.values(inbox).some(value => Array.isArray(value) && value.length)) throw new Error('Pending inbox or inbox proof unavailable');
  if (fold.openTurn) throw new Error('Unsettled turn');
  const jobs = agent.ctx.get('jobs') ?? ctx.get?.('jobs');
  if (typeof jobs?.list !== 'function' || jobs.list(agent.id).some(job => job.status === 'running' || job.status === 'stopping')) throw new Error('Pending background work or job owner unavailable');
  const goalState = ctx.sessionProjections.stateOf(agent.session, 'goal');
  if (!goalState || goalState.failure !== null) throw new Error('Durable goal state unavailable');
  const sandbox = agent.ctx.get('sandboxPolicy') ?? ctx.get?.('sandboxPolicy');
  const approval = agent.ctx.get('approval') ?? ctx.get?.('approval');
  const policies = { sandbox: sandbox?.resolve?.({ session: agent.session }).mode, approval: approval?.effectivePolicy?.(agent.session) };
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(policies.sandbox) || !['ask', 'never'].includes(policies.approval)) throw new Error('Policy owners unavailable');
  const { scope } = await runtimeModules(ctx.profileContext.installAnchor);
  if (!ctx.tools?.schemas) throw new Error('Scoped tools unavailable');
  const key = scope.scopeOf(agent.ctx);
  if (!key) throw new Error('Agent scope unavailable');
  const schemas = ctx.tools.schemas(key);
  if (schemas.some(tool => tool.name === 'run_code')) throw new Error('Initial resume support requires a proven native tool presentation');
  const catalogHash = hashValue(schemas);
  let presetHash = null;
  if (fold.preset !== null) {
    if (ctx.agentPresets?.composedPreset(agent.ctx) !== fold.preset) throw new Error('Live preset disagrees with durable fold');
    const resolved = await ctx.agentPresets.resolve(fold.preset);
    if (resolved.broken) throw new Error('Recorded preset is broken');
    presetHash = hashValue((await ctx.agentPresets.readDocument(fold.preset)).content);
  } else if (ctx.get?.('agentPresets')) throw new Error('Presetless session in roster profile is not admitted');
  return { preset: fold.preset, model: fold.model, policies, catalogHash, presetHash, goalHash: hashValue(goalState), pendingWork: false };
}
export async function captureProvenance(ctx, agent, options = {}) {
  if (agent.status !== 'idle' || ctx.agents.get(agent.id) !== agent || !ctx.agents.list().includes(agent) || !agent.runMaintenance || !ctx.sessions?.flush || !ctx.profileContext) return { ok: false, reason: 'Idle public agent/profile/flush proof unavailable' };
  try {
    return await agent.runMaintenance(async signal => {
      const config = await profileFingerprint(ctx.profileContext);
      const root = rootComposition(ctx);
      await ctx.sessions.flush(agent.session);
      const snapshot = await persistedSnapshot(ctx, agent.id, signal);
      const execution = await executionProof(ctx, agent, snapshot);
      const cwd = snapshot.header.cwd;
      if (!cwd || !path.isAbsolute(cwd) || await fs.realpath(cwd) !== cwd) throw new Error('Original cwd must be absolute canonical directory');
      if (snapshot.header.parentSession || snapshot.header.isSeeded || (snapshot.header.delegationDepth ?? 0) > 0) throw new Error('Child and fork sessions are not admitted');
      const prepared = await prepareRoot(options.root);
      const directory = await privateDirectory(prepared.root, 'provenance');
      const payload = { version: 1, kind: 'session-provenance', sessionId: agent.id, capturedAt: Date.now(), cwd, origin: config.origin, configFingerprint: config.fingerprint, files: config.files, rootComposition: root, execution, log: { revision: snapshot.revision, eventCount: snapshot.eventCount, eventHash: snapshot.eventHash, headerHash: snapshot.headerHash }, bridgeIdentity: options.bridgeIdentity };
      await atomicPrivate(path.join(directory, `${agent.id}.json`), signPayload(payload, prepared.key));
      return { ok: true, sessionId: agent.id, fingerprint: config.fingerprint };
    });
  } catch (error) { return { ok: false, reason: error.message }; }
}
export async function readProvenance(root, sessionId) {
  if (!validId(sessionId)) throw new Error('Invalid session ID');
  const key = await readKey(root);
  await privateStat(path.join(root, 'provenance'), 'dir', 0o700);
  const signed = await readPrivateJson(path.join(root, 'provenance', `${sessionId}.json`));
  if (!verifyPayload(signed, key) || signed.payload.version !== 1 || signed.payload.kind !== 'session-provenance' || signed.payload.sessionId !== sessionId) throw new Error('Provenance signature or destination invalid');
  return signed.payload;
}
