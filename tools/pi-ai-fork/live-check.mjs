#!/usr/bin/env node
// Opt-in, two-call check. No profile, real session, or credential writer is mounted.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { describeArtifact, officialRootDefault, repo } from './runtime.mjs';
import { useLegacyCodex } from '../../plugins/grammar-fix/live-auth.mjs';

const target = { provider: 'openai-codex', model: 'gpt-6.1-sol' };
const fail = (code) => Object.assign(new Error(code), { code });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safeCode = (error) => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'LIVE_CHECK_FAILED';

// Restrict the credential plane to one detached record. Reject BEFORE invoking
// mutate: pi-ai's OAuth refresh network call lives inside that callback.
export function snapshotProvider(CredentialProvider, key, record) {
  return class ReadOnlySnapshot extends CredentialProvider {
    async resolve() { return undefined; }
    async describe() { return { configured: false, writable: false }; }
    async readRecord(address) { return address === key ? structuredClone(record) : undefined; }
    async describeRecord(address) {
      return { configured: address === key && !!record, writable: false, ...(address === key && record ? { kind: record.kind } : {}) };
    }
    async listRecords() { return record ? [{ key, kind: record.kind }] : []; }
    async set() { throw fail('CREDENTIALS_READ_ONLY'); }
    async unset() { throw fail('CREDENTIALS_READ_ONLY'); }
    async modifyRecord() { throw fail('CREDENTIALS_READ_ONLY'); }
    async deleteRecord() { throw fail('CREDENTIALS_READ_ONLY'); }
  };
}

