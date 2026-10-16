import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import net from 'node:net';
import tls from 'node:tls';

const root = fileURLToPath(new URL('../../', import.meta.url));
const candidateRoot = await realpath(resolve(workerData.candidateRoot));
const controllerModule = await realpath(resolve(workerData.controllerModule ?? join(root, 'plugins/llm-resilience/index.mjs')));
const selfHealModule = await realpath(resolve(workerData.selfHealModule ?? join(root, 'plugins/agent-self-heal/index.mjs')));
// Same runtime location rule as the dsh launcher. The worker env deliberately
// replaces HOME, so the parent passes its resolved data home explicitly.
const requireHost = createRequire(join(workerData.dataHome ?? process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'dsh-cli/package.json'));
const hostPath = id => requireHost.resolve(`@deepseek-ai/${id}`);
// The narrowly qualified duplicate Agent may vary; its LLM WeakSet owner must
// not. Resolve/hash the complete loaded Agent graph, never a second LLM graph.
const canonicalAgent = await realpath(dirname(dirname(hostPath('dsh-agent'))));
const privateAgent = workerData.privateAgentRoot && await realpath(resolve(workerData.privateAgentRoot));
const canonicalLlm = await realpath(dirname(dirname(hostPath('dsh-llm'))));
const agentFrom = pathToFileURL(canonicalAgent + '/').href;
const agentTo = privateAgent && pathToFileURL(privateAgent + '/').href;
const llmPrefix = pathToFileURL(canonicalLlm + '/').href;
const agentFiles = new Map(), llmFiles = new Map();
const hashFile = path => createHash('sha256').update(readFileSync(path)).digest('hex');
if (privateAgent) {
  assert.equal(JSON.parse(await readFile(join(privateAgent, 'package.json'), 'utf8')).name, '@deepseek-ai/dsh-agent');
  for (const relative of ['package.json', 'lib/index.js']) {
    assert.equal(hashFile(join(privateAgent, relative)), hashFile(join(canonicalAgent, relative)), 'private Agent must remain byte-identical');
  }
}
const adapterPath = hostPath('dsh-llm-pi-ai');
const adapterRequire = createRequire(adapterPath);
let canonicalEntry;
for (const search of adapterRequire.resolve.paths('@earendil-works/pi-ai') ?? []) {
  const packageRoot = join(search, '@earendil-works/pi-ai');
  let manifest;
  try { manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  assert.equal(manifest.name, '@earendil-works/pi-ai');
  const entry = manifest.exports?.['.']?.import;
  assert.equal(typeof entry, 'string'); assert(entry.startsWith('./'));
  canonicalEntry = await realpath(resolve(packageRoot, entry));
  break;
}
assert(canonicalEntry, 'resolve the public import-only SDK from the host adapter');
const canonicalDist = pathToFileURL(dirname(canonicalEntry) + '/').href;
const candidateDist = pathToFileURL(join(candidateRoot, 'dist') + '/').href;
const redirected = new Set();
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (privateAgent && (result.url.startsWith(agentFrom) || result.url.startsWith(agentTo))) {
      const relative = result.url.slice((result.url.startsWith(agentFrom) ? agentFrom : agentTo).length);
      const from = new URL(relative, agentFrom).href, to = new URL(relative, agentTo).href;
      const sha256 = hashFile(fileURLToPath(from));
      assert.equal(hashFile(fileURLToPath(to)), sha256, 'every private Agent chunk must be byte-identical');
      agentFiles.set(to, { from, to, sha256 });
      return { ...result, url: to };
    }
    if (privateAgent && result.url.includes('/@deepseek-ai/dsh-llm/')) {
      assert(result.url.startsWith(llmPrefix), 'private Agent must retain the canonical LLM WeakSet owner');
      assert.equal(new URL(result.url).search, ''); assert.equal(new URL(result.url).hash, '');
      const path = realpathSync(fileURLToPath(result.url));
      assert(path.startsWith(canonicalLlm + '/'));
      llmFiles.set(result.url, { url: result.url, path, sha256: hashFile(path) });
    }
    // Redirect the entire exact SDK graph, including lazy APIs and the public
    // bridge import. Candidate dependency packages remain their real packages.
    if (result.url.startsWith(canonicalDist)) {
      const url = candidateDist + result.url.slice(canonicalDist.length);
      redirected.add(url);
      return { ...result, url };
    }
    if (result.url.startsWith(candidateDist)) redirected.add(result.url);
    return result;
  },
});

