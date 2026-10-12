#!/usr/bin/env node
// Offline only. Each case gets a fresh officially bootstrapped Worker and the
// real linked OAuth adapter, loop, session, tool scheduler and bounded retry.
// --allow-unconfigured-profile is an explicit pre-install diagnostic; final
// acceptance omits it and requires the plugin row in the composed user profile.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData, getEnvironmentData, setEnvironmentData } from 'node:worker_threads';
import { zstdDecompressSync } from 'node:zlib';
import { adapterName, officialRootDefault, piName, repo, sha256 } from './runtime.mjs';

const target = { provider: 'openai-codex', model: 'gpt-6.1-sol' };
const toolName = 'resilience_effect_spy';
const pluginPath = join(repo, 'plugins/codex-transient-close/index.mjs');
const frontend = join(repo, 'frontend/dsh-tui/lib/types/dsh-adapter/oauth');
const url = filename => pathToFileURL(filename).href;
const fail = code => Object.assign(new Error(code), { code });
const safeCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'RESILIENCE_CHECK_FAILED';

export function parseResilienceArgs(args) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    'official-root': { type: 'string' }, 'profile-dir': { type: 'string' }, 'expected-version': { type: 'string' },
    'allow-unconfigured-profile': { type: 'boolean' }, summary: { type: 'boolean' },
  } });
  const version = values['expected-version'];
  if (version !== undefined && /^0\.87\.1\+alex\.codex-default\.[a-f0-9]{12}$/.exec(version)?.[0] !== version) throw fail('EXPECTED_VERSION_INVALID');
  return { officialRoot: values['official-root'], profileDir: values['profile-dir'], expectedVersion: version,
    explicitOfficialRoot: Object.hasOwn(values, 'official-root'),
    allowUnconfiguredProfile: values['allow-unconfigured-profile'] ?? false, summary: values.summary ?? false };
}

export function decideHelperReanchoring(matchesHost, explicitOfficialRoot = false) {
  if (matchesHost) return false;
  if (explicitOfficialRoot !== true) throw fail('HELPER_HOST_MISMATCH');
  return true;
}

export function assertSnapshotUnchanged(before, after) {
  if (!isDeepStrictEqual(before, after)) throw fail('SNAPSHOT_CHANGED');
}

function flatten(entries, output = []) {
  for (const entry of entries) {
    if (entry.disabled) continue;
    output.push(entry);
    if (Array.isArray(entry.config?.plugins)) flatten(entry.config.plugins, output);
  }
  return output;
}

function toolEvents(id, value, complete) {
  const item = { type: 'function_call', id: `item_${id}`, call_id: id, name: toolName, arguments: '' };
  const argumentsText = JSON.stringify({ value });
  return [
    { type: 'response.output_item.added', output_index: 1, item },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: item.id, delta: complete ? argumentsText : argumentsText.slice(0, -2) },
    ...(complete ? [{ type: 'response.output_item.done', output_index: 1, item: { ...item, arguments: argumentsText, status: 'completed' } }] : []),
  ];
}

function successfulEvents(ordinal) {
  if (ordinal === 2) return [
    ...toolEvents('successful_call', 'successful-fixture', true),
    { type: 'response.completed', response: { id: 'successful_response', status: 'completed', usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } } },
  ];
  const item = { type: 'message', id: 'final_message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Finished fixture', annotations: [] }] };
  return [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'Finished fixture' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'final_response', status: 'completed', usage: { input_tokens: 15, output_tokens: 2, total_tokens: 17 } } },
  ];
}