async function readSnapshot(load, filename, key) {
  let bytes;
  try {
    assert.equal((await stat(filename)).mode & 0o077, 0);
    bytes = await readFile(filename);
  } catch (error) { if (error.code === 'ENOENT') return {}; throw fail('CREDENTIAL_SNAPSHOT_FAILED'); }
  const { parseDocument } = await load('yaml');
  const doc = parseDocument(bytes.toString('utf8'), { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length) throw fail('CREDENTIAL_SNAPSHOT_INVALID');
  const root = doc.toJS();
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw fail('CREDENTIAL_SNAPSHOT_INVALID');
  // A recognized old flat reference layout contains no current OAuth record.
  // Interpret it in memory; never invoke credentials-local's startup migration.
  if (root.version === undefined) {
    if (!Object.entries(root).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string' && v)) throw fail('CREDENTIAL_SNAPSHOT_INVALID');
  } else if (root.version !== 1) throw fail('CREDENTIAL_SNAPSHOT_INVALID');
  return { record: root.version === 1 ? root.records?.[key] : undefined, hash: digest(bytes) };
}

function validGrant(record) {
  const grant = record?.payload;
  if (record?.kind !== 'grant' || grant?.type !== 'oauth' || !['access', 'refresh', 'accountId'].every((key) => typeof grant[key] === 'string' && grant[key])) throw fail('CODEX_GRANT_REQUIRED');
  if (!Number.isFinite(grant.expires) || grant.expires <= Date.now() + 300_000) throw fail('CODEX_AUTH_EXPIRED');
}

async function run({ artifact, officialRoot = officialRootDefault, live = false }) {
  const info = await describeArtifact(artifact, officialRoot);
  const receipt = JSON.parse(await readFile(join(info.runtime, 'runtime.json'), 'utf8'));
  assert.equal(receipt.runtimeHash, info.runtimeHash);
  const verification = JSON.parse(await readFile(join(info.runtime, 'verification.json'), 'utf8'));
  // The runtime builder's router proof must exist; never install or repair here.
  assert.equal(verification.runtime, info.runtime);
  assert.equal(verification.artifactHash, info.artifactHash);
  assert.equal(verification.adapterUnchanged, true);
  assert.equal(verification.lockHash, digest(await readFile(join(info.runtime, 'package-lock.json'))));
  for (const proof of [verification.native, verification.router]) {
    assert.ok(proof.peers.every((peer) => peer.namespaceIdentity === true));
    assert.ok(proof.codex.implementationURL.startsWith(pathToFileURL(`${info.runtime}/`).href));
    assert.equal(proof.codex.networkAttempts, 0);
  }
  const require = createRequire(join(info.officialRoot, '../package.json'));
  const load = async (id) => import(pathToFileURL(require.resolve(id)).href);
  const adapterRequire = createRequire(join(info.runtime, 'package.json'));
  const adapterPath = adapterRequire.resolve('@deepseek-ai/dsh-llm-pi-ai');
  assert.ok((await realpath(adapterPath)).startsWith(`${info.runtime}/`));
  const [{ Context }, llm, { CredentialProvider }, sessions, compaction, adapter] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-credentials'),
    load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-compaction-basic'), import(pathToFileURL(adapterPath).href),
  ]);
  const key = adapter.recordKeyFor(target.provider);
  const home = join(homedir(), '.dsh');
  const filename = join(home, '.credentials.yaml');
  const snapshot = live ? await readSnapshot(load, filename, key) : {};
  const ctx = new Context();
  let handle;
  let restoreLegacy = () => {};
  const report = { live, passed: false, calls: 0, omittedEffortPayloads: 0 };
  const dump = join(repo, '.dumps/pi-ai-fork', `live-${randomUUID()}`);
  const originalFetch = globalThis.fetch;
  try {
    await ctx.plugin(snapshotProvider(CredentialProvider, key, snapshot.record));
    if (live) {
      restoreLegacy = await useLegacyCodex(ctx.credentials, key, join(home, 'dsh-auth/credentials.json'));
      validGrant(await ctx.credentials.readRecord(key));
    }
    // A fail-closed network boundary also prevents accidental OAuth refresh,
    // model discovery, or more than the two authorized paid requests.
    globalThis.fetch = async (input, init) => {
      if (!live) throw fail('OFFLINE_NETWORK_BLOCKED');
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== 'https://chatgpt.com' || url.pathname !== '/backend-api/codex/responses' || report.calls >= 2) throw fail('UNEXPECTED_NETWORK_BLOCKED');
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      let body = init?.body ?? new Uint8Array(await input.clone().arrayBuffer());
      if (headers.get('content-encoding') === 'zstd') body = zstdDecompressSync(body);
      const payload = JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
      assert.equal(payload.model, target.model);
      assert.equal(payload.reasoning?.effort, undefined);
      assert.equal(payload.stream, true);
      report.calls++;
      report.omittedEffortPayloads++;
      return originalFetch(input, init);
    };
    await ctx.plugin(llm.default);
    for (const id of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools', 'dsh-token-meter', 'dsh-agent-loop']) {
      await ctx.plugin((await load(`@deepseek-ai/${id}`)).default, id === 'dsh-agent-loop' ? { agents: [], maxParallelToolCalls: 1 } : {});
    }
    await ctx.plugin(adapter, { providers: { [target.provider]: {
      transport: 'sse', timeoutMs: 120_000, streamIdleTimeoutMs: 120_000,
      retryPolicy: { mode: 'normal', maxRetries: 0 },
    } } });
    await ctx.plugin(compaction.BasicCompactionEngine, {
      auto: false, maxTokens: 8192, compactionRetries: 0, maxOverflowRetries: 0,
      summarizationProvider: target.provider, summarizationModel: target.model,
    });
    const modelInfo = await ctx.llm.resolveModelInfo(target.provider, target.model, AbortSignal.timeout(120_000));
    assert.ok(modelInfo);
    const sessionId = sessions.SessionId(`pi-fork-synthetic-${randomUUID()}`);
    const events = [];
    let flushes = 0;
    ctx.on('session/event', (session, event) => { if (session.id === sessionId) events.push(event); });
    // Minimal local durability listener: fsync the complete synthetic log before
    // acknowledging the official compactNow flush barrier. No provider output
    // from the short probe or private history is added to this log.
    ctx.on('session/flush', async (session) => {
      if (session.id !== sessionId) throw fail('NON_SYNTHETIC_SESSION_BLOCKED');
      const file = await open(join(dump, 'synthetic-session.json'), 'w', 0o600);
      try { await file.writeFile(JSON.stringify({ header: session.header, events })); await file.sync(); } finally { await file.close(); }
      const directory = await open(dump, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      flushes++;
    });
    handle = await ctx.agents.create({ sessionId, agentOptions: { ...target, maxTokens: 8192 }, meta: { cwd: dump } });
    assert.equal(handle.agent.status, 'idle');
    const user = (text) => llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
    for (let i = 0; i < 12; i++) handle.agent.session.append('user/message', user(
      `Synthetic fixture ${i}. Objective: keep the blue widget enabled. Decision: use port 4321. Next task: add a unit test.\n` +
      'Repeated synthetic progress: blue widget enabled, port 4321, unit test pending.\n'.repeat(160)), { surfaceOp: 'append' });
    const before = ctx.tokenMeter.measure(handle.agent.session).totalTokens;
    report.beforeTokens = before;
    if (!live) {
      report.passed = before > 20_000 && handle.agent.status === 'idle';
      return report;
    }
    await mkdir(dump, { recursive: true, mode: 0o700 });
    const probe = new llm.BlockAssembler();
    for await (const chunk of ctx.llm.stream({ ...target, messages: [user('Reply only OK. This is a synthetic integration probe.')], maxTokens: 4096, signal: AbortSignal.timeout(120_000) })) probe.push(chunk);
    if (probe.finish.kind !== 'stop') {
      report.probeFinishCode = safeCode(probe.finish.failure);
      throw fail(report.probeFinishCode);
    }
    if (!probe.blocks().some((block) => block.type === 'text' && block.text.trim())) throw fail('SHORT_PROBE_EMPTY');
    report.probePassed = true;
    // compactNow itself takes the official runMaintenance reservation. Calling
    // it inside a second reservation would incorrectly test a busy agent.
    const result = await ctx.compaction.compactNow(handle.agent, AbortSignal.timeout(120_000));
    assert.ok(result);
    assert.equal(handle.agent.status, 'idle');
    const after = ctx.tokenMeter.measure(handle.agent.session).totalTokens;
    const stored = JSON.parse(await readFile(join(dump, 'synthetic-session.json'), 'utf8'));
    assert.deepEqual(stored.events, events);
    assert.ok(stored.events.some((event) => event.type === 'compaction/summary'));
    assert.equal(stored.events.filter((event) => event.type === 'compaction/start').length, 1);
    assert.equal(stored.events.filter((event) => event.type === 'compaction/end').length, 1);
    const restored = sessions.Session.create(sessionId, stored.events, stored.header, undefined, ctx.sessions.messageProjections);
    assert.deepEqual(restored.deriveMessages(), handle.agent.session.deriveMessages());
    assert.ok(restored.deriveMessages().some((message) => message.content.some((block) => block.type === 'text' && block.text.includes('<compacted-summary>'))));
    assert.ok(after < before / 2);
    assert.ok(flushes > 0);
    assert.equal(report.calls, 2);
    Object.assign(report, { passed: true, compactNowPassed: true, afterTokens: after, flushes, durableReplayPassed: true });
    return report;
  } catch (error) {
    report.passed = false;
    report.code = safeCode(error);
    throw Object.assign(fail(report.code), { safeReport: report });
  } finally {
    globalThis.fetch = originalFetch;
    await handle?.dispose();
    restoreLegacy();
    await ctx.fiber.dispose();
    if (snapshot.hash) assert.equal(digest(await readFile(filename)), snapshot.hash);
    if (live) {
      await mkdir(dump, { recursive: true, mode: 0o700 });
      await writeFile(join(dump, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    }
  }
}

export async function runLiveCheck(runtimeRoot, { live = false } = {}) {
  const root = await realpath(runtimeRoot);
  assert.ok(root.startsWith(`${join(repo, '.dumps/pi-ai-fork')}/runtime-`));
  const receipt = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
  const info = await describeArtifact(receipt.artifact, receipt.officialRoot);
  assert.equal(info.runtime, root);
  const reportPath = join(root, 'live-report.json');
  if (live) await writeFile(reportPath, `${JSON.stringify({ live: true, passed: false, code: 'RUNNING' })}\n`, { mode: 0o600 });
  let report;
  try { report = await run({ artifact: receipt.artifact, officialRoot: receipt.officialRoot, live }); }
  catch (error) { report = error.safeReport ?? { live, passed: false, code: safeCode(error) }; }
  if (live) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const live = process.argv.includes('--live');
  const artifact = process.argv.find((arg) => arg.endsWith('.tgz'));
  try {
    if (!artifact || (!live && !process.argv.includes('--preflight'))) throw fail('OPT_IN_REQUIRED');
    const info = await describeArtifact(artifact);
    const report = await runLiveCheck(info.runtime, { live });
    console.log(JSON.stringify(report));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ passed: false, code: safeCode(error) }));
    process.exitCode = 1;
  }
}
