import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHostSdkEntry } from '../../plugins/codex-transient-close/sdk-host.mjs';
import { Worker } from 'node:worker_threads';

// Run against a reviewed candidate; never copy/promote it into the live host.
// Example (fish): env RESILIENCE_CANDIDATE_ROOT=.dumps/.../package node --test tools/resilience/pi-ai-candidate-runtime.test.mjs
const workspace = fileURLToPath(new URL('../../', import.meta.url));
// Portable default: the reviewed scratch candidate when present, otherwise the
// already-promoted installed host package (the redirect then is an identity).
const reviewedCandidate = resolve(workspace, '.dumps/generalized-failure-20261015-candidate4/package');
const candidateRoot = process.env.RESILIENCE_CANDIDATE_ROOT ? resolve(workspace, process.env.RESILIENCE_CANDIDATE_ROOT)
  : existsSync(reviewedCandidate) ? reviewedCandidate : dirname(dirname(fileURLToPath(resolveHostSdkEntry())));
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
const controllerModule = process.env.RESILIENCE_CONTROLLER_MODULE && resolve(workspace, process.env.RESILIENCE_CONTROLLER_MODULE);
const selfHealModule = process.env.SELF_HEAL_PLUGIN_MODULE && resolve(workspace, process.env.SELF_HEAL_PLUGIN_MODULE);
const privateAgentInput = process.env.RESILIENCE_PRIVATE_AGENT_ROOT ?? process.env.PRIVATE_AGENT_ROOT;
const privateAgentRoot = privateAgentInput && resolve(workspace, privateAgentInput);
const evidence = [];
let validatedScenarios = 0;
export function runCandidateFixture(settings) {
  return new Promise((resolveResult, reject) => {
    // Inherit no real API keys, OAuth environment, HOME or credential paths.
    const worker = new Worker(new URL('./pi-ai-candidate-worker.mjs', import.meta.url), {
      workerData: { ...settings, candidateRoot, dataHome, controllerModule: settings.controllerModule ?? controllerModule,
        selfHealModule: settings.selfHealModule ?? selfHealModule, privateAgentRoot: settings.privateAgentRoot ?? privateAgentRoot },
      env: { HOME: '/nonexistent-resilience-offline-home', RESILIENCE_OFFLINE_API_KEY: 'offline-not-real' },
    });
    let result, failure;
    const deadline = setTimeout(() => { failure = new Error('Candidate native-adapter fixture exceeded 20 seconds'); void worker.terminate(); }, 20000);
    worker.on('message', message => {
      if (message.error) failure = Object.assign(new Error(message.error.message), { stack: message.error.stack });
      else result = message.result;
    });
    worker.on('error', error => { failure = error; });
    worker.on('exit', code => {
      clearTimeout(deadline);
      if (failure) reject(failure);
      else if (code || !result) reject(new Error(`Candidate fixture exited ${code} without a result`));
      else {
        evidence.push({ scenario: result.scenario, hint: settings.hint ?? false, candidateRoot: result.candidateRoot, canonicalEntry: result.canonicalEntry,
          controllerModule: result.controllerModule, selfHealModule: result.selfHealModule,
          recoveryVersion: result.recoveryVersion, recoveryHistoryVersion: result.recoveryHistoryVersion,
          nativeExplicitEmptyConfigApplied: result.nativeExplicitEmptyConfigApplied,
          effectiveRecoveryCodes: result.effectiveRecoveryCodes,
          effectiveReplaySafePurposes: result.effectiveReplaySafePurposes,
          privateAgentProof: result.privateAgentProof,
          sdkSingletonIdentity: result.sdkSingletonIdentity, capabilities: result.capabilities, hashes: result.hashes,
          fetches: result.calls.length, preparations: result.preparations, sdkFailures: result.sdkReports,
          waits: result.waits, toolCalls: result.toolCalls, retries: result.events.filter(event => event.type === 'llm/retry').map(event => event.data),
          nativeRawFailures: result.rawFinishes.filter(chunk => chunk.reason.kind === 'error').map(chunk => ({ code: chunk.reason.failure.code, status: chunk.reason.failure.status })),
          normalizedFailures: result.outerFinishes.filter(chunk => chunk.reason.kind === 'error').map(chunk => chunk.reason.failure),
          publishedFinishKinds: result.publishedChunks.filter(chunk => chunk.type === 'finish').map(chunk => chunk.reason.kind),
          warningCount: result.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'self-heal-observation').length,
          wireRecoveryRequests: result.calls.slice(0, result.waits.length + 1).map(call => ({ ordinal: call.ordinal,
            warningCount: countWarnings(call.body.messages),
            retainedInitialHistory: JSON.stringify(call.body.messages.slice(0, result.calls[0].body.messages.length)) === JSON.stringify(result.calls[0].body.messages) })),
          modelRecoveryWarningCounts: result.streamRequests.slice(0, result.waits.length + 1).map(request => countWarnings(request.messages)),
          socketAttempts: result.socketAttempts, errors: result.errors });
        resolveResult(result);
      }
    });
  });
}
const events = (result, type) => result.events.filter(event => event.type === type);
const nominal = [7031.25, 14062.5, 28125, 56250, 112500, 225000, 450000, 900000, 1800000, 3600000];
const warningEvents = result => events(result, 'user/message').filter(event => event.data.source?.kind === 'self-heal-observation');
const contentText = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const countWarnings = messages => messages.filter(message => message.role === 'user' && contentText(message).includes('harness warning:')).length;
function checkContextualHistory(messages, original, retry) {
  assert.deepEqual(messages.slice(0, original.length), original, 'original request/history is preserved');
  const inserted = messages.slice(original.length);
  assert(retry >= 1);
  assert.equal(inserted.length, 1, 'one warning per chain (same code), no failed assistant output');
  for (const warning of inserted) {
    assert.equal(warning.role, 'user');
    const text = contentText(warning);
    assert(text.includes('harness warning:'));
    assert(!/"retry"|retry \d+ of/.test(text), 'the notice carries no retry counter');
    assert(!text.includes('CANARY')); assert(!text.includes('failed-tool-call'));
  }
}
function checkTen(result) {
  assert.equal(result.adapterDefaultRetries, 5);
  assert.equal(result.sdkSingletonIdentity, true);
  assert(result.capabilities.includes('openai-completions'));
  assert(result.redirected.some(url => url.endsWith('/dist/api/openai-completions.js')));
  assert(result.redirected.some(url => url.endsWith('/dist/utils/provider-failure.js')));
  assert.equal(result.socketAttempts.length, 0); assert.equal(result.errors.length, 0);
  assert.equal(result.calls.length, 12, 'ten failures, one successful tool request and one final stop');
  assert.equal(result.preparations, 12, 'fresh actual PiAiAdapter preparation per request');
  assert.equal(events(result, 'assistant/attempt').length, 10);
  assert.equal(events(result, 'llm/retry').length, 10); assert.equal(events(result, 'llm/retry-started').length, 10);
  assert.equal(result.waits.length, 10, 'one controller wait per durable retry; no duplicated SDK/native retry engine');
  assert.deepEqual(result.waits.map(wait => wait.delayMs), nominal.map(Math.ceil));
  assert.deepEqual(events(result, 'llm/retry').map(event => event.data.delayMs), nominal);
  assert.equal(warningEvents(result).length, 1, 'ten same-code failures produce one warning');
  assert.equal(events(result, 'agent/self-heal').filter(event => event.data.action === 'reserved').length, 10);
  assert(result.waits.every(wait => wait.fired && !wait.cancelled && wait.toolsBeforeWait === 0));
  assert(events(result, 'llm/retry').every(event => event.data.mode === 'always' && event.data.maxRetries === undefined && event.data.provider === 'resilience-unlisted-http-fixture'));
  assert.equal(result.toolCalls.length, 1); assert.equal(result.toolCalls[0].afterRetryCount, 10);
  assert.equal(events(result, 'tool/call').length, 1); assert.equal(events(result, 'tool/result').length, 1);
  assert.equal(new Set(result.starts.map(start => start.attemptId)).size, result.starts.length);
  assert(result.streamRequests.every(request => request.marked));
  for (let index = 1; index <= 10; index++) checkContextualHistory(result.calls[index].body.messages, result.calls[0].body.messages, index);
  assert(result.calls.every(call => call.sdkRetryCount === '0'));
}