async function runCase(options) {
  const report = { schema: 1, passed: false, phase: 'bootstrap', case: options.case, target, networkCalls: 0, networkAttemptsBlocked: 0,
    credentialMode: 'detached-fake-oauth-only', credentialWrites: 0, credentialReads: 0, requests: [] };
  let ctx;
  let handle;
  let piApi;
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const blockNetwork = () => { report.networkAttemptsBlocked++; throw fail('NETWORK_FORBIDDEN'); };
  globalThis.fetch = blockNetwork;
  globalThis.WebSocket = class { constructor() { blockNetwork(); } };
  try {
    await import(options.bootstrap);
    const originalWorkerArgv1 = process.argv[1];
    let helperResolutionBefore;
    for (const base of [originalWorkerArgv1, '/home/alex/.local/share/dsh-cli/package.json']) {
      try { helperResolutionBefore = createRequire(base).resolve('@deepseek-ai/dsh-llm'); break; } catch {}
    }
    // Keep the real argv under the principal host. An explicit alternate host
    // simulates that launcher's anchor and reports the reanchoring, never hiding it.
    const helperMatchesHost = !!helperResolutionBefore &&
      await realpath(helperResolutionBefore) === await realpath(join(options.officialRoot, '@deepseek-ai/dsh-llm/lib/index.js'));
    const helperNeedsHostAnchor = decideHelperReanchoring(helperMatchesHost, options.explicitOfficialRoot);
    if (helperNeedsHostAnchor) process.argv[1] = options.anchor;
    const importer = join(frontend, 'index.js');
    const adapterURL = import.meta.resolve(adapterName, url(importer));
    const manifestURL = import.meta.resolve(`${adapterName}/package.json`, url(join(frontend, 'pi-ai.js')));
    const hostRequire = createRequire(manifestURL);
    const catalogPath = hostRequire.resolve.paths(piName).map(root => join(root, piName, 'dist/providers/all.js')).find(existsSync);
    assert.ok(catalogPath);
    const piRoot = dirname(dirname(dirname(catalogPath)));
    const piManifest = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8'));
    const implementation = join(piRoot, 'dist/api/openai-codex-responses.js');
    const load = name => import(import.meta.resolve(name, manifestURL));
    const [{ CredentialGatedAdapter }, profiles, tuiPi, hostAdapter, catalog, { Context }, llm, common, plugin] = await Promise.all([
      import(url(importer)), import(url(join(frontend, 'profiles.js'))), import(url(join(frontend, 'pi-ai.js'))),
      import(adapterURL), import(url(catalogPath)), load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'),
      import(url(join(repo, 'plugins/common.mjs'))), import(url(options.pluginPath)),
    ]);
    assert.strictEqual(Object.getPrototypeOf(CredentialGatedAdapter), hostAdapter.PiAiAdapter);
    assert.strictEqual(tuiPi.adapterBuiltinProviders, catalog.builtinProviders);
    assert.strictEqual(await import(common.resolveHost('@deepseek-ai/dsh-llm')), llm);
    assert.strictEqual((await import(import.meta.resolve('@deepseek-ai/cordis', url(importer)))).Context, Context);
    assert.strictEqual(await import(import.meta.resolve('@deepseek-ai/dsh-llm', url(importer))), llm);
    assert.equal(await realpath(fileURLToPath(adapterURL)), await realpath(join(options.officialRoot, adapterName, 'lib/index.js')));
    assert.equal(await realpath(fileURLToPath(import.meta.resolve(`${piName}/providers/openai-codex`, adapterURL))), await realpath(join(piRoot, 'dist/providers/openai-codex.js')));
    if (options.expectedVersion) assert.equal(piManifest.version, options.expectedVersion);
    report.resolution = { adapterURL, piRoot, piVersion: piManifest.version, streamSha256: sha256(await readFile(implementation)),
      credentialGatedSubclassHostIdentity: true, catalogueHostIdentity: true, frontendCordisHostIdentity: true,
      frontendLlmHostIdentity: true, pluginHostLlmIdentity: true, helperHostLlmURL: url(common.resolveHost('@deepseek-ai/dsh-llm')),
      workerLaunchAnchor: options.anchor, originalWorkerArgv1, effectiveWorkerArgv1: process.argv[1],
      helperResolutionBefore: helperResolutionBefore ? url(helperResolutionBefore) : null, argvReanchored: helperNeedsHostAnchor,
      pluginURL: url(options.pluginPath), pluginSourceSha256: sha256(await readFile(options.pluginPath)) };
    assertSnapshotUnchanged(options.pluginSourceSha256, report.resolution.pluginSourceSha256);
    piApi = await import(url(implementation));
    const access = `offline.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'resilience-fixture-only' } })).toString('base64url')}.offline`;
    const grant = { type: 'oauth', access, refresh: 'never-refresh-fixture', accountId: 'resilience-fixture-only', expires: Date.now() + 3_600_000 };
    const credentials = {
      async read(id) { report.credentialReads++; return id === target.provider ? structuredClone(grant) : undefined; },
      async list() { return [{ providerId: target.provider, type: 'oauth' }]; },
      async modify() { report.credentialWrites++; throw fail('CREDENTIAL_WRITE_FORBIDDEN'); },
      async delete() { report.credentialWrites++; throw fail('CREDENTIAL_WRITE_FORBIDDEN'); },
    };
    const profile = profiles.buildOAuthProfile(target.provider);
    assert.ok(profile.piProvider.getModels().some(model => model.id === target.model));
    // Preserve the OAuth provider's actual normal retry policy and default five
    // retries. No fixture override to zero, always-mode or private retry loop.
    Object.assign(profile, { transport: 'auto', timeoutMs: 5000 });
    const profilesMap = new Map([[target.provider, profile]]);
    const adapter = new CredentialGatedAdapter({ profiles: () => profilesMap, resolveApiKey: async () => undefined,
      auth: { credentials, authContext: { async env() { return undefined; }, async fileExists() { return false; } } } }, async id => !!await credentials.read(id));
    ctx = new Context();
    await ctx.plugin(llm.default);
    ctx.llm.registerAdapter([target.provider], adapter);
    const policy = ctx.llm.providerRetryPolicy(target.provider);
    assert.equal(policy.mode, 'normal');
    assert.equal(policy.maxRetries, 5);
    assert.ok(policy.retryableCodes.includes('TRANSPORT'));
    assert.ok(!policy.retryableCodes.includes('PI_AI_ERROR'));
    report.retryPolicy = { mode: policy.mode, maxRetries: policy.maxRetries, initialDelayMs: policy.initialDelayMs, maxDelayMs: policy.maxDelayMs, jitterRatio: policy.jitterRatio };
    for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop']) {
      await ctx.plugin((await load(`@deepseek-ai/${name}`)).default, name === 'dsh-agent-loop' ? { agents: [], maxParallelToolCalls: 1 } : {});
    }
    const { defineTool } = await load('@deepseek-ai/dsh-tools');
    const events = [], errors = [], attempts = [], atFailure = [], atBackoff = [], durableInputs = [], marked = [];
    let toolEffects = 0;
    const sessionId = `offline-resilience-${randomUUID()}`;
    ctx.tools.register(defineTool({ name: toolName, description: 'Offline fixture counter; no filesystem or network effects.',
      parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute(args) { assert.equal(args.value, 'successful-fixture'); toolEffects++; return 'Offline tool completed once'; },
    }));
    ctx.systemPrompt.tools(context => ({ schemas: ctx.tools.schemas(context.scope) }));
    ctx.on('session/event', (session, event) => { if (session.id === sessionId) { events.push(event); if (event.type === 'llm/retry') atBackoff.push(toolEffects); } });
    ctx.on('agent/error', payload => errors.push({ code: payload.error.code ?? null, name: payload.error.name,
      where: payload.error.stack?.split('\n').find(line => line.trim().startsWith('at '))?.trim() ?? null }));
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'start') attempts.push({ attemptId: frame.attemptId, turn: frame.turn, step: frame.step }); });
    ctx.on('agent/request-error', (payload, next) => { atFailure.push({ code: payload.failure.code, toolEffects, retryMax: payload.retryPolicy?.maxRetries }); return next(); }, { prepend: true });
    ctx.on('llm/stream', (preparedOptions, next) => {
      const pluginMarker = llm.isAgentLoopRequest(preparedOptions);
      assert.ok(pluginMarker && Object.isFrozen(preparedOptions));
      marked.push(pluginMarker);
      durableInputs.push(sha256(JSON.stringify(preparedOptions.messages)));
      return next();
    }, { prepend: true });
    await ctx.plugin(await load('@deepseek-ai/dsh-llm-retry'));
    if (options.case.enabled) await ctx.plugin(plugin, options.pluginConfig ?? {});
    report.pluginMountedFromComposedRow = !!options.composedPlugin && options.case.enabled;
    let ordinal = 0;
    const sockets = [];
    const payloads = [];
    function acceptPayload(payload, transport) {
      ordinal++;
      assert.equal(payload.model, target.model);
      assert.equal(payload.stream, true);
      assert.ok(payload.tools.some(tool => tool.name === toolName));
      if (ordinal === 2) {
        assert.equal(toolEffects, 0);
        assert.deepEqual(payload.input, payloads[0].input);
        assert.equal(payload.previous_response_id, undefined);
        assert.ok(!JSON.stringify(payload.input).includes('failed-private-fixture'));
      }
      payloads.push(payload);
      report.requests.push({ ordinal, transport, inputItems: payload.input.length, inputSha256: sha256(JSON.stringify(payload.input)),
        fullContext: !payload.previous_response_id, reasoningEffort: payload.reasoning?.effort ?? 'absent', toolEffectsAtRequest: toolEffects });
      return ordinal;
    }
    const frame = (socket, event) => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
    class FakeWebSocket extends EventTarget {
      readyState = 0;
      constructor(endpoint, init) {
        super();
        const destination = new URL(endpoint);
        assert.equal(destination.protocol, 'wss:');
        assert.equal(destination.hostname, 'chatgpt.com');
        assert.equal(destination.pathname, '/backend-api/codex/responses');
        assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${access}`);
        sockets.push(this);
        queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
      }
      send(raw) {
        const number = acceptPayload(JSON.parse(raw), 'websocket');
        queueMicrotask(() => {
          if (number !== 1) { for (const event of successfulEvents(number)) frame(this, event); return; }
          const reasoning = { type: 'reasoning', id: 'failed_reasoning', summary: [], encrypted_content: 'fixture-signature' };
          for (const event of [
            { type: 'response.created', response: { id: 'failed_response' } },
            { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, encrypted_content: undefined } },
            { type: 'response.output_item.done', output_index: 0, item: reasoning },
            ...toolEvents('failed_call', 'failed-private-fixture', options.case.complete),
          ]) frame(this, event);
          queueMicrotask(() => { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code: options.case.code, reason: options.case.code === 1012 ? 'service restart' : '', wasClean: true })); });
        });
      }
      close() { this.readyState = 3; }
    }
    globalThis.WebSocket = FakeWebSocket;
    globalThis.fetch = async (input, init) => {
      const endpoint = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (endpoint.origin !== 'https://chatgpt.com' || endpoint.pathname !== '/backend-api/codex/responses') return blockNetwork();
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${access}`);
      const raw = new Headers(init.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body) : init.body;
      const payload = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
      const number = acceptPayload(payload, 'sse');
      assert.ok(number > 1, 'the native first failure must be a WebSocket close, not a synthetic finish');
      return new Response(successfulEvents(number).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
    report.phase = 'real-loop';
    handle = await ctx.agents.create({ sessionId, agentOptions: { ...target, maxTokens: 4096, reasoningEffort: llm.ReasoningEffortId('medium') }, meta: { cwd: options.dump } });
    handle.agent.followup(llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Execute the offline fixture counter once.' }] }));
    await Promise.race([handle.agent.whenIdle(), new Promise((_, reject) => { const timer = setTimeout(() => reject(fail('OFFLINE_LOOP_TIMEOUT')), 20000); timer.unref(); })]);
    report.observedAgentErrors = errors;
    report.observedEventTypes = events.map(event => event.type);
    const failed = events.filter(event => event.type === 'assistant/attempt');
    assert.equal(failed.length, 1);
    const chunks = llm.expandAssistantStream(failed[0].data.stream).map(record => record.chunk);
    report.failedStreamFacts = { chunkTypes: [...new Set(chunks.map(chunk => chunk.type))],
      toolArgumentCharacters: chunks.filter(chunk => chunk.type === 'tool-call-delta').reduce((sum, chunk) => sum + chunk.argumentsDelta.length, 0),
      completedToolBlock: chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call') };
    const finish = chunks.findLast(chunk => chunk.type === 'finish');
    assert.equal(finish.reason.kind, 'error');
    assert.equal(finish.reason.failure.code, options.case.enabled ? 'TRANSPORT' : 'PI_AI_ERROR');
    assert.match(finish.reason.failure.message, new RegExp(`^WebSocket closed ${options.case.code}`));
    assert.ok(chunks.some(chunk => chunk.type === 'tool-call-delta'));
    assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'), options.case.complete);
    assert.equal(atFailure[0].toolEffects, 0);
    assert.equal(atFailure[0].retryMax, 5);
    const retryEvents = events.filter(event => event.type === 'llm/retry');
    const calls = events.filter(event => event.type === 'tool/call');
    if (options.case.enabled) {
      assert.equal(toolEffects, 1);
      assert.equal(ordinal, 3);
      assert.equal(errors.length, 0);
      assert.equal(retryEvents.length, 1);
      assert.equal(retryEvents[0].data.maxRetries, 5);
      assert.equal(retryEvents[0].data.failure.code, 'TRANSPORT');
      assert.equal(events.filter(event => event.type === 'llm/retry-started').length, 1);
      assert.deepEqual(atBackoff, [0]);
      assert.equal(calls.length, 1);
      assert.equal(events.filter(event => event.type === 'tool/result').length, 1);
      assert.ok(calls[0].seq > failed[0].seq);
      assert.equal(durableInputs[0], durableInputs[1]);
      assert.equal(attempts.length, 3);
      assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);
      assert.equal(attempts[0].turn, attempts[1].turn);
      assert.equal(attempts[0].step, attempts[1].step);
      assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
      if (piManifest.version === '0.87.1+alex.codex-default.206545bfd51e') {
        assert.equal(report.requests[1].transport, 'websocket');
        assert.ok(sockets.length >= 2);
      }
    } else {
      assert.equal(toolEffects, 0);
      assert.equal(ordinal, 1);
      assert.equal(retryEvents.length, 0);
      assert.equal(calls.length, 0);
      assert.equal(errors[0].code, 'PI_AI_ERROR');
      assert.equal(events.findLast(event => event.type === 'turn/end').data.reason.kind, 'error');
    }
    assert.ok(marked.length > 0 && marked.every(Boolean));
    assert.equal(marked.length, ordinal, 'every native model request must originate from a real marked loop attempt');
    assert.equal(report.credentialWrites, 0);
    assert.ok(report.credentialReads > 0);
    assert.equal(report.networkCalls, 0);
    assert.equal(report.networkAttemptsBlocked, 0);
    Object.assign(report, { passed: true, phase: 'complete', toolEffects, toolCalls: calls.length, toolResults: events.filter(event => event.type === 'tool/result').length,
      failedAttemptCount: failed.length, failedAttemptCode: finish.reason.failure.code, retries: retryEvents.length, markerChecks: marked.length,
      markerIdentityRealPreparedLoop: true, durableContextHashBefore: durableInputs[0], durableContextHashRetry: durableInputs[1] ?? null,
      retryUsesSameDurableContext: options.case.enabled ? durableInputs[0] === durableInputs[1] : null, failedPartialExcluded: true,
      freshAttemptSameStep: options.case.enabled ? attempts[0].step === attempts[1].step && attempts[0].attemptId !== attempts[1].attemptId : null,
      websocketConnections: sockets.length, zeroToolEffectsBeforeRetry: atFailure.every(item => item.toolEffects === 0) && atBackoff.every(count => count === 0),
      audit: events.map(event => ({ type: event.type, seq: event.seq, ...(event.data?.turn !== undefined ? { turn: event.data.turn } : {}), ...(event.data?.step !== undefined ? { step: event.data.step } : {}) })) });
  } catch (error) {
    report.code = safeCode(error);
    report.assertionFailed = error?.code === 'ERR_ASSERTION';
    // Never serialize assertion values, stream data, fake grants or request bodies.
    report.failureLocation = error?.stack?.split('\n').find(line => line.includes('resilience-check.mjs:'))?.trim() ?? null;
  } finally {
    await handle?.dispose();
    await ctx?.fiber.dispose();
    piApi?.closeOpenAICodexWebSocketSessions?.();
    piApi?.resetOpenAICodexWebSocketDebugStats?.();
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
  return report;
}

export async function runResilienceCheck(options = {}) {
  const { officialRoot = officialRootDefault, profileDir = join(homedir(), '.dsh/profiles/dsh-tui'), expectedVersion,
    explicitOfficialRoot = Object.hasOwn(options, 'officialRoot') && options.officialRoot !== undefined,
    allowUnconfiguredProfile = false } = options;
  const root = await realpath(officialRoot);
  const profileDirectory = await realpath(profileDir);
  const anchor = join(root, '@deepseek-ai/dsh/package.json');
  const require = createRequire(anchor);
  const boot = await import(url(require.resolve('@deepseek-ai/dsh-app-boot')));
  const home = dirname(dirname(profileDirectory));
  const inputPaths = { profilePatch: join(profileDirectory, 'cordis.patch.yml'), profilePackage: join(profileDirectory, 'package.json'),
    profileMain: join(profileDirectory, 'cordis.yml') };
  const inputHashes = async () => Object.fromEntries(await Promise.all(Object.entries(inputPaths).map(async ([key, filename]) =>
    [key, sha256(await readFile(filename))])));
  const filesBefore = await inputHashes();
  const composeProfile = profile => flatten(boot.composeEntries([boot.readProfilePatches('resilience-check', { dir: profileDirectory, installAnchor: anchor,
    patchPath: inputPaths.profilePatch, home, overlays: [], telemetryDisabledEnv: '1' }, profile)]))
    .filter(entry => entry.id === 'alex-codex-transient-close');
  const selectionHash = selected => sha256(JSON.stringify(selected.map(entry => ({ id: entry.id, name: entry.name,
    enabled: !entry.disabled, config: entry.config ?? null }))));
  const profile = boot.loadProfileDirectory('resilience-check', profileDirectory, anchor);
  const selected = composeProfile(profile);
  assert.ok(selected.length <= 1);
  if (!allowUnconfiguredProfile) assert.equal(selected.length, 1, 'Actual profile must compose the personal plugin');
  const selectedSpecifier = selected[0]?.name ?? pluginPath;
  const selectedPath = /^file:/i.test(selectedSpecifier) ? fileURLToPath(selectedSpecifier) : selectedSpecifier;
  assert.equal(await realpath(selectedPath), await realpath(pluginPath));
  const pluginSourceSha256 = sha256(await readFile(selectedPath));
  const snapshotBefore = { files: filesBefore, selectionSha256: selectionHash(selected), pluginSourceSha256 };
  assertSnapshotUnchanged(filesBefore, await inputHashes());
  const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile, home });
  assert.ok(resolution.linkedRoots.some(root => root.name === '@deepseek-harness-tui/dsh-tui' && root.realPath === join(repo, 'frontend/dsh-tui')));
  const bootstrap = url(require.resolve('@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap'));
  const dump = join(repo, '.dumps/pi-ai-fork', `resilience-check-${randomUUID()}`);
  await mkdir(dump, { recursive: true, mode: 0o700 });
  const cases = [{ code: 1012, complete: false, enabled: false }, ...[1000, 1012].flatMap(code => [false, true].map(complete => ({ code, complete, enabled: true })))];
  const reports = [];
  const key = '@deepseek-ai/dsh-app-boot/profile-resolution';
  for (const item of cases) {
    const previous = getEnvironmentData(key);
    let worker;
    try {
      setEnvironmentData(key, { resolution });
      worker = new Worker(new URL(import.meta.url), { workerData: { officialRoot: root, anchor, profileDir: profileDirectory, bootstrap,
        pluginPath: selectedPath, pluginSourceSha256, explicitOfficialRoot, pluginConfig: selected[0]?.config, composedPlugin: selected.length === 1, case: item, dump, expectedVersion },
        execArgv: ['--experimental-import-meta-resolve'], env: { HOME: homedir(), PATH: process.env.PATH ?? '', NODE_ENV: 'test', DSH_TELEMETRY_DISABLED: '1' } });
    } finally { setEnvironmentData(key, previous); }
    reports.push(await new Promise((accept, reject) => {
      let result;
      worker.on('message', message => { result = message; });
      worker.on('error', () => reject(fail('WORKER_FAILED')));
      worker.on('exit', code => code === 0 && result ? accept(result) : reject(fail('WORKER_EXIT_FAILED')));
    }).catch(error => ({ passed: false, code: safeCode(error), case: item })));
  }
  const consistentRuntimeSnapshot = reports.every(item => item.resolution) &&
    new Set(reports.map(item => item.resolution.piVersion)).size === 1 &&
    new Set(reports.map(item => item.resolution.streamSha256)).size === 1;
  let snapshotAfter = null;
  let snapshotStable = false;
  try {
    const finalSelection = composeProfile(boot.loadProfileDirectory('resilience-check', profileDirectory, anchor));
    snapshotAfter = { files: await inputHashes(), selectionSha256: selectionHash(finalSelection),
      pluginSourceSha256: sha256(await readFile(selectedPath)) };
    assertSnapshotUnchanged(snapshotBefore, snapshotAfter);
    for (const item of reports) if (item.resolution) assertSnapshotUnchanged(pluginSourceSha256, item.resolution.pluginSourceSha256);
    snapshotStable = true;
  } catch { /* Changed, missing or unparsable final inputs all fail closed. */ }
  const code = !snapshotStable ? 'SNAPSHOT_CHANGED' : reports.find(item => !item.passed)?.code;
  const report = { schema: 1, passed: reports.every(item => item.passed) && consistentRuntimeSnapshot && snapshotStable, code,
    offlineOnly: true, consistentRuntimeSnapshot, snapshotStable, snapshotBefore, snapshotAfter,
    networkCalls: reports.reduce((sum, item) => sum + (item.networkCalls ?? 0), 0),
    credentialWrites: reports.reduce((sum, item) => sum + (item.credentialWrites ?? 0), 0), runtime: { officialRoot: root, profileDir: profileDirectory,
      bootstrap, freshWorkerPerCase: true, profilePluginComposed: selected.length === 1, profilePluginRequired: !allowUnconfiguredProfile,
      explicitOfficialRoot, profilePatchSha256: filesBefore.profilePatch, expectedVersion: expectedVersion ?? null }, cases: reports,
    reportPath: join(dump, 'report.json') };
  await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (!isMainThread) parentPort.postMessage(await runCase(workerData));
else if (process.argv[1] && url(resolve(process.argv[1])) === import.meta.url) {
  try {
    const args = parseResilienceArgs(process.argv.slice(2));
    const report = await runResilienceCheck(args);
    const summary = { passed: report.passed, piVersion: report.cases[0]?.resolution?.piVersion ?? null,
      code: report.code, snapshotStable: report.snapshotStable,
      profilePluginComposed: report.runtime.profilePluginComposed, consistentRuntimeSnapshot: report.consistentRuntimeSnapshot,
      markerIdentity: report.cases.every(item => item.markerIdentityRealPreparedLoop === true),
      caseCounts: { total: report.cases.length, passed: report.cases.filter(item => item.passed).length,
        recovered: report.cases.filter(item => item.case.enabled && item.passed).length },
      networkCalls: report.networkCalls, credentialWrites: report.credentialWrites, reportPath: report.reportPath };
    console.log(JSON.stringify(args.summary ? summary : { passed: report.passed, offlineOnly: true, networkCalls: report.networkCalls,
      credentialWrites: report.credentialWrites, profilePluginComposed: report.runtime.profilePluginComposed,
      reportPath: report.reportPath, cases: report.cases.map(item => ({ ...item.case, passed: item.passed, phase: item.phase,
        closeCode: item.case?.code, failureCode: item.code, location: item.failureLocation, piVersion: item.resolution?.piVersion,
        requestCount: item.requests?.length, toolEffects: item.toolEffects, failedAttemptCode: item.failedAttemptCode,
        retryCount: item.retries, markerChecks: item.markerChecks, freshAttemptSameStep: item.freshAttemptSameStep })) }, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) { console.log(JSON.stringify({ passed: false, code: safeCode(error) })); process.exitCode = 1; }
}
