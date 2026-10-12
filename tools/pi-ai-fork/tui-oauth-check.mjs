#!/usr/bin/env node
// The linked frontend peer route is intentionally different from runtime.mjs's
// profile adapter route. Only the official bootstrap may select its host peers.
// --baseline intentionally exits 1 when the old host sends implicit none.
// --offline tests three fake SSE streams; --preflight also compacts a fixture.
// --live --host-install-confirmed --offline-report <green-report.json> sends
// at most two requests. Never retry a failed paid run without owner approval.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, getEnvironmentData, setEnvironmentData, workerData } from 'node:worker_threads';
import { zstdDecompressSync } from 'node:zlib';
import { adapterName, officialRootDefault, piName, repo, sha256 } from './runtime.mjs';

const target = { provider: 'openai-codex', model: 'gpt-6.1-sol' };
const url = path => pathToFileURL(path).href;
const fail = code => Object.assign(new Error(code), { code });
const safeCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'TUI_OAUTH_CHECK_FAILED';
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const frontend = join(repo, 'frontend/dsh-tui/lib/types/dsh-adapter/oauth');

function simulatedSse() {
  const item = { id: 'msg_synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

// Never mount CredentialFile: even its device identity helper can write. A
// detached grant is sufficient for provider-native OAuth toAuth, with refresh
// rejected before invoking any mutation callback.
async function liveGrant() {
  const filename = join(home, 'dsh-auth/credentials.json');
  assert.equal((await stat(filename)).mode & 0o077, 0);
  const bytes = await readFile(filename);
  const grant = JSON.parse(bytes).providers?.[target.provider];
  if (grant?.type !== 'oauth' || !['access', 'refresh', 'accountId'].every(key => typeof grant[key] === 'string' && grant[key])) throw fail('CODEX_GRANT_REQUIRED');
  if (!Number.isFinite(grant.expires) || grant.expires <= Date.now() + 300_000) throw fail('CODEX_AUTH_EXPIRED');
  return { grant: structuredClone(grant), filename, hash: sha256(bytes) };
}

async function compactSynthetic(ctx, llm, load, report, dump) {
  const sessions = await load('@deepseek-ai/dsh-session');
  const compaction = await load('@deepseek-ai/dsh-compaction-basic');
  for (const id of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-token-meter', 'dsh-agent-loop']) {
    await ctx.plugin((await load(`@deepseek-ai/${id}`)).default, id === 'dsh-agent-loop' ? { agents: [], maxParallelToolCalls: 1 } : {});
  }
  await ctx.plugin(compaction.BasicCompactionEngine, { auto: false, maxTokens: 8192, compactionRetries: 0, maxOverflowRetries: 0, summarizationProvider: target.provider, summarizationModel: target.model });
  report.compactionClass = compaction.BasicCompactionEngine.name;
  const sessionId = sessions.SessionId(`tui-oauth-synthetic-${randomUUID()}`);
  const events = [];
  let flushes = 0;
  ctx.on('session/event', (session, event) => { if (session.id === sessionId) events.push(event); });
  ctx.on('session/flush', async session => {
    if (session.id !== sessionId) throw fail('NON_SYNTHETIC_SESSION_BLOCKED');
    const file = await open(join(dump, 'synthetic-session.json'), 'w', 0o600);
    try { await file.writeFile(JSON.stringify({ header: session.header, events })); await file.sync(); } finally { await file.close(); }
    const directory = await open(dump, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    flushes++;
  });
  const handle = await ctx.agents.create({ sessionId, agentOptions: { ...target, maxTokens: 8192 }, meta: { cwd: dump } });
  try {
    assert.equal(handle.agent.status, 'idle');
    const user = text => llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
    for (let i = 0; i < 12; i++) handle.agent.session.append('user/message', user(
      `Synthetic fixture ${i}. Objective: keep blue widget enabled. Decision: port 4321. Next: add a unit test.\n` +
      'Repeated synthetic progress: blue widget enabled, port 4321, unit test pending.\n'.repeat(160)), { surfaceOp: 'append' });
    const before = ctx.tokenMeter.measure(handle.agent.session).totalTokens;
    report.beforeTokens = before;
    assert.ok(before > 20_000);
    const probe = new llm.BlockAssembler();
    for await (const chunk of ctx.llm.stream({ ...target, messages: [user('Reply only OK. Synthetic integration probe.')], maxTokens: 4096, signal: AbortSignal.timeout(120_000) })) probe.push(chunk);
    if (probe.finish.kind !== 'stop') throw fail('SHORT_PROBE_FAILED');
    if (!probe.blocks().some(block => block.type === 'text' && block.text.trim())) throw fail('SHORT_PROBE_EMPTY');
    report.probePassed = true;
    const result = await ctx.compaction.compactNow(handle.agent, AbortSignal.timeout(120_000));
    assert.ok(result);
    assert.equal(handle.agent.status, 'idle');
    const after = ctx.tokenMeter.measure(handle.agent.session).totalTokens;
    const stored = JSON.parse(await readFile(join(dump, 'synthetic-session.json'), 'utf8'));
    assert.deepEqual(stored.events, events);
    assert.ok(stored.events.some(event => event.type === 'compaction/summary'));
    assert.equal(stored.events.filter(event => event.type === 'compaction/start').length, 1);
    assert.equal(stored.events.filter(event => event.type === 'compaction/end').length, 1);
    const restored = sessions.Session.create(sessionId, stored.events, stored.header, undefined, ctx.sessions.messageProjections);
    assert.deepEqual(restored.deriveMessages(), handle.agent.session.deriveMessages());
    assert.ok(restored.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text.includes('<compacted-summary>'))));
    assert.ok(after < before / 2);
    assert.ok(flushes > 0);
    assert.equal(report.networkCalls, report.live ? 2 : 0);
    Object.assign(report, { passed: true, compactNowPassed: true, afterTokens: after, flushes, durableReplayPassed: true });
  } finally { await handle.dispose(); }
}

async function workerRun(options) {
  const report = { schema: 1, live: !!options.live, passed: false, phase: options.baseline ? 'baseline' : 'verification', target, credentialMode: options.live ? 'detached-read-only-oauth-grant' : 'fake-jwt-read-only', refreshBlocked: true, requests: [], networkCalls: 0, credentialWrites: 0 };
  let ctx;
  let snapshot;
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  globalThis.fetch = async () => { throw fail('UNEXPECTED_NETWORK_BLOCKED'); };
  globalThis.WebSocket = class { constructor() { throw fail('WEBSOCKET_BLOCKED'); } };
  try {
    await import(options.bootstrap);
    const importer = join(frontend, 'index.js');
    const adapterURL = import.meta.resolve(adapterName, url(importer));
    const manifestURL = import.meta.resolve(`${adapterName}/package.json`, url(join(frontend, 'pi-ai.js')));
    const require = createRequire(manifestURL);
    const catalogPath = require.resolve.paths(piName).map(root => join(root, piName, 'dist/providers/all.js')).find(existsSync);
    assert.ok(catalogPath);
    const catalogURL = url(catalogPath);
    const piRoot = dirname(dirname(dirname(catalogPath)));
    const piManifest = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8'));
    const providerURL = url(join(piRoot, 'dist/providers/openai-codex.js'));
    const lazyURL = url(join(piRoot, 'dist/api/openai-codex-responses.lazy.js'));
    const implementationURL = url(join(piRoot, 'dist/api/openai-codex-responses.js'));
    const source = await readFile(fileURLToPath(implementationURL), 'utf8');
    const load = id => import(import.meta.resolve(id, manifestURL));
    const [{ CredentialGatedAdapter }, profiles, tuiPi, hostAdapter, catalog, { Context }, llm] = await Promise.all([
      import(url(importer)), import(url(join(frontend, 'profiles.js'))), import(url(join(frontend, 'pi-ai.js'))),
      import(adapterURL), import(catalogURL), load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'),
    ]);
    assert.strictEqual(Object.getPrototypeOf(CredentialGatedAdapter), hostAdapter.PiAiAdapter);
    assert.strictEqual(tuiPi.adapterBuiltinProviders, catalog.builtinProviders);
    const adapterProviderURL = import.meta.resolve(`${piName}/providers/openai-codex`, adapterURL);
    assert.equal(await realpath(fileURLToPath(adapterProviderURL)), await realpath(fileURLToPath(providerURL)));
    const frontendCordis = await import(import.meta.resolve('@deepseek-ai/cordis', url(importer)));
    const frontendLlm = await import(import.meta.resolve('@deepseek-ai/dsh-llm', url(importer)));
    assert.strictEqual(frontendCordis.Context, Context);
    assert.strictEqual(frontendLlm, llm);
    assert.equal(await realpath(fileURLToPath(adapterURL)), await realpath(join(options.officialRoot, adapterName, 'lib/index.js')));
    const profile = profiles.buildOAuthProfile(target.provider);
    assert.ok(profile.piProvider.getModels().some(model => model.id === target.model), 'Actual host catalogue lacks target');
    assert.equal(profile.piProvider.id, target.provider);
    const providerSource = await readFile(fileURLToPath(providerURL), 'utf8');
    const lazySource = await readFile(fileURLToPath(lazyURL), 'utf8');
    assert.ok(providerSource.includes('../api/openai-codex-responses.lazy.js'));
    assert.ok(lazySource.includes('./openai-codex-responses.js'));
    report.resolution = { importer: url(importer), profiles: url(join(frontend, 'profiles.js')), piAi: url(join(frontend, 'pi-ai.js')), adapterURL, manifestURL, catalogURL, providerURL, lazyURL, implementationURL,
      className: CredentialGatedAdapter.name, baseClass: hostAdapter.PiAiAdapter.name, baseClassHostIdentity: true, catalogueFunctionIdentity: true, adapterProviderURL, cordisHostIdentity: true, llmHostIdentity: true,
      piVersion: piManifest.version, streamSourceSha256: sha256(source), providerStreamSource: profile.piProvider.streamSimple.toString(), patchedStreamSource: !source.includes('body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" }') };
    snapshot = options.live ? await liveGrant() : undefined;
    const access = snapshot?.grant.access ?? `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-offline-proof' } })).toString('base64url')}.test`;
    const grant = snapshot?.grant ?? { type: 'oauth', access, refresh: 'synthetic-never-refresh', accountId: 'synthetic-offline-proof', expires: Date.now() + 3_600_000 };
    const credentials = {
      async read(id) { report.credentialReads = (report.credentialReads ?? 0) + 1; return id === target.provider ? structuredClone(grant) : undefined; },
      async list() { return [{ providerId: target.provider, type: 'oauth' }]; },
      async modify() { report.credentialWrites++; throw fail('CREDENTIALS_READ_ONLY'); },
      async delete() { report.credentialWrites++; throw fail('CREDENTIALS_READ_ONLY'); },
    };
    const authContext = { async env() { return undefined; }, async fileExists() { return false; } };
    Object.assign(profile, { transport: 'sse', timeoutMs: options.live ? 120_000 : 15_000, streamIdleTimeoutMs: options.live ? 120_000 : 15_000, retryPolicy: llm.resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'tui-oauth-check') });
    const profilesMap = new Map([[target.provider, profile]]);
    const adapter = new CredentialGatedAdapter({ profiles: () => profilesMap, resolveApiKey: async () => undefined, auth: { credentials, authContext } }, async id => !!await credentials.read(id));
    assert.ok(adapter instanceof hostAdapter.PiAiAdapter);
    ctx = new Context();
    await ctx.plugin(llm.default);
    ctx.llm.registerAdapter([target.provider], adapter);
    assert.ok((await adapter.listModels(target.provider)).some(model => model.id === target.model));
    const hidden = new CredentialGatedAdapter({ profiles: () => profilesMap, resolveApiKey: async () => undefined, auth: { credentials, authContext } }, async () => false);
    assert.deepEqual(await hidden.listModels(target.provider), []);
    await hidden.resolveModel(target.provider, target.model, AbortSignal.timeout(15_000));
    await ctx.llm.resolveModelInfo(target.provider, target.model, AbortSignal.timeout(15_000));
    globalThis.WebSocket = class { constructor() { throw fail('WEBSOCKET_BLOCKED'); } };
    let currentEffort;
    globalThis.fetch = async (input, init) => {
      const endpoint = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (endpoint.origin !== 'https://chatgpt.com' || endpoint.pathname !== '/backend-api/codex/responses' || (options.live && report.networkCalls >= 2)) throw fail('UNEXPECTED_NETWORK_BLOCKED');
      const headers = new Headers(init.headers);
      assert.equal(headers.get('authorization'), `Bearer ${access}`);
      const compressed = headers.get('content-encoding') === 'zstd';
      const body = compressed ? zstdDecompressSync(init.body) : init.body;
      const payload = JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
      assert.equal(payload.model, target.model);
      assert.equal(payload.stream, true);
      report.requests.push({ requestedEffort: currentEffort ?? 'absent', wireEffort: payload.reasoning?.effort ?? 'absent', compressed, endpoint: endpoint.origin + endpoint.pathname });
      if (options.live) {
        if (payload.reasoning?.effort !== undefined) throw fail('LIVE_IMPLICIT_EFFORT_BLOCKED');
        // Count before sending: a transport failure still consumes the budget.
        report.networkCalls++;
        return originalFetch(input, init);
      }
      // Return even the invalid payload as successful SSE so the baseline failure
      // is specifically our wire-contract assertion, not a fake server failure.
      return simulatedSse();
    };
    if (options.live) {
      assert.match(piManifest.version, /^0\.87\.1\+alex\.codex-default\./);
      assert.equal(report.resolution.implementationURL, options.offlineResolution.implementationURL);
      assert.equal(report.resolution.streamSourceSha256, options.offlineResolution.streamSourceSha256);
      await compactSynthetic(ctx, llm, load, report, options.dump);
      assert.equal(report.credentialWrites, 0);
      return report;
    }
    for (const effort of [undefined, 'low', 'medium']) {
      currentEffort = effort;
      const assembler = new llm.BlockAssembler();
      const options = { ...target, maxTokens: 4096, signal: AbortSignal.timeout(15_000), messages: [llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic OAuth route probe. Reply OK.' }] })] };
      if (effort !== undefined) options.reasoningEffort = llm.ReasoningEffortId(effort);
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
      assert.equal(assembler.finish.kind, 'stop');
      assert.ok(assembler.blocks().some(block => block.type === 'text' && block.text === 'OK'));
    }
    assert.equal(report.requests.length, 3);
    assert.equal(report.credentialWrites, 0);
    assert.ok(report.credentialReads > 0);
    assert.equal(report.requests[1].wireEffort, 'low');
    assert.equal(report.requests[2].wireEffort, 'medium');
    report.regression = { absentEffortOmitted: report.requests[0].wireEffort === 'absent', explicitLowPreserved: true, explicitMediumPreserved: true, simulatedSseFinal: true };
    if (options.baseline) {
      if (report.requests[0].wireEffort !== 'none') throw fail('BASELINE_DID_NOT_REPRODUCE_NONE');
      report.baselineReproduced = true;
      report.code = 'IMPLICIT_NONE_REPRODUCED';
    } else {
      if (report.requests[0].wireEffort !== 'absent') throw fail('IMPLICIT_EFFORT_NOT_OMITTED');
      assert.match(piManifest.version, /^0\.87\.1\+alex\.codex-default\./);
      report.passed = true;
      if (options.preflight) {
        currentEffort = undefined;
        report.passed = false;
        await compactSynthetic(ctx, llm, load, report, options.dump);
        report.preflight = true;
      }
    }
  } catch (error) {
    report.passed = false;
    report.code = safeCode(error);
    // Assertion values and provider error strings can contain credential data.
    if (error?.code === 'ERR_ASSERTION') report.assertionFailed = true;
  }
  finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    await ctx?.fiber.dispose();
    if (snapshot) {
      report.credentialSnapshotUnchanged = sha256(await readFile(snapshot.filename)) === snapshot.hash;
      if (!report.credentialSnapshotUnchanged) { report.passed = false; report.code = 'CREDENTIAL_SNAPSHOT_CHANGED'; }
    }
  }
  return report;
}

export async function runTuiOAuthCheck({ officialRoot = officialRootDefault, profileDir = join(home, 'profiles/dsh-tui'), baseline = false, live = false, preflight = false, hostInstallConfirmed = false, offlineReport } = {}) {
  if (live && (!hostInstallConfirmed || !offlineReport || baseline)) throw fail('LIVE_REQUIRES_HOST_CONFIRMATION_AND_OFFLINE_GREEN');
  let offlineResolution;
  if (live) {
    const filename = await realpath(offlineReport);
    assert.ok(filename.startsWith(`${join(repo, '.dumps/pi-ai-fork/tui-oauth-offline')}/`));
    const proof = JSON.parse(await readFile(filename, 'utf8'));
    assert.equal(proof.passed, true);
    assert.equal(proof.live, false);
    assert.equal(proof.regression.absentEffortOmitted, true);
    offlineResolution = proof.resolution;
  }
  const dump = join(repo, `.dumps/pi-ai-fork/tui-oauth-${live ? 'live' : 'offline'}`, `${baseline ? 'baseline' : 'verification'}-${randomUUID()}`);
  await mkdir(dump, { recursive: true, mode: 0o700 });
  const root = await realpath(officialRoot);
  const profile = await realpath(profileDir);
  const anchor = join(root, '@deepseek-ai/dsh/package.json');
  const require = createRequire(anchor);
  const boot = await import(url(require.resolve('@deepseek-ai/dsh-app-boot')));
  const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile: { dir: profile, layers: [], skippedBundles: [] }, home });
  assert.ok(resolution.linkedRoots.some(root => root.name === '@deepseek-harness-tui/dsh-tui' && root.realPath === join(repo, 'frontend/dsh-tui')), 'Actual profile must link the real frontend');
  const bootstrap = url(require.resolve('@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap'));
  const key = '@deepseek-ai/dsh-app-boot/profile-resolution';
  const previous = getEnvironmentData(key);
  let worker;
  try {
    setEnvironmentData(key, { resolution });
    worker = new Worker(new URL(import.meta.url), { workerData: { officialRoot: root, profileDir: profile, bootstrap, baseline, live, preflight, dump, offlineResolution }, execArgv: ['--experimental-import-meta-resolve'] });
  } finally { setEnvironmentData(key, previous); }
  const report = await new Promise((accept, reject) => {
    let result;
    worker.on('message', message => { result = message; });
    worker.on('error', () => reject(fail('WORKER_FAILED')));
    worker.on('exit', code => code === 0 && result ? accept(result) : reject(fail('WORKER_EXIT_FAILED')));
  }).catch(error => ({ schema: 1, live, passed: false, code: safeCode(error) }));
  report.runtime = { officialRoot: root, profileDir: profile, bootstrap, workerFresh: true, linkedRoots: resolution.linkedRoots, pid: process.pid };
  report.reportPath = join(dump, 'report.json');
  await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (!isMainThread) parentPort.postMessage(await workerRun(workerData));
else if (process.argv[1] && url(resolve(process.argv[1])) === import.meta.url) {
  try {
    const flagValue = name => process.argv[process.argv.indexOf(name) + 1];
    const report = await runTuiOAuthCheck({ baseline: process.argv.includes('--baseline'), live: process.argv.includes('--live'), preflight: process.argv.includes('--preflight'), hostInstallConfirmed: process.argv.includes('--host-install-confirmed'), offlineReport: process.argv.includes('--offline-report') ? flagValue('--offline-report') : undefined });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) { console.log(JSON.stringify({ passed: false, code: safeCode(error) })); process.exitCode = 1; }
}