test('actual PiAiAdapter + SDK singleton + bridge + contextual owner recover ten HTTP500 failures without blind requests', async () => {
  const result = await runCandidateFixture({ scenario: 'main' });
  checkTen(result);
  assert.equal(result.sdkReports.length, 10);
  for (let index = 0; index < 10; index++) {
    const dto = result.sdkReports[index];
    assert.equal(dto.provider, 'resilience-unlisted-http-fixture'); assert.equal(dto.api, 'openai-completions');
    assert.equal(dto.code, 'SERVER'); assert.equal(dto.status, 500); assert.equal(dto.requestId, `fixture-http-${index}`);
    assert.equal(dto.providerRetryAfterMs, undefined);
    assert(!JSON.stringify(dto).includes('CANARY'));
    // This host may classify the client's display-string "500" as SERVER;
    // that does not preserve the actual status, requestId or safe message.
    assert.equal(result.rawFinishes[index].reason.failure.status, undefined);
    assert.equal(result.rawFinishes[index].reason.failure.requestId, undefined);
    assert.notEqual(result.rawFinishes[index].reason.failure.message, 'Provider failure (SERVER)');
    const failure = result.outerFinishes[index].reason.failure;
    assert.deepEqual(failure, { code: 'SERVER', message: 'Provider failure (SERVER)', status: 500, requestId: `fixture-http-${index}` });
    assert(!('replayState' in result.outerFinishes[index]));
  }
  validatedScenarios++;
});

