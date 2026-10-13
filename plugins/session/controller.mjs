import { randomUUID } from 'node:crypto';
import { parseRequest, cursorCodec, boundedPage, previewEvent, publicHeader, redact, OPERATIONS, DEFAULT_BYTES, MAX_BYTES } from './contracts.mjs';
import { discoverTargets, DEFAULT_ROOT } from './discovery.mjs';
import { persistedEventCount } from './tail.mjs';

const absentBridge = { discoverBridges: async () => ({ bridges: [], errors: ['unavailable'] }) };
export function createController(ctx, options = {}) {
  const codec = cursorCodec();
  const bridge = options.bridge ?? absentBridge;
  const resume = options.resume;
  const discover = signal => discoverTargets(ctx, bridge, { root: options.root ?? DEFAULT_ROOT, ledgerPath: options.ledgerPath, signal });
  const revisionOf = (id, revision) => codec.revision([id, revision]);
  const capabilities = target => ({ read: true, send: Boolean(target?.agent || target?.record), resume: resume && !(target?.agent || target?.record) ? 'verified-checkpoint-preflight-required' : false, sendBoundary: 'next-turn', approval: 'allowed-once-only' });

  async function execute(raw, exec) {
    const args = parseRequest(raw);
    const { signal } = exec;
    signal?.throwIfAborted();
    const base = { operation: args.operation, observedAt: new Date().toISOString(), untrustedData: true };
    if (args.operation === 'help') return { ...base, operations: OPERATIONS, limits: { defaultBytes: DEFAULT_BYTES, maxBytes: MAX_BYTES, maxEvents: 100 }, capabilities: { persistenceReadOnly: true, liveLookup: 'local registry or validated bridge', send: 'per-target; native human allowed-once approval required', resume: resume ? 'verified-origin-headless-only; native approval required' : false }, limitations: ['Silence, mtime, stale inject servers and a live ledger PID do not prove a stuck or live session.', 'Only bounded text previews and event metadata; no tool payloads, attachment bodies, secrets files or complete log dumps.', 'Cold resume requires a host-signed origin checkpoint and unchanged current profile/model/policies/tool catalog; unavailable for old sessions without provenance or incompatible TUI composition. No companion fallback or lock takeover.', 'Cursors/revisions are scoped to this plugin instance; restart invalidates cursors.', 'Preview redaction is best effort, not a guarantee that historical user text contains no sensitive information.'] };
    if (args.operation === 'resume') return resumeSession(args, exec, base);
    if (args.operation === 'list') {
      const snapshots = await ctx.sessionPersistence.list({ signal });
      const live = await discover(signal);
      const rows = new Map(snapshots.map(snapshot => [snapshot.header.id, { header: publicHeader(snapshot.header), revision: revisionOf(snapshot.header.id, snapshot.revision), ...(snapshot.eventCount === undefined ? {} : { eventCount: snapshot.eventCount }) }]));
      for (const [id, target] of live.targets) if (!rows.has(id)) rows.set(id, { header: publicHeader(target.header ?? { id }) });
      let all = [...rows.values()].map(row => {
        const target = live.targets.get(row.header.id);
        return { ...row, state: target?.state ?? 'unknown', source: target?.source ?? 'persistence', evidence: target?.evidence ?? ['stored log is not live or ended lifecycle proof'], capabilities: capabilities(target), ...(target?.status ? { status: target.status } : {}) };
      });
      all = all.filter(row => (!args.project || row.header.cwd === args.project) && (!args.state || row.state === args.state)).sort((a, b) => String(a.header.id).localeCompare(String(b.header.id)));
      const revision = codec.revision(all);
      const cursorId = `list:${args.project ?? ''}:${args.state ?? ''}`;
      const cursor = args.cursor ? codec.decode(args.cursor, cursorId) : { offset: 0 };
      if (cursor.revision && cursor.revision !== revision) return { ...base, source: 'persistence+live-discovery', code: 'cursor_stale', restartRequired: true, revision };
      const offset = cursor.offset;
      const selected = all.slice(offset, offset + args.limit);
      return boundedPage({ ...base, source: 'persistence+live-discovery', revision, warnings: live.warnings, total: all.length, hasMore: offset + selected.length < all.length }, selected, 'sessions', args.maxBytes, used => offset + used < all.length ? codec.encode({ id: cursorId, offset: offset + used, revision }) : null);
    }
    if (args.operation === 'send') return send(args, exec, base);
    const snapshot = await ctx.sessionPersistence.stat(args.sessionId, { signal });
    if (!snapshot) return { ...base, code: 'not_found', sessionId: args.sessionId, source: 'persistence' };
    const revision = revisionOf(args.sessionId, snapshot.revision);
    const cursor = args.cursor ? codec.decode(args.cursor, args.sessionId) : { offset: 0 };
    // A continuation cursor is never bypassed by an unchanged revision: pages
    // remaining in the same revision still have to be consumed.
    if (args.operation === 'read' && !args.cursor && args.revision === revision) return { ...base, sessionId: args.sessionId, source: 'persistence', revision, unchanged: true, events: [], nextCursor: null, truncated: false };
    let offset = cursor.offset;
    let queryCut;
    if (args.operation === 'inspect' && ctx.sessionQuery?.observeSession) {
      const observation = await ctx.sessionQuery.observeSession(args.sessionId, { signal, projectionMode: 'none' });
      try { queryCut = { source: observation.source, asOfSeq: observation.cursor }; }
      finally { observation[Symbol.dispose](); }
    }
    const handle = await ctx.sessionPersistence.open(args.sessionId, 'read', { signal });
    let events;
    let inspectedEventCount;
    try {
      if (args.operation === 'inspect') {
        inspectedEventCount = snapshot.eventCount ?? await persistedEventCount(handle, queryCut ? queryCut.asOfSeq + 1 : undefined, signal);
        offset = Math.max(0, inspectedEventCount - args.limit);
      }
      ({ events } = await handle.read(offset, args.limit + 1, { signal }));
    } finally { await handle.close(); }
    signal?.throwIfAborted();
    const after = await ctx.sessionPersistence.stat(args.sessionId, { signal });
    const stable = after?.revision === snapshot.revision;
    let target;
    let warnings = [];
    let projection;
    if (args.operation === 'inspect') {
      const live = await discover(signal);
      target = live.targets.get(args.sessionId);
      warnings = live.warnings;
      if (target?.agent) {
        const cut = ctx.sessionProjections.cachedSnapshot(target.agent.session, ['inbox']);
        if (cut) projection = { source: 'live-cached-projection', asOfSeq: cut.asOfSeq, pendingNextTurn: cut.values.inbox?.['next-turn']?.length ?? 0, pendingNextStep: cut.values.inbox?.['next-step']?.length ?? 0, complete: false };
      }
      if (queryCut) warnings.push(`Query watermark ${queryCut.asOfSeq} (source ${queryCut.source}); persisted tail independently verified at ${inspectedEventCount} events.`);
    }
    const selected = events.slice(0, args.limit).map(previewEvent);
    const result = boundedPage({ ...base, sessionId: args.sessionId, header: publicHeader(snapshot.header), source: 'persistence-read-handle', revision, revisionStable: stable, state: target?.state ?? 'unknown', evidence: target?.evidence ?? ['stored log only; operational state unknown'], capabilities: capabilities(target), warnings, ...(projection ? { projection } : {}), hasMore: events.length > args.limit }, selected, 'events', args.maxBytes, used => codec.encode({ id: args.sessionId, offset: offset + used }));
    result.nextOffset = offset + result.events.length;
    // Reserve this small field in the page budget too.
    if (Buffer.byteLength(JSON.stringify(result)) > args.maxBytes) delete result.nextOffset;
    return result;
  }

  async function resumeSession(args, exec, base) {
    const { signal } = exec;
    const unavailable = reason => ({ ...base, sessionId: args.sessionId, code: 'resume_unavailable', effect: 'none', reason: redact(reason).slice(0, 1024) });
    if (!resume?.preflightResume || !resume?.executeResume) return unavailable('Original context and safe worker are unavailable. No writer acquired or fallback attempted.');
    const live = (await discover(signal)).targets.get(args.sessionId);
    if (live?.agent || live?.record) return unavailable('Destination is live: use send, never a second worker.');
    const request = { sessionId: args.sessionId, text: args.text, root: options.root ?? DEFAULT_ROOT, signal };
    const prepared = await resume.preflightResume(ctx, request);
    signal?.throwIfAborted();
    if (!prepared?.ok) return unavailable(prepared?.reason ?? 'Origin could not be verified.');
    if (prepared.exactLiteral !== args.text || prepared.descriptor?.sessionId !== args.sessionId || !prepared.fingerprint) return unavailable('Invalid resume preflight identity.');
    if (!exec.agent || !ctx.approval?.request) return { ...base, sessionId: args.sessionId, code: 'approval_unavailable', effect: 'none' };
    const descriptor = prepared.descriptor;
    const reason = `Retomar sessão ${args.sessionId}\nCwd: ${descriptor.cwd}\nProfile de origem: ${descriptor.profile?.name}\nPreset: ${descriptor.preset ?? '(host original comprovado)'}\nModelo: ${JSON.stringify(descriptor.model)}\nPolíticas: ${JSON.stringify(descriptor.policies)}\n${prepared.reason}\nMensagem literal:\n${args.text}`;
    const outcome = await ctx.approval.request({ agent: exec.agent, toolName: 'session', callId: exec.callId, reason, signal });
    signal?.throwIfAborted();
    if (outcome !== 'allowed-once') return { ...base, sessionId: args.sessionId, code: `approval_${outcome ?? 'unavailable'}`, effect: 'none' };
    const currentLive = (await discover(signal)).targets.get(args.sessionId);
    if (currentLive?.agent || currentLive?.record) return unavailable('Destination became live after approval.');
    const current = await resume.preflightResume(ctx, request);
    signal?.throwIfAborted();
    if (!current?.ok || current.fingerprint !== prepared.fingerprint || current.exactLiteral !== args.text) return unavailable('Resume destination or configuration changed after approval; reconfirmation required.');
    const requestId = randomUUID();
    let result;
    try { result = await resume.executeResume(current, { requestId, signal }); }
    catch { return { ...base, sessionId: args.sessionId, requestId, code: 'resume_unknown', effect: 'unknown', retrySafe: false }; }
    if (result?.ok && result.ack?.requestId === requestId && result.ack?.sessionId === args.sessionId && result.ack?.accepted === true && result.ack?.boundary === 'next-turn') return { ...base, source: 'original-profile-worker', sessionId: args.sessionId, requestId, accepted: true, resumed: true, effect: 'enqueued', completed: false, boundary: 'next-turn', originalProfile: descriptor.profile?.name, currentConfiguration: true, immutableOriginal: false };
    return { ...base, source: 'original-profile-worker', sessionId: args.sessionId, requestId, code: result?.error?.code ?? 'resume_unknown', effect: result?.effect === 'none' ? 'none' : 'unknown', retrySafe: false };
  }

  async function send(args, exec, base) {
    const { signal } = exec;
    const initial = (await discover(signal)).targets.get(args.sessionId);
    if (!initial?.agent && !initial?.record) return { ...base, sessionId: args.sessionId, code: 'send_unavailable', effect: 'none' };
    if (!exec.agent || !ctx.approval?.request) return { ...base, sessionId: args.sessionId, code: 'approval_unavailable', effect: 'none' };
    const header = initial.agent?.session.header ?? initial.header ?? {};
    const reason = `Enviar ao próximo turno da sessão ${args.sessionId}\nTítulo: ${initial.remote?.title ?? '(não disponível)'}\nCwd: ${header.cwd ?? '(não disponível)'}\nPreset: ${header.agentPreset ?? '(não disponível)'}\nMensagem literal:\n${args.text}`;
    const outcome = await ctx.approval.request({ agent: exec.agent, toolName: 'session', callId: exec.callId, reason, signal });
    signal?.throwIfAborted();
    if (outcome !== 'allowed-once') return { ...base, sessionId: args.sessionId, code: `approval_${outcome ?? 'unavailable'}`, effect: 'none' };
    const current = (await discover(signal)).targets.get(args.sessionId);
    signal?.throwIfAborted();
    const same = initial.agent ? current?.agent === initial.agent && ctx.agents.get(args.sessionId) === initial.agent : current?.record?.bridgeId === initial.record.bridgeId && current?.record?.pid === initial.record.pid && current?.record?.startTime === initial.record.startTime && current?.identity === initial.identity && Boolean(initial.identity);
    if (!same) return { ...base, sessionId: args.sessionId, code: 'destination_changed', effect: 'none' };
    const requestId = randomUUID();
    if (initial.agent) {
      // This public input API queues an independent next turn, never steering,
      // UI draft editing, interruption or a takeover of an active writer.
      try {
        initial.agent.send({ id: requestId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: args.text }] }, 'next-turn', true);
      } catch {
        // Public send may throw after durable inbox admission; do not claim
        // non-delivery or automatically retry a possibly accepted message.
        return { ...base, source: 'local-agent', sessionId: args.sessionId, requestId, code: 'delivery_unknown', effect: 'unknown', retrySafe: false };
      }
      return { ...base, source: 'local-agent', sessionId: args.sessionId, requestId, accepted: true, boundary: 'next-turn', effect: 'enqueued', completed: false };
    }
    let reply;
    try { reply = await bridge.sendBridge(current.record, { sessionId: args.sessionId, text: args.text, requestId }, signal); }
    catch { return { ...base, source: 'bridge', sessionId: args.sessionId, requestId, code: 'delivery_unknown', effect: 'unknown', retrySafe: false }; }
    const ack = reply?.ack;
    if (reply?.ok && ack?.requestId === requestId && ack.sessionId === args.sessionId && ack.accepted === true && ack.boundary === 'next-turn') return { ...base, source: 'bridge', sessionId: args.sessionId, requestId, accepted: true, boundary: 'next-turn', effect: 'enqueued', completed: false };
    return { ...base, source: 'bridge', sessionId: args.sessionId, requestId, code: reply?.error?.code ?? 'delivery_unknown', effect: reply?.error?.code === 'delivery_unknown' || reply?.ok ? 'unknown' : 'none', retrySafe: false };
  }
  return { execute };
}
