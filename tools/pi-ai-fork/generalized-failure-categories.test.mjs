import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { apis, patchApi, patchShared, sha } from './generalized-failure-categories.mjs';
const candidate = resolve(process.env.GENERALIZED_FAILURE_CANDIDATE ?? '.dumps/generalized-failure-20261015-candidate4/package');
// Hard network guard: fixture fetches return in-memory Responses; even SDK-internal sockets are forbidden.
net.Socket.prototype.connect = function () { throw new Error('Real network forbidden'); };
tls.connect = () => { throw new Error('Real TLS forbidden'); };
globalThis.fetch = async () => { throw new Error('Real fetch forbidden'); };
globalThis.WebSocket = class { constructor() { throw new Error('Real WebSocket forbidden'); } };
const sdk = await import(pathToFileURL(join(candidate, 'dist/index.js')).href);
const helper = await import(pathToFileURL(join(candidate, 'dist/utils/provider-failure.js')).href);
const require = createRequire(join(candidate, 'package.json'));
// These dual-published packages select different constructor identities for require/import.
const openai = await import(pathToFileURL(require.resolve('openai/index.mjs')).href);
const anthropic = await import(pathToFileURL(require.resolve('@anthropic-ai/sdk/index.mjs')).href);
const google = await import(pathToFileURL(require.resolve('@google/genai')).href);
const aws = await import(pathToFileURL(require.resolve('@aws-sdk/client-bedrock-runtime')).href);
const modules = Object.fromEntries(await Promise.all(apis.map(async api => [api, await import(pathToFileURL(join(candidate, `dist/api/${api}.js`)).href)])));
const canary = 'TOKEN_ACCOUNT_COOKIE_INSTRUCTION_CANARY';
const context = { messages: [{ role: 'user', content: 'offline fixture', timestamp: 0 }] };
const token = ['e30', Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-fixture-not-account' } })).toString('base64url'), 'fixture'].join('.');
const modelFor = api => ({ id: 'fixture-model', name: 'Offline', api, provider: 'unlisted-fixture', baseUrl: api === 'azure-openai-responses' ? 'https://fixture.openai.azure.com' : 'https://offline.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 });
async function request(api, extra = {}, provider = 'unlisted-fixture') {
  const observed = [], events = [];
  const off = sdk.subscribeProviderFailures(value => observed.push(value));
  try {
    const model = { ...modelFor(api), provider };
    const options = { apiKey: api === 'openai-codex-responses' ? token : 'offline-not-real', maxRetries: 0, transport: 'sse', region: 'us-east-1', env: { AWS_BEDROCK_SKIP_AUTH: '1', AWS_EC2_METADATA_DISABLED: 'true' }, ...extra };
    for await (const event of modules[api].stream(model, context, options)) events.push(event);
  } finally { off(); }
  return { observed, events };
}
const facts = [
  [{ status: 500, message: 'MTMD opaque ' + canary }, 'SERVER'], [{ code: 'server_error' }, 'SERVER'],
  [{ status: 429 }, 'RATE_LIMIT'], [{ status: 429, error: { code: 'insufficient_quota' } }, 'QUOTA'],
  [{ status: 500, code: 'billing_error' }, 'QUOTA'], [{ status: 500, code: 'authentication_error' }, 'AUTH'],
  [{ status: 401 }, 'AUTH'], [{ status: 403 }, 'AUTH'], [{ status: 400 }, 'INVALID_REQUEST'], [{ status: 413 }, 'INVALID_REQUEST'],
  [{ status: 500, cause: { status: 401 } }, 'AUTH'], [{ status: 500, cause: { status: 400 } }, 'INVALID_REQUEST'],
  [{ status: 500, code: 'context_length_exceeded' }, 'CONTEXT_WINDOW_EXCEEDED'],
  [{ status: 500, code: 'content_policy_violation' }, 'INVALID_REQUEST'], [{ status: 500, code: 'invalid_request_error' }, 'INVALID_REQUEST'],
  [{ code: 'timeout_error' }, 'TIMEOUT'], [{ status: 408 }, 'TIMEOUT'], [{ code: 'ECONNRESET' }, 'TRANSPORT'],
  [{ cause: { code: 'ECONNREFUSED' } }, 'TRANSPORT'], [{ name: 'AbortError', status: 500 }, 'ABORTED'],
];
for (const api of apis) for (const [error, code] of facts) test(`${api}: portable ${JSON.stringify(error)} -> ${code}`, () => {
  const result = helper.classifyProviderFailure({ ...error, message: canary, stack: canary, headers: { authorization: canary } }, 'arbitrary-new-provider', api);
  assert.equal(result.code, code); assert.equal(result.provider, 'arbitrary-new-provider'); assert.equal(result.api, api);
  assert(Object.isFrozen(result)); assert(!JSON.stringify(result).includes(canary));
  assert(Object.keys(result).every(k => ['provider','api','code','message','status','requestId','providerRetryAfterMs'].includes(k)));
});
test('capability matrix covers exactly the instrumented API IDs and declares unavailable facts', async () => {
  const matrix=JSON.parse(await readFile('tools/pi-ai-fork/generalized-failure-capabilities.json','utf8'));
  assert.deepEqual(matrix.apis.map(row=>row.api),apis);
  for(const api of ['google-generative-ai','google-vertex'])assert.deepEqual(matrix.apis.find(row=>row.api===api).http,['status from ApiError.status']);
  assert.deepEqual(matrix.apis.find(row=>row.api==='pi-messages').stream,['explicit terminal reason aborted']);
});
test('capability is frozen API instrumentation, not evidence that opaque errors classify', () => {
  assert.equal(sdk.PROVIDER_FAILURE_OBSERVER_VERSION, 1); assert(Object.isFrozen(sdk.PROVIDER_FAILURE_APIS));
  assert.deepEqual([...sdk.PROVIDER_FAILURE_APIS], apis); assert.equal(sdk.subscribeProviderFailures, helper.subscribeProviderFailures);
  for (const api of [...apis, 'future-custom-api']) {
    assert.equal(helper.classifyProviderFailure(new Error('HTTP503 overloaded rate limit MTMD'), 'new-provider', api), undefined);
    assert.equal(helper.classifyProviderFailure({ code: 'unknown_serverish', status: 200 }, 'new-provider', api), undefined);
  }
});
test('own bounded facts, no getter/prototype/coercion execution or secret projections', () => {
  let reads = 0;
  const evil = Object.create({ status: 500, code: 'server_error', name: 'AbortError' });
  for (const key of ['status','code','type','name','payload','error','response','cause','$metadata','headers','requestId','providerRetryAfterMs']) Object.defineProperty(evil, key, { get() { reads++; throw new Error(canary); } });
  assert.equal(helper.classifyProviderFailure(evil, 'p', apis[0]), undefined); assert.equal(reads, 0);
  const cycle = { status: 500 }; cycle.cause = cycle;
  assert.equal(helper.classifyProviderFailure(cycle, 'p', apis[0]).code, 'SERVER');
  const fakeHeaders = { get() { reads++; throw new Error(canary); } };
  assert.equal(helper.classifyProviderFailure({ status: 500, headers: fakeHeaders }, 'p', apis[0]).providerRetryAfterMs, undefined);
  assert.equal(reads, 0);
  assert.deepEqual(helper.codexHttpFailureFacts(500, fakeHeaders, '{}'), { status: 500 }); assert.equal(reads, 0);
  for (const status of ['500', 500.1, Infinity, NaN, 999]) assert.equal(helper.classifyProviderFailure({ status }, 'p', apis[0]), undefined);
});
test('request IDs and hints are validated, detached, finite and timer-safe including zero', () => {
  for (const requestId of ['', '  ', 'x\n', '\u007f', '\u0085', 'x'.repeat(257), 1]) assert.equal(helper.classifyProviderFailure({ status: 500, requestId }, 'p', apis[0]).requestId, undefined);
  const headers = new Headers({ 'retry-after': '3', 'x-request-id': 'fixture-request', 'authorization': canary });
  const error = { status: 500, headers };
  const result = helper.classifyProviderFailure(error, 'p', apis[0]);
  headers.set('x-request-id', canary); error.status = 401;
  assert.equal(result.status, 500); assert.equal(result.requestId, 'fixture-request'); assert.equal(result.providerRetryAfterMs, 3000);
  for (const hint of [-1, Infinity, NaN, 2147483648, '3000']) assert.equal(helper.classifyProviderFailure({ status: 500, providerRetryAfterMs: hint }, 'p', apis[0]).providerRetryAfterMs, undefined);
  for (const hint of [0, 2147483647]) assert.equal(helper.classifyProviderFailure({ status: 500, providerRetryAfterMs: hint }, 'p', apis[0]).providerRetryAfterMs, hint);
  for (const value of ['-1', '+3', 'Infinity', '2147484']) assert.equal(helper.providerRetryAfterMs(new Headers({ 'retry-after': value })), undefined);
  assert.equal(helper.providerRetryAfterMs(new Headers({ 'retry-after': 'Thu, 01 Jan 1970 00:00:05 GMT' }), 1000), 4000);
});
test('known platform timeout/abort classes normalized without arbitrary instance getters', () => {
  assert.equal(helper.classifyProviderFailure(new DOMException(canary, 'AbortError'), 'p', apis[0]).code, 'ABORTED');
  assert.equal(helper.classifyProviderFailure(new DOMException(canary, 'TimeoutError'), 'p', apis[0]).code, 'TIMEOUT');
});
test('Codex public wrappers delegate once, independent subscriptions isolate listener failures', async () => {
  let count = 0; const callback = () => count++;
  const a = sdk.subscribeProviderFailures(callback), b = sdk.subscribeProviderFailures(callback);
  const c = sdk.subscribeProviderFailures(() => { throw new Error(canary); });
  const d = sdk.subscribeProviderFailures(async () => { throw new Error(canary); });
  helper.reportCodexFailure({ status: 500 }, 'openai-codex'); assert.equal(count, 2);
  a(); a(); helper.reportCodexFailure({ status: 500 }, 'openai-codex'); assert.equal(count, 3);
  helper.reportCodexFailure({ status: 500 }, 'other'); assert.equal(count, 3);
  helper.reportProviderFailure(new Error(canary), 'p', apis[0]); assert.equal(count, 3);
  b(); c(); d(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(helper.classifyCodexFailure({ status: 500 }), helper.classifyProviderFailure({ status: 500 }, 'openai-codex', undefined));
});
for (const api of apis) for (const [error, code] of [[{status:500},'SERVER'], [{status:429,code:'insufficient_quota'},'QUOTA'], [{status:500,code:'content_policy_violation'},'INVALID_REQUEST'], [{code:'ECONNRESET'},'TRANSPORT'], [new Error(canary),undefined]]) test(`${api}: actual terminal catch fixture ${code ?? 'unknown'}`, async () => {
  const result = await request(api, { onPayload() { throw error; } });
  assert.equal(result.events.at(-1)?.type, 'error', JSON.stringify(result.events));
  assert.equal(result.observed.length, code ? 1 : 0, JSON.stringify(result.observed));
  if (code) { assert.equal(result.observed[0].code, code); assert.equal(result.observed[0].api, api); assert.equal(result.observed[0].provider, 'unlisted-fixture'); }
});
for (const api of apis) test(`${api}: cancellation beats transient/permanent facts at actual catch`, async () => {
  const controller = new AbortController(); controller.abort();
  const result = await request(api, { signal: controller.signal, onPayload() { throw { status: 500, code: 'billing_error' }; } });
  assert.equal(result.observed.length, 1); assert.equal(result.observed[0].code, 'ABORTED');
});
for (const api of ['openai-completions','openai-responses','azure-openai-responses','anthropic-messages']) {
  const classes = api === 'anthropic-messages' ? anthropic : openai;
  for (const [Class, code] of [[classes.APIConnectionError,'TRANSPORT'],[classes.APIConnectionTimeoutError,'TIMEOUT'],[classes.APIUserAbortError,'ABORTED']]) test(`${api}: known ${Class.name} class boundary -> ${code}`, async () => {
    const result = await request(api, { onPayload() { throw new Class({ message: canary }); } });
    assert.equal(result.observed.length, 1); assert.equal(result.observed[0].code, code);
  });
}
for (const api of apis.filter(api => !['bedrock-converse-stream','google-generative-ai','google-vertex'].includes(api))) for (const [status, body, code] of [
  [500, { error: { message: 'MTMD opaque ' + canary } }, 'SERVER'],
  [429, { error: { code: 'insufficient_quota', message: canary } }, 'QUOTA'],
  [429, { error: { message: canary } }, 'RATE_LIMIT'], [401, { error: { code: 'server_error' } }, 'AUTH'],
  [403, {}, 'AUTH'], [400, {}, 'INVALID_REQUEST'], [413, {}, 'INVALID_REQUEST'],
]) test(`${api}: real HTTP fixture ${status}/${code}`, async () => {
  let calls = 0;
  const result = await request(api, { fetch: async () => { calls++; return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'retry-after': '3', 'x-request-id': 'fixture-request' } }); } });
  assert.equal(calls, 1); assert.equal(result.events.at(-1)?.type, 'error'); assert.equal(result.observed.length, 1, JSON.stringify(result));
  const dto = result.observed[0]; assert.equal(dto.code, code); assert.equal(dto.status, status); assert.equal(dto.providerRetryAfterMs, 3000); assert.equal(dto.requestId, 'fixture-request'); assert(!JSON.stringify(dto).includes(canary));
});
for (const api of ['openai-responses','azure-openai-responses','openai-codex-responses']) for (const [event, code] of [
  [{type:'error',code:'server_error',message:canary},'SERVER'],
  [{type:'response.failed',response:{status:'failed',error:{code:'insufficient_quota',message:canary}}},'QUOTA'],
  [{type:'error',message:'503 overloaded ' + canary},undefined],
]) test(`${api}: SSE machine payload ${code ?? 'unknown'} without invented status`, async () => {
  const result = await request(api, { fetch: async () => new Response(`data: ${JSON.stringify(event)}\n\n`, { status:200,headers:{'content-type':'text/event-stream'} }) });
  assert.equal(result.events.at(-1)?.type,'error'); assert.equal(result.observed.length,code ? 1 : 0);
  if (code) { assert.equal(result.observed[0].code,code); assert.equal(result.observed[0].status,undefined); }
});
test('Anthropic raw SSE typed error survives textual display without inventing HTTP503', async () => {
  const result = await request('anthropic-messages',{fetch:async()=>new Response(`event: error\ndata: ${JSON.stringify({type:'error',error:{type:'overloaded_error',message:canary}})}\n\n`,{headers:{'content-type':'text/event-stream'}})});
  assert.equal(result.observed.length,1); assert.equal(result.observed[0].code,'SERVER'); assert.equal(result.observed[0].status,undefined);
});
for (const api of ['google-generative-ai','google-vertex']) test(`${api}: reviewed ApiError preserves real status but cannot recover opaque named quota or headers`, async () => {
  const result = await request(api,{onPayload(){throw new google.ApiError({status:500,message:'MTMD ' + canary});}});
  assert.equal(result.observed[0].code,'SERVER'); assert.equal(result.observed[0].status,500);
  const quota = await request(api,{onPayload(){throw new google.ApiError({status:429,message:JSON.stringify({error:{code:'insufficient_quota'}})});}});
  assert.equal(quota.observed[0].code,'RATE_LIMIT'); assert.equal(quota.observed[0].requestId,undefined); assert.equal(quota.observed[0].providerRetryAfterMs,undefined);
});
for (const api of ['google-generative-ai','google-vertex']) for (const [status, code] of [[500,'SERVER'],[429,'RATE_LIMIT'],[401,'AUTH'],[403,'AUTH'],[400,'INVALID_REQUEST'],[413,'INVALID_REQUEST']]) test(`${api}: real SDK HTTP ${status} exposes status only, never parses quota from display JSON`, async () => {
  const before = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({error:{code:status,status:'UNKNOWN',message:'MTMD '+canary,details:[{code:'insufficient_quota'}]}}),{status,headers:{'content-type':'application/json','retry-after':'3','x-request-id':'not-exposed-by-sdk'}}); };
  try { const result=await request(api); assert.equal(calls,1); assert.equal(result.observed.length,1); assert.equal(result.observed[0].code,code); assert.equal(result.observed[0].status,status); assert.equal(result.observed[0].requestId,undefined); assert.equal(result.observed[0].providerRetryAfterMs,undefined); }
  finally { globalThis.fetch=before; }
});
test('Bedrock actual send catch and stream exception retain machine category, metadata and correlation, never HTTP200 as error status', async () => {
  const before = aws.BedrockRuntimeClient.prototype.send;
  try {
    aws.BedrockRuntimeClient.prototype.send = async function () { throw new aws.InternalServerException({message:'MTMD '+canary,$metadata:{httpStatusCode:500,requestId:'bedrock-request'}}); };
    const result = await request('bedrock-converse-stream');
    assert.equal(result.observed.length,1); assert.equal(result.observed[0].code,'SERVER'); assert.equal(result.observed[0].status,500); assert.equal(result.observed[0].requestId,'bedrock-request');
    aws.BedrockRuntimeClient.prototype.send = async function () { return {$metadata:{httpStatusCode:200,requestId:'stream-request'},stream:(async function*(){yield {internalServerException:{message:canary}};})()}; };
    const stream = await request('bedrock-converse-stream');
    assert.equal(stream.observed.length,1); assert.equal(stream.observed[0].code,'SERVER'); assert.equal(stream.observed[0].status,undefined); assert.equal(stream.observed[0].requestId,'stream-request');
  } finally { aws.BedrockRuntimeClient.prototype.send = before; }
});
test('pi wire opaque terminal stays unknown while explicit wire cancellation emits exactly once', async () => {
  for (const reason of ['error','aborted']) {
    const result = await request('pi-messages',{fetch:async()=>new Response(`data: ${JSON.stringify({type:'error',reason,errorMessage:'503 overloaded '+canary,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})}\n\n`,{headers:{'content-type':'text/event-stream'}})});
    assert.equal(result.observed.length,reason==='aborted'?1:0); if(reason==='aborted')assert.equal(result.observed[0].code,'ABORTED');
  }
});
test('concurrent terminal callbacks preserve detached provider/API facts; listener layer adds no call context or ordering guesses', async () => {
  const observed=[]; const off=sdk.subscribeProviderFailures(dto=>observed.push(dto));
  try { await Promise.all(apis.map(async(api,index)=>{await Promise.resolve();helper.reportProviderFailure({status:500,requestId:`request-${index}`},`provider-${index}`,api);})); }
  finally { off(); }
  assert.equal(observed.length,10); for(let i=0;i<10;i++)assert(observed.some(dto=>dto.api===apis[i]&&dto.provider===`provider-${i}`&&dto.requestId===`request-${i}`));
});
test('concurrent actual API terminal catches emit one correctly labeled immutable DTO each', async () => {
  const observed=[];const off=sdk.subscribeProviderFailures(dto=>observed.push(dto));
  try { await Promise.all(apis.map(async(api,index)=>{for await(const _event of modules[api].stream({...modelFor(api),provider:`parallel-${index}`},context,{apiKey:api==='openai-codex-responses'?token:'offline-not-real',maxRetries:0,region:'us-east-1',env:{AWS_BEDROCK_SKIP_AUTH:'1',AWS_EC2_METADATA_DISABLED:'true'},async onPayload(){await Promise.resolve();throw {status:500,requestId:`parallel-request-${index}`};}})){} })); }
  finally{off();}
  assert.equal(observed.length,10);for(let i=0;i<10;i++)assert(observed.some(dto=>dto.provider===`parallel-${i}`&&dto.api===apis[i]&&dto.requestId===`parallel-request-${i}`&&Object.isFrozen(dto)));
});
for(const api of ['openai-responses','azure-openai-responses','openai-codex-responses'])test(`${api}: successful terminal emits no failure`,async()=>{
  const result=await request(api,{fetch:async()=>new Response(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:1,output_tokens:0,total_tokens:1}}})}\n\n`,{headers:{'content-type':'text/event-stream'}})});
  assert.equal(result.events.at(-1)?.type,'done');assert.equal(result.observed.length,0);
});
test('reviewed recipe baseline rejects drift; every API has exactly one terminal emitter; compiler/protection manifest is exact', async () => {
  const root=resolve('.dumps/codex-failure-categories-20261013-candidate3/source/packages/ai/src');
  const baseline=JSON.parse(await readFile('tools/pi-ai-fork/generalized-failure-baseline.json','utf8'));
  for(const api of apis){const text=await readFile(join(root,`api/${api}.ts`),'utf8');assert.equal(sha(text),baseline[`api/${api}.ts`]);const patched=patchApi(api,text);assert.equal(patched.split('reportProviderFailure(').length-1,1,api);}
  const shared=patchShared(await readFile(join(root,'api/openai-responses-shared.ts'),'utf8'));assert(shared.includes('{ payload: event }'));assert(!shared.includes('status: 503'));
  const manifest=JSON.parse(await readFile(join(candidate,'../candidate-manifest.json'),'utf8'));
  assert.equal(manifest.generated.length,52);assert.equal(manifest.protectedFiles.length,724);assert.equal(manifest.promoted,false);
  for(const file of manifest.generated)assert.equal(sha(await readFile(join(candidate,file.path))),file.afterSha256);
  for(const file of manifest.protectedFiles){assert.equal(sha(await readFile(join(candidate,file.path))),file.sha256);assert.equal(sha(await readFile(join(manifest.installedRoot,file.path))),file.sha256);}
  for(const file of manifest.sourceFiles)assert.equal(sha(await readFile(join(dirname(candidate),'source/packages/ai',file.path))),file.afterSha256);
});
