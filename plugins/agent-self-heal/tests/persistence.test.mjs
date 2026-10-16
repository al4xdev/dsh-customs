import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { INITIAL_STATE, POLICY_VERSION, PROJECTION_KEY, AUDIT_EVENT, AUDIT_VERSION, decide, foldState, transition, warned } from '../logic.mjs';
import { createController } from '../../llm-resilience/controller.mjs';
import { installMainDriver } from '../../llm-resilience/main-driver.mjs';
import { policyKey, UNBOUNDED_RETRIES } from '../../llm-resilience/policy.mjs';
import { ACCOUNTING_KEY, recoveryBudget } from '../../llm-resilience/recovery-accounting.mjs';

// Pin the backend and its dependencies to the installation the bridge patches
// (same location rule as the dsh launcher: XDG_DATA_HOME, else ~/.local/share).
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
const hostRequire = createRequire(join(dataHome, 'dsh-cli/package.json'));
const host = id => import(pathToFileURL(hostRequire.resolve(`@deepseek-ai/${id}`)).href);
if (process.argv[2] === '--self-heal-original-guard') {
  // Serve exact backed-up bytes at the original module URL: dependencies still
  // resolve from the host install, with no SDK writes or runtime catalog mutation.
  const original = await readFile(process.argv[3], 'utf8');
  const sessionUrl = pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-session')).href;
  registerHooks({ load(url, context, nextLoad) {
    return url === sessionUrl ? { format: 'module', source: original, shortCircuit: true } : nextLoad(url, context);
  } });
}
const { Context } = await host('cordis');
const { Session, KNOWN_SESSION_EVENT_TYPES } = await host('dsh-session');
const { default: Jsonl } = await host('dsh-session-persistence-jsonl');
const { default: Projections } = await host('dsh-session-projection');
const { validateStoredEvents, SessionFormatUnsupportedError, SessionReadOnlyError } = await host('dsh-session-persistence');
const selfHeal = await import(process.env.SELF_HEAL_PLUGIN_MODULE
  ? pathToFileURL(process.env.SELF_HEAL_PLUGIN_MODULE).href : new URL('../index.mjs', import.meta.url).href);
const { assertPersistenceCompatible, assertAuditReadable } = await import('../persistence.mjs');
const exec = promisify(execFile);
const here = fileURLToPath(import.meta.url);
const scratch = fileURLToPath(new URL('../../../.dumps/self-heal-persistence-20261013/', import.meta.url));
const facts = { code: 'PI_AI_ERROR', summary: 'fixture failure' };
const position = { turn: 1, step: 1 };
const initial = () => ({ ...INITIAL_STATE, policyVersion: POLICY_VERSION });
const digest = value => createHash('sha256').update(value).digest('hex');

function installOwner(ctx) {
  // Detached restores never emit live agent events, so no agent/provider is needed.
  const controller = createController();
  installMainDriver(ctx, controller);
  ctx.provide('llmRecoveryUnbounded', controller);
  ctx.effect(() => () => controller.dispose());
  selfHeal.apply(ctx, { maxCycles: 10 });
  return controller;
}

function unboundedFixture() {
  // Policy-3 / payload-2 history: one warned unbounded chain far beyond ten.
  const id = randomUUID();
  const session = Session.create(id, undefined, { version: 4, id, createdAt: 0, isSeeded: false });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', position);
  let state = initial();
  const policy = { ...createController().policyFor('fixture'), maxRetries: UNBOUNDED_RETRIES };
  for (let cycle = 1; cycle <= 14; cycle++) {
    const attempt = session.append('assistant/attempt', { ...position, stream: [] });
    const reserved = decide(state, position, attempt.seq, { code: 'TRANSPORT' }, UNBOUNDED_RETRIES, false, true).state;
    session.append(AUDIT_EVENT, { version: AUDIT_VERSION, action: 'reserved', ...position, causalSeq: attempt.seq, state: reserved,
      recoveryOwnership: { version: 2, kind: 'unified-agent-warning', origin: position, provider: 'fixture', retryId: 'unbounded-fixture',
        policyKey: policyKey(policy), retry: cycle, mirrorRetry: cycle, legacyNativeConsumed: 0, legacySemanticConsumed: 0, importedConsumed: 0 } });
    state = reserved;
    if (cycle === 1) {
      const message = session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'self-heal-observation' },
        content: [{ type: 'text', text: 'harness warning: fixture' }] }, { surfaceOp: 'append', sourceEventSeqs: [attempt.seq] });
      state = { ...state, chain: warned({ ...state.chain, status: 'admitted' }, 'TRANSPORT', message.data.id, message.seq) };
      session.append(AUDIT_EVENT, { version: AUDIT_VERSION, action: 'observation-admitted', ...position, causalSeq: attempt.seq, state });
    }
    // The native llm/retry UI mirror needs a real request/header; the durable
    // owner/accounting provenance under test lives in the audits alone.
    state = transition(state, 'retry-requested');
    session.append(AUDIT_EVENT, { version: AUDIT_VERSION, action: 'retry-requested', ...position, causalSeq: attempt.seq, state });
  }
  const events = session.snapshotEvents();
  return { header: session.header, events, state: events.reduce(foldState, initial()) };
}