const provider = 'resilience-unlisted-http-fixture';
const model = 'fixture-plain';
const baseURL = 'https://resilience-fixture.invalid/v1';
const canary = 'MTMD opaque TOKEN_ACCOUNT_INSTRUCTION_CANARY';
const calls = [], socketAttempts = [], sdkReports = [], preparations = [], streamRequests = [], rawFinishes = [], outerFinishes = [];
const waits = [], toolCalls = [], events = [], starts = [], errors = [], publishedChunks = [];
let nativeOriginal, phase = 'main';
const deny = kind => (..._args) => { socketAttempts.push(kind); throw new Error(`Real ${kind} forbidden in offline candidate fixture`); };
net.Socket.prototype.connect = deny('socket');
tls.connect = deny('TLS');
globalThis.WebSocket = class { constructor() { deny('WebSocket')(); } };
process.env.RESILIENCE_OFFLINE_API_KEY = 'offline-not-real';

function sse(chunks) {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-sse-request' },
  });
}
function choice(delta, finish_reason = null) {
  return { id: 'offline-response', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason }] };
}
function toolStream(failed = false) {
  return sse([
    choice({ role: 'assistant', content: failed ? 'FAILED_PARTIAL_CANARY' : 'winning-tool' }),
    choice({ tool_calls: [{ index: 0, id: failed ? 'failed-tool-call' : 'winning-tool-call', type: 'function', function: { name: 'fixture_spy', arguments: '{}' } }] }),
    choice({}, failed ? 'server_error' : 'tool_calls'),
    { id: 'offline-response', object: 'chat.completion.chunk', created: 0, model, choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } },
  ]);
}
// Install fake fetch BEFORE any third-party SDK/adapter import captures it. No
// localhost server, real API, auth discovery, or live credential is involved.
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  assert.equal(url, `${baseURL}/chat/completions`);
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  assert.equal(headers.get('authorization'), 'Bearer offline-not-real');
  assert.equal(headers.get('x-stainless-retry-count'), '0', 'the real client must not retry internally');
  const body = JSON.parse(typeof init.body === 'string' ? init.body : await input.text());
  assert.equal(body.model, model); assert.equal(body.stream, true);
  const ordinal = calls.length;
  calls.push({ phase, ordinal, body, sdkRetryCount: headers.get('x-stainless-retry-count') });
  const failures = ['partial-tool', 'inband-mtmd', 'auxiliary'].includes(workerData.scenario) ? 1 : 10;
  if (ordinal < failures) {
    if (workerData.scenario === 'partial-tool') return toolStream(true);
    if (workerData.scenario === 'inband-mtmd') return sse([{ error: { message: 'failed to process mtmd chunk', type: 'server_error', code: 500 } }]);
    return new Response(JSON.stringify({ error: { message: canary } }), {
      status: 500, headers: { 'content-type': 'application/json', 'x-request-id': `fixture-http-${ordinal}`, ...(workerData.hint ? { 'retry-after': '7' } : {}) },
    });
  }
  if (workerData.scenario !== 'auxiliary' && ordinal === failures) return toolStream();
  return sse([choice({ role: 'assistant', content: 'winning-final-answer' }), choice({}, 'stop')]);
};