test('actual OpenAI HTTP response headers preserve requestId and Retry-After through bridge, durable audit and exactly one wait', async () => {
  const result = await runCandidateFixture({ scenario: 'main', hint: true });
  checkTen(result);
  for (let index = 0; index < 10; index++) {
    assert.equal(result.sdkReports[index].providerRetryAfterMs, 7000);
    const failure = events(result, 'llm/retry')[index].data.failure;
    assert.equal(failure.status, 500); assert.equal(failure.requestId, `fixture-http-${index}`); assert.equal(failure.providerRetryAfterMs, 7000);
  }
  validatedScenarios++;
});

test('actual failed SSE partial and complete CLIENT tool are never dispatched/replayed; successful SSE tool runs once', async () => {
  const result = await runCandidateFixture({ scenario: 'partial-tool' });
  assert.equal(result.calls.length, 3); assert.equal(result.preparations, 3);
  assert.equal(result.sdkReports.length, 1); assert.equal(result.sdkReports[0].code, 'SERVER');
  assert.equal(result.sdkReports[0].status, undefined, 'HTTP200 stream is not an invented error status');
  assert.equal(result.waits.length, 1); assert.equal(result.waits[0].toolsBeforeWait, 0);
  assert.equal(result.toolCalls.length, 1); assert.equal(result.toolCalls[0].afterFetchCount, 2);
  assert.equal(events(result, 'assistant/attempt').length, 1); assert.equal(events(result, 'tool/call').length, 1);
  assert(!JSON.stringify(result.calls[1].body.messages).includes('FAILED_PARTIAL_CANARY'));
  assert(!JSON.stringify(result.calls[1].body.messages).includes('failed-tool-call'));
  checkContextualHistory(result.calls[1].body.messages, result.calls[0].body.messages, 1);
  assert.equal(warningEvents(result).length, 1);
  assert(!('replayState' in result.outerFinishes[0]));
  validatedScenarios++;
});

test('native typed adapter bypasses SDK classification unchanged while receiving ten contextual retries', async () => {
  const result = await runCandidateFixture({ scenario: 'native' });
  assert.equal(result.calls.length, 0); assert.equal(result.sdkReports.length, 0); assert.equal(result.preparations, 0);
  assert.equal(result.streamRequests.length, 11); assert.equal(result.waits.length, 10);
  assert.deepEqual(result.waits.map(wait => wait.delayMs), nominal.map(Math.ceil));
  assert.equal(events(result, 'assistant/attempt').length, 10);
  assert.equal(events(result, 'llm/retry').length, 10); assert.equal(warningEvents(result).length, 1);
  assert(events(result, 'llm/retry').every(event => event.data.mode === 'always' && event.data.failure.message === 'native opaque typed' && event.data.failure.status === 502));
  for (let index = 0; index < 10; index++) assert.strictEqual(result.outerFinishes[index], result.rawFinishes[index]);
  for (let index = 1; index <= 10; index++) checkContextualHistory(result.streamRequests[index].messages, result.streamRequests[0].messages, index);
  validatedScenarios++;
});