function fixture(kind) {
  if (kind === 'unbounded-v2') return unboundedFixture();
  const reservedOnly = kind.endsWith('reserved');
  const unified = kind === 'unified-reserved';
  const id = randomUUID();
  const session = Session.create(id, undefined, { version: 4, id, createdAt: 0, isSeeded: false });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', position);
  let state = initial();
  const audit = (action, next, attemptSeq) => {
    const ownership = unified && action === 'reserved' ? {
      version: 1, kind: 'unified-agent-warning', origin: position, provider: 'fixture', retryId: 'unified-fixture',
      policyKey: policyKey({ ...createController().policyFor('fixture'), maxRetries: 3 }), retry: next.chain.cycle,
      legacyNativeConsumed: 0, legacySemanticConsumed: 0, importedConsumed: 0,
    } : undefined;
    session.append(AUDIT_EVENT, { version: 1, action, ...position, causalSeq: attemptSeq, state: next,
      ...(ownership ? { recoveryOwnership: ownership } : {}) });
    state = next;
  };
  for (let cycle = 1; cycle <= (reservedOnly ? 1 : 3); cycle++) {
    const attempt = session.append('assistant/attempt', { ...position, stream: [] });
    const decision = decide(state, position, attempt.seq, facts, 3);
    assert.equal(decision.kind, 'heal');
    audit('reserved', decision.state, attempt.seq);
    if (reservedOnly) break;
    const message = session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'self-heal-observation' },
      content: [{ type: 'text', text: `fixture cycle ${cycle}` }] }, { surfaceOp: 'append', sourceEventSeqs: [attempt.seq] });
    audit('observation-admitted', transition(state, 'admitted', { messageId: message.data.id, observationSeq: message.seq }), attempt.seq);
    audit('retry-requested', transition(state, 'retry-requested'), attempt.seq);
  }
  if (!reservedOnly) {
    const attempt = session.append('assistant/attempt', { ...position, stream: [] });
    const decision = decide(state, position, attempt.seq, facts, 3);
    assert.equal(decision.kind, 'suspended');
    audit('suspended', decision.state, attempt.seq);
  }
  const events = session.snapshotEvents();
  return { header: session.header, events, state: events.reduce(foldState, initial()) };
}