async function run() {
  const hashFiles = Object.fromEntries([
    ...['dist/index.js', 'dist/utils/provider-failure.js', 'dist/api/openai-completions.js'].map(relative => [relative, join(candidateRoot, relative)]),
    ...['plugins/codex-transient-close/index.mjs', 'plugins/codex-transient-close/failure-bridge.mjs', 'plugins/llm-resilience/index.mjs', 'plugins/llm-resilience/controller.mjs', 'plugins/llm-resilience/policy.mjs', 'plugins/llm-resilience/main-driver.mjs', 'plugins/llm-resilience/aux-driver.mjs', 'plugins/agent-self-heal/index.mjs', 'plugins/agent-self-heal/logic.mjs', 'plugins/agent-self-heal/sanitizer.mjs', 'plugins/agent-self-heal/persistence.mjs', 'tools/resilience/pi-ai-candidate-runtime.test.mjs', 'tools/resilience/pi-ai-candidate-worker.mjs'].map(relative => [relative, join(root, relative)]),
    ['controllerModule', controllerModule], ['selfHealModule', selfHealModule],
    ...['plugins/common.mjs', 'plugins/codex-transient-close/sdk-host.mjs', 'plugins/llm-resilience/recovery-accounting.mjs', 'plugins/agent-self-heal/state-schema.mjs'].map(relative => [relative, join(root, relative)]),
    ...(privateAgent ? [['canonicalAgentEntry', join(canonicalAgent, 'lib/index.js')], ['privateAgentEntry', join(privateAgent, 'lib/index.js')],
      ['canonicalAgentManifest', join(canonicalAgent, 'package.json')], ['privateAgentManifest', join(privateAgent, 'package.json')]] : []),
    ['nativeAdapter', adapterPath],
  ]);
  const hashSources = async () => Object.fromEntries(await Promise.all(Object.entries(hashFiles).map(async ([key, path]) => [key, createHash('sha256').update(await readFile(path)).digest('hex')])));
  const hashes = await hashSources();
  // Both names MUST resolve to one namespace, not a private imported helper.
  const sdk = await import(pathToFileURL(canonicalEntry).href);
  const candidateSdk = await import(pathToFileURL(join(candidateRoot, 'dist/index.js')).href);
  const helper = await import(pathToFileURL(join(candidateRoot, 'dist/utils/provider-failure.js')).href);
  assert.strictEqual(sdk, candidateSdk);
  assert.strictEqual(sdk.subscribeProviderFailures, helper.subscribeProviderFailures);
  assert.equal(sdk.PROVIDER_FAILURE_OBSERVER_VERSION, 1);
  assert(Object.isFrozen(sdk.PROVIDER_FAILURE_APIS));
  assert(sdk.PROVIDER_FAILURE_APIS.includes('openai-completions'));
  const host = id => import(hostPath(id));
  const [{ Context }, llm, { default: Sessions }, { default: Projections }, { default: Agents }, { default: SystemPrompt }, { default: Tools, defineTool }, { default: Loop }, piAi] = await Promise.all(
    ['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent-loop', 'dsh-llm-pi-ai'].map(host),
  );
  if (privateAgent) {
    assert.strictEqual(Agents, (await import(pathToFileURL(join(privateAgent, 'lib/index.js')).href)).default);
    assert.strictEqual(llm, await import(pathToFileURL(join(canonicalLlm, 'lib/index.js')).href));
  }
  const bridge = await import(new URL('../../plugins/codex-transient-close/index.mjs', import.meta.url));
  const { resolveHostSdkEntry } = await import(new URL('../../plugins/codex-transient-close/sdk-host.mjs', import.meta.url));
  assert.strictEqual(await import(resolveHostSdkEntry()), sdk, 'bridge and native adapter must share the candidate SDK singleton');
  const resilience = await import(pathToFileURL(controllerModule).href);
  const selfHeal = await import(pathToFileURL(selfHealModule).href);
  const originalPrepare = piAi.PiAiAdapter.prototype.prepareCall;
  const ctx = new Context();
  const off = sdk.subscribeProviderFailures(dto => sdkReports.push(dto));
  const internals = {
    random: () => 0.5,
    setTimeout(callback, delay) {
      const wait = { delayMs: delay, fired: false, cancelled: false, toolsBeforeWait: toolCalls.length };
      waits.push(wait);
      queueMicrotask(() => { if (!wait.cancelled) { wait.fired = true; callback(); } });
      return wait;
    },
    clearTimeout(wait) { if (wait && !wait.fired) wait.cancelled = true; },
  };
  piAi.PiAiAdapter.prototype.prepareCall = async function (...args) {
    const call = await originalPrepare.apply(this, args);
    assert.equal(call.model.context.contextWindow, 131072);
    preparations.push(call);
    return call;
  };
  try {
    for (const plugin of [llm.default, Sessions, Projections, Agents, SystemPrompt, Tools]) await ctx.plugin(plugin);
    await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 });
    // Real profile rows pass config: {}. An omitted config short-circuits the
    // schema transformation and used to hide implicit array opt-outs.
    await ctx.plugin({ ...resilience, apply(c, config) { return resilience.apply(c, config, internals); } }, {});
    const history = ctx.get('llmRecoveryUnbounded');
    assert.equal(history.recoveryVersion, 3);
    assert.equal(history.recoveryHistoryVersion, 3);
    for (const old of ['llmRecovery', 'llmResilience', 'llmRecoveryHistory']) assert.equal(ctx.get(old), undefined, `contract-2 alias ${old} must stay unpublished`);
    assert.deepEqual(history.config.policy.retryableCodes, ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR', 'INVALID_REQUEST']);
    assert.deepEqual(history.config.auxiliary.replaySafePurposes, ['compaction', 'session-title']);
    await ctx.plugin(selfHeal);
    await ctx.plugin(bridge);
    // Appending after classification observes the actual native adapter's raw
    // terminal facts; all instrumentation still uses the public waterfall.
    ctx.on('llm/stream', (options, next) => (async function* () {
      streamRequests.push({ marked: llm.isAgentLoopRequest(options), purpose: options.purpose, messages: options.messages });
      for await (const chunk of next()) { if (chunk.type === 'finish') rawFinishes.push(chunk); yield chunk; }
    })());
    ctx.on('llm/stream', (_options, next) => (async function* () {
      for await (const chunk of next()) { if (chunk.type === 'finish') outerFinishes.push(chunk); yield chunk; }
    })(), { prepend: true });
    ctx.on('session/event', (_session, event) => {
      events.push(event);
      if (event.type === 'llm/retry') {
        const attempt = events.findLast(previous => previous.type === 'assistant/attempt');
        const warning = events.findLast(previous => previous.type === 'user/message' && previous.data.source?.kind === 'self-heal-observation');
        const reserved = events.findLast(previous => previous.type === 'agent/self-heal' && previous.data.action === 'reserved');
        assert(attempt && reserved && warning, 'failed attempt, shared reservation and the chain warning must precede retry');
        // One warning per chain: it follows the FIRST reservation; later cycles reuse it.
        assert(attempt.seq < reserved.seq && reserved.seq < event.seq && warning.seq < event.seq);
        assert(warning.data.content[0].text.startsWith('harness warning:'));
        assert.equal(toolCalls.length, 0, 'failed tool output cannot dispatch during recovery');
      }
    });
    ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'start') starts.push(frame); });
    ctx.on('agent/error', ({ error }) => errors.push({ code: error.code, message: error.message }));
    ctx.tools.register(defineTool({ name: 'fixture_spy', description: 'Offline side-effect-free counter.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      execute() { toolCalls.push({ afterFetchCount: calls.length, afterRetryCount: events.filter(e => e.type === 'llm/retry').length }); return 'offline-tool-result'; },
    }));
    let adapterDefaultRetries;
    const route = workerData.scenario === 'native' ? 'deepseek' : provider;
    if (workerData.scenario === 'native') {
      ctx.llm.registerAdapter([route], new class extends llm.LlmAdapter {
        listModels() { return [{ id: model, name: 'Native typed fixture', contextWindow: 131072, maxTokens: 1024, input: ['text'], output: ['text'] }]; }
        async *stream() {
          if (streamRequests.length <= 10) {
            nativeOriginal = Object.freeze({ type: 'finish', reason: Object.freeze({ kind: 'error', failure: Object.freeze({ code: 'SERVER', message: 'native opaque typed', status: 502, requestId: 'native-request' }) }) });
            yield nativeOriginal;
          } else yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }());
      adapterDefaultRetries = ctx.llm.providerRetryPolicy(route).maxRetries;
    } else {
      await ctx.plugin(piAi, { providers: { [provider]: {
        apiKeyEnv: 'RESILIENCE_OFFLINE_API_KEY', api: 'openai-completions', baseURL, transport: 'sse',
        models: [{ id: model, name: 'Offline plain', contextWindow: 131072, maxTokens: 1024, input: ['text'], reasoningEfforts: false }],
      } } });
      adapterDefaultRetries = ctx.llm.providerRetryPolicy(provider).maxRetries;
    }
    assert.equal(adapterDefaultRetries, 5, 'native registration still exposes old resolved defaults');
    if (workerData.scenario === 'auxiliary') {
      phase = 'auxiliary';
      for await (const chunk of ctx.llm.stream({ provider, model, purpose: 'compaction', messages: [llm.createUserMessage({ content: [{ type: 'text', text: 'offline compact input' }], source: { kind: 'user' } })] })) publishedChunks.push(chunk);
    } else {
      const { agent } = await ctx.agents.create({ sessionId: `candidate-runtime-${workerData.scenario}`, agentOptions: { provider: route, model }, meta: { cwd: root } });
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'offline fixture input' }], source: { kind: 'user' } }));
      await agent.whenIdle();
    }
    assert.equal(new Set(preparations).size, preparations.length, 'each actual PiAiAdapter preparation is fresh');
    assert(sdkReports.every(dto => Object.isFrozen(dto)), 'actual producer reports are detached frozen DTOs');
    assert.equal(socketAttempts.length, 0);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    if (workerData.scenario === 'native') {
      assert.equal(calls.length, 0); assert.equal(sdkReports.length, 0);
      for (let index = 0; index < 10; index++) assert.strictEqual(rawFinishes[index], outerFinishes[index]);
    }
    if (privateAgent) {
      assert(agentFiles.size > 0 && llmFiles.size > 0, 'qualification must observe both actual module graphs');
      for (const record of agentFiles.values()) for (const url of [record.from, record.to]) assert.equal(hashFile(fileURLToPath(url)), record.sha256);
      for (const record of llmFiles.values()) assert.equal(hashFile(record.path), record.sha256);
    }
    assert.deepEqual(await hashSources(), hashes, 'source drift during execution invalidates the evidence');
    return {
      scenario: workerData.scenario, candidateRoot, canonicalEntry, controllerModule, selfHealModule,
      recoveryVersion: history.recoveryVersion, recoveryHistoryVersion: history.recoveryHistoryVersion,
      nativeExplicitEmptyConfigApplied: true,
      effectiveRecoveryCodes: [...history.config.policy.retryableCodes],
      effectiveReplaySafePurposes: [...history.config.auxiliary.replaySafePurposes],
      ...(privateAgent ? { privateAgentProof: { canonicalAgent, privateAgent, canonicalLlm,
        loadedAgentDefaultIdentity: true, canonicalLlmNamespaceIdentity: true,
        redirects: [...agentFiles.values()], llmObserved: [...llmFiles.values()] } } : {}),
      sdkSingletonIdentity: true, capabilities: [...sdk.PROVIDER_FAILURE_APIS], hashes,
      redirected: [...redirected], socketAttempts, adapterDefaultRetries, calls, preparations: preparations.length, streamRequests,
      sdkReports, rawFinishes, outerFinishes, publishedChunks, waits, toolCalls, events, starts, errors,
    };
  } finally {
    off(); await ctx.fiber.dispose(); piAi.PiAiAdapter.prototype.prepareCall = originalPrepare;
  }
}
try { parentPort.postMessage({ result: await run() }); }
catch (error) { parentPort.postMessage({ error: { message: error.message, stack: error.stack } }); }
finally { hooks.deregister(); }