test('actual OpenAI client HTTP200 in-band MTMD machine error recovers SERVER without inventing HTTP500', async () => {
  const result = await runCandidateFixture({ scenario: 'inband-mtmd' });
  assert.equal(result.calls.length, 3); assert.equal(result.preparations, 3);
  assert.equal(result.sdkReports.length, 1);
  const dto = result.sdkReports[0];
  assert.equal(dto.provider, 'resilience-unlisted-http-fixture'); assert.equal(dto.api, 'openai-completions');
  assert.equal(dto.code, 'SERVER'); assert.equal(dto.status, undefined);
  assert(!JSON.stringify(dto).includes('failed to process mtmd chunk'));
  const normalized = result.outerFinishes[0].reason.failure;
  assert.deepEqual(normalized, { code: 'SERVER', message: 'Provider failure (SERVER)', requestId: 'fixture-sse-request' });
  assert.equal(result.rawFinishes[0].reason.failure.status, undefined);
  assert.equal(typeof result.rawFinishes[0].reason.failure.code, 'string', 'record native classification honestly rather than forcing historical PI_AI_ERROR');
  assert.equal(result.waits.length, 1); assert.equal(result.waits[0].delayMs, Math.ceil(nominal[0])); assert.equal(result.waits[0].toolsBeforeWait, 0);
  assert.equal(events(result, 'llm/retry').length, 1); assert.equal(events(result, 'llm/retry')[0].data.failure.status, undefined);
  assert.equal(result.toolCalls.length, 1); checkContextualHistory(result.calls[1].body.messages, result.calls[0].body.messages, 1);
  assert.equal(warningEvents(result).length, 1);
  validatedScenarios++;
});

test('actual auxiliary native LLM stream sees classified HTTP500 and publishes only successful compaction output', async () => {
  const result = await runCandidateFixture({ scenario: 'auxiliary', hint: true });
  assert.equal(result.calls.length, 2); assert.equal(result.preparations, 2);
  assert.equal(result.sdkReports.length, 1); assert.equal(result.sdkReports[0].code, 'SERVER'); assert.equal(result.sdkReports[0].status, 500);
  assert.equal(result.waits.length, 1); assert.equal(result.waits[0].delayMs, Math.ceil(nominal[0]));
  assert.equal(events(result, 'llm/retry').length, 0, 'auxiliary operation must not invent a turn/step audit');
  assert.equal(result.toolCalls.length, 0);
  const publishedFinish = result.publishedChunks.filter(chunk => chunk.type === 'finish');
  assert.equal(publishedFinish.length, 1); assert.equal(publishedFinish[0].reason.kind, 'stop');
  assert(!result.publishedChunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error'));
  assert(result.streamRequests.every(request => !request.marked && request.purpose === 'compaction'));
  checkContextualHistory(result.calls[1].body.messages, result.calls[0].body.messages, 1);
  assert.equal(events(result, 'agent/self-heal').length, 0); assert.equal(warningEvents(result).length, 0);
  validatedScenarios++;
});

after(async () => {
  if (!process.env.RESILIENCE_RUNTIME_REPORT) return;
  assert.equal(validatedScenarios, 6, 'never publish a passing receipt for incomplete/failed scenario assertions');
  const target = resolve(workspace, process.env.RESILIENCE_RUNTIME_REPORT);
  const allowed = resolve(workspace, '.dumps') + sep;
  assert(target.startsWith(allowed), 'evidence output must stay beneath .dumps');
  await mkdir(dirname(target), { recursive: true });
  // A collector must choose a new receipt name instead of overwriting evidence.
  await writeFile(target, JSON.stringify({ reportVersion: 3, kind: 'unified-contextual-sdk-offline', recoveryVersion: 3, recoveryHistoryVersion: 3,
    candidateRoot, nominalIntervalsMs: nominal, timerRounding: 'ceil',
    network: 'in-memory fetch only; socket/TLS/WebSocket blocked', scenarios: evidence }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
});