async function freshReader(input) {
  const { stdout, stderr } = await exec(process.execPath, [here, '--self-heal-read', JSON.stringify(input)], {
    timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(stderr, '', 'fresh reader must not report background errors');
  return JSON.parse(stdout);
}

async function readInFreshProcess(input) {
  globalThis.fetch = () => { throw new Error('Network forbidden in cold reader'); };
  globalThis.WebSocket = class { constructor() { throw new Error('Network forbidden in cold reader'); } };
  const ctx = new Context();
  let handle;
  try {
    const backend = new Jsonl(ctx, { root: input.root, compression: input.compression });
    new Projections(ctx);
    // Fail immediately if a future implementation tries to acquire write ownership.
    backend.acquireLease = () => { throw new Error('read-only probe attempted write ownership'); };
    const originalOpen = backend.open.bind(backend);
    backend.open = (id, access, options) => {
      assert.equal(access, 'read');
      return originalOpen(id, access, options);
    };
    handle = await backend.open(input.id, 'read');
    assert.equal(handle.access, 'read');
    // These backend seams must not be reached even during close/teardown.
    handle.append = () => { throw new Error('read-only probe attempted append'); };
    handle.flush = () => { throw new Error('read-only probe attempted flush'); };
    const slice = await handle.read();
    const beforeOwner = slice.events.filter(event => event.type === AUDIT_EVENT).length;
    const session = Session.fromRestore(input.id, slice.events, handle.header, handle.inheritedEventCount, slice.eventState);
    assert.equal(ctx.sessionProjections.stateOf(session, PROJECTION_KEY), undefined);
    const controller = installOwner(ctx);
    const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
    const expected = slice.events.reduce((value, event) => {
      assertAuditReadable(event, selfHeal.stateSchema);
      return foldState(value, event);
    }, initial());
    assert.deepEqual(state, expected, 'late owner registration folds the full stored log');
    selfHeal.stateSchema.parse(state);
    assert.equal(slice.events.filter(event => event.type === AUDIT_EVENT).length, beforeOwner);
    // Restoring a detached Session may add an in-memory end-seed marker. The
    // original durable prefix must nevertheless remain exactly unchanged.
    assert.deepEqual(session.snapshotEvents(0, slice.events.length), slice.events);
    const accounting = ctx.sessionProjections.stateOf(session, ACCOUNTING_KEY);
    const provider = input.provider ?? 'fixture';
    const budget = recoveryBudget(state, accounting, ctx.sessionProjections.stateOf(session, 'llmRetry'), controller.policyFor(provider), provider);
    return { count: slice.events.length, auditCount: beforeOwner, eventHash: digest(JSON.stringify(slice.events)),
      state, dedupe: state.seen ? decide(state, position, state.seen.attemptSeq, facts, 10).kind : undefined,
      next: decide(state, { turn: 99, step: 1 }, slice.events.length + 100, facts, 10).kind,
      access: handle.access, accounting, budget,
      unifiedCanRetry: Boolean(controller.plan({ provider, failure: { code: 'SERVER' }, previousRetry: budget.consumed, policy: budget.policy })) };
  } finally {
    await handle?.close();
    await ctx.fiber.dispose();
  }
}

async function directoryFingerprint(directory) {
  const entries = await readdir(directory);
  const result = {};
  for (const name of entries.sort()) {
    const path = join(directory, name);
    const info = await stat(path);
    assert.ok(info.isFile(), 'native session directory must contain only files');
    result[name] = { bytes: info.size, mtimeMs: info.mtimeMs, hash: digest(await readFile(path)) };
  }
  return result;
}

if (process.argv[2] === '--self-heal-original-guard') {
  assert.equal(KNOWN_SESSION_EVENT_TYPES.has(AUDIT_EVENT), false);
  assert.throws(assertPersistenceCompatible, /cannot reopen required agent\/self-heal/);
  let registrations = 0;
  const untouched = {
    // A contract-3 controller is present, so the refusal under test is the missing
    // persistence bridge, not the controller check that runs first.
    get() { return { recoveryVersion: 3, recoveryHistoryVersion: 3, schedule() {} }; },
    sessionProjections: { register() { registrations++; } },
    on() { registrations++; }, effect() { registrations++; },
  };
  assert.throws(() => selfHeal.apply(untouched), /cannot reopen required agent\/self-heal/);
  assert.equal(registrations, 0, 'incompatible SDK refuses before any projection, hook or audit');
  process.stdout.write(JSON.stringify({ refusedBeforeRegistration: true }));
} else if (process.argv[2] === '--self-heal-read') {
  const result = await readInFreshProcess(JSON.parse(process.argv[3]));
  process.stdout.write(JSON.stringify(result));
} else {
  test('exact original SDK backup refuses plugin before hooks/projection registration', async t => {
    const original = process.env.SELF_HEAL_ORIGINAL_SESSION_INDEX
      ?? join(dataHome, 'dsh-customs-backups/self-heal-persistence-task50/session-index.js');
    try { await stat(original); } catch (error) {
      if (error.code === 'ENOENT') { t.skip('original SDK backup absent; set SELF_HEAL_ORIGINAL_SESSION_INDEX'); return; }
      throw error;
    }
    const { stdout, stderr } = await exec(process.execPath, [here, '--self-heal-original-guard', original], {
      timeout: 30000, maxBuffer: 1024 * 1024,
    });
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), { refusedBeforeRegistration: true });
  });

  test('installed bridge recognizes only self-heal, not arbitrary required extensions', () => {
    assertPersistenceCompatible();
    assert.ok(KNOWN_SESSION_EVENT_TYPES.has(AUDIT_EVENT));
    const header = { version: 4, id: 'catalog-probe', createdAt: 0 };
    assert.throws(() => validateStoredEvents(header, [{ type: 'fixture/unknown-required', seq: 0, time: 0, data: {} }]), SessionFormatUnsupportedError);
  });

  test('required owner audits refuse unknown protocol versions, actions and invalid state', () => {
    const event = { type: AUDIT_EVENT, data: { version: 1, action: 'observed', state: initial() } };
    assert.doesNotThrow(() => assertAuditReadable(event, selfHeal.stateSchema));
    // Payload 1 (old) and 2 (policy 3) are readable; anything newer refuses.
    assert.doesNotThrow(() => assertAuditReadable({ ...event, data: { ...event.data, version: 2 } }, selfHeal.stateSchema));
    for (const change of [{ version: 3 }, { action: 'unknown-action' }, { state: { lastHealthyTurn: 0, hiddenBudget: 10 } }, { state: { lastHealthyTurn: 0, policyVersion: 4 } }]) {
      assert.throws(() => assertAuditReadable({ ...event, data: { ...event.data, ...change } }, selfHeal.stateSchema));
    }
  });

  test('read handle rejects mutations before any filesystem operation', async () => {
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(join(scratch, 'readonly-'));
    const ctx = new Context();
    let writer, reader;
    try {
      const backend = new Jsonl(ctx, { root, compression: 'zstd' });
      writer = await backend.create({ version: 4, id: randomUUID(), createdAt: 0, isSeeded: false });
      await writer.flush();
      const id = writer.id;
      await writer.close();
      reader = await backend.open(id, 'read');
      await assert.rejects(reader.append([{ type: 'session/end-seed', seq: 0, time: 0, data: {} }]), SessionReadOnlyError);
      await assert.rejects(reader.flush(), SessionReadOnlyError);
    } finally {
      await reader?.close();
      await writer?.close();
      await ctx.fiber.dispose();
    }
  });

  for (const compression of ['none', 'zstd']) for (const kind of ['reserved', 'exhausted', 'unified-reserved', 'unbounded-v2']) {
    test(`${compression}: real filesystem ${kind} roundtrip across fresh process and absent/late owner`, async () => {
      await mkdir(scratch, { recursive: true });
      const root = await mkdtemp(join(scratch, `${compression}-${kind}-`));
      const source = fixture(kind);
      const ctx = new Context();
      let handle;
      let path;
      try {
        const backend = new Jsonl(ctx, { root, compression });
        new Projections(ctx);
        installOwner(ctx);
        handle = await backend.create(source.header);
        await handle.append(source.events);
        await handle.flush();
        path = backend.locate(source.header).path;
        await handle.close();
      } finally {
        await handle?.close();
        await ctx.fiber.dispose();
      }
      assert.ok(path.endsWith(compression === 'zstd' ? '.jsonl.zstd' : '.jsonl'));
      const before = digest(await readFile(path));
      const loaded = await freshReader({ root, compression, id: source.header.id });
      assert.equal(loaded.access, 'read');
      assert.equal(loaded.count, source.events.length);
      if (kind === 'unbounded-v2') {
        assert.equal(loaded.auditCount, 29); assert.deepEqual(loaded.state, source.state);
        assert.equal(loaded.state.chain.cycle, 14); assert.equal(loaded.state.chain.maxCycles, UNBOUNDED_RETRIES); assert.equal(loaded.state.chain.warnedCode, 'TRANSPORT');
        assert.equal(loaded.accounting.ownership.retry, 14); assert.equal(loaded.accounting.unsafe, false);
        assert.equal(loaded.budget.consumed, 14); assert.equal(loaded.budget.cap, UNBOUNDED_RETRIES); assert.equal(loaded.unifiedCanRetry, true);
        assert.equal(digest(await readFile(path)), before);
        return;
      }
      assert.equal(loaded.auditCount, kind.endsWith('reserved') ? 1 : 10);
      assert.equal(loaded.eventHash, digest(JSON.stringify(source.events)), 'all audits, messages and causal sequences survive');
      assert.deepEqual(loaded.state, source.state);
      assert.equal(loaded.dedupe, 'duplicate');
      assert.equal(loaded.state.chain.maxCycles, 3);
      assert.equal(loaded.state.chain.cycle, kind.endsWith('reserved') ? 1 : 3);
      assert.equal(loaded.next, kind.endsWith('reserved') ? 'heal' : 'suspended', 'config10 must not refund cap3');
      if (kind === 'unified-reserved') assert.equal(loaded.accounting.ownership.retryId, 'unified-fixture', 'additive ownership survives real stored replay');
      assert.equal(digest(await readFile(path)), before);
    });
  }

  test('native task84 read-only load, full owner replay, original artifact hashes unchanged', {
    skip: process.env.SELF_HEAL_NATIVE_TASK84 !== '1', timeout: 180000,
  }, async t => {
    // Opt-in only (never in regular runs): the original task84 session location.
    const root = process.env.SELF_HEAL_TASK84_ROOT ?? join(homedir(), '.dsh/sessions');
    const id = 'e8d530cf-b66a-46c9-82f2-272317e6f0ce';
    const directory = resolve(root, process.env.SELF_HEAL_TASK84_WORKSPACE ?? '--home-alex-git-my-alex-tavern--', id);
    const before = await directoryFingerprint(directory);
    let loaded;
    try {
      loaded = await freshReader({ root, compression: 'zstd', id });
    } finally {
      assert.deepEqual(await directoryFingerprint(directory), before, 'no log, lock, sidecar or generation changed');
    }
    assert.equal(loaded.access, 'read');
    assert.equal(loaded.auditCount, 23);
    assert.ok(loaded.count > 6976);
    assert.equal(loaded.dedupe, 'duplicate');
    t.diagnostic(JSON.stringify({ count: loaded.count, auditCount: loaded.auditCount, eventHash: loaded.eventHash,
      originalFiles: before, state: loaded.state, nextWithConfig10: loaded.next }));
  });
}
