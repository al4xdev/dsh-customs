import { isAbsolute } from 'node:path';
import { resolveHost } from './interaction-sdk.mjs';
import { INTERACTION_HEADS_LIMITS, denseArray, exactRecord, interactionRefusal, parseInteractionHeadsOutput, parseInteractionHeadsRequest, validInteractionCallId } from './interaction-heads-contracts.mjs';
const { symbols: { original } } = await import(resolveHost('@deepseek-ai/cordis'));
const identity = value => value?.[original] ?? value;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const unknown = (sessionId, createdAt = null) => ({ sessionId, createdAt, knowledge: 'unknown', asOfSeq: null, continuedCallIds: null });

function ownedHeader(header, id) {
  return header?.version === 4 && header.id === id && /^[A-Za-z0-9_-]{1,160}$/.test(id) && integer(header.createdAt) &&
    header.agentPreset === 'companion' && header.isSeeded === false && header.origin === undefined && header.parentSession === undefined &&
    (header.delegationDepth === undefined || header.delegationDepth === 0);
}
function candidatesOf(view) {
  // cachedSnapshot itself schema-validates the genuine SDK view, including bodies in RAM.
  // We neither traverse nor copy questions/answers, and never put them on this wire.
  exactRecord(view, ['active', 'settled']);
  if (!Array.isArray(view.settled)) throw interactionRefusal('invalid-output');
  const active = denseArray(view.active, INTERACTION_HEADS_LIMITS.maxActive);
  const seen = new Set(), continued = [];
  for (const item of active) {
    exactRecord(item, ['callId', 'questions', 'state']);
    if (!validInteractionCallId(item.callId) || seen.has(item.callId) || !['open', 'continued'].includes(item.state) ||
        !Array.isArray(item.questions) || item.questions.length === 0) throw interactionRefusal('invalid-output');
    seen.add(item.callId);
    if (item.state === 'continued') continued.push(item.callId);
    if (continued.length > INTERACTION_HEADS_LIMITS.maxContinued) throw interactionRefusal('invalid-output');
  }
  return continued;
}

/** Live cached CANDIDATES only. Continued can already have a queued reply; this is not blocker/answer authority. */
export function createInteractionHeads(ctx, { sourceCurrent = () => true } = {}) {
  if (typeof sourceCurrent !== 'function') throw new TypeError('Invalid interaction metadata source fence.');
  const root = ctx.root, ownerFiber = ctx.fiber, rootFiber = root?.fiber;
  const ownerUid = ownerFiber?.uid, rootUid = rootFiber?.uid;
  const profile = root?.get('profileContext'), directory = profile?.dir;
  const keys = ['sessions', 'sessionProjections'];
  const captured = new Map(keys.map(key => [key, identity(root?.get(key))]));
  const sessions = ctx.get('sessions'), registry = ctx.get('sessionProjections');
  let revoked = false;
  function current() {
    if (revoked) return false;
    try {
      const valid = ctx.root === root && ctx.fiber === ownerFiber && root?.fiber === rootFiber && !!ownerFiber && !!rootFiber &&
        integer(ownerUid) && integer(rootUid) && ownerFiber.uid === ownerUid && rootFiber.uid === rootUid &&
        root.get('profileContext') === profile && ctx.get('profileContext') === profile && profile?.name === 'companion' && profile.dir === directory && isAbsolute(directory ?? '') &&
        typeof sessions?.get === 'function' && typeof registry?.cachedSnapshot === 'function' && sourceCurrent() === true &&
        keys.every(key => captured.get(key) !== undefined && identity(root.get(key)) === captured.get(key) && identity(ctx.get(key)) === captured.get(key));
      if (!valid) revoked = true;
      return valid;
    } catch { revoked = true; return false; }
  }
  function live(session, id, header, seq) {
    return sessions.get(id) === session && session?.id === id && session.header === header && ownedHeader(header, id) && integer(session.seq) && (seq === undefined || seq === session.seq);
  }
  function read(raw, signal) {
    const { sessionIds } = parseInteractionHeadsRequest(raw);
    signal?.throwIfAborted();
    if (!current()) throw interactionRefusal('metadata-unavailable');
    const result = { version: 1, profile: 'companion', heads: sessionIds.map(id => unknown(id)) };
    const admitted = [];
    for (let index = 0; index < sessionIds.length; index++) {
      signal?.throwIfAborted();
      if (!current()) throw interactionRefusal('metadata-unavailable');
      const id = sessionIds[index]; let createdAt = null;
      try {
        const session = sessions.get(id), header = session?.header;
        if (!session || !live(session, id, header)) continue;
        createdAt = header.createdAt;
        result.heads[index] = unknown(id, createdAt);
        const seq = session.seq;
        // No snapshot/stateOf/observation/history/cold fallback: absent or trailing cache is unknown.
        const cut = registry.cachedSnapshot(session, ['userQuestions']);
        if (!cut || !integer(cut.asOfSeq, -1) || cut.asOfSeq !== seq - 1 || !live(session, id, header, seq)) continue;
        const continuedCallIds = candidatesOf(cut.values?.userQuestions);
        result.heads[index] = { sessionId: id, createdAt, knowledge: 'current', asOfSeq: cut.asOfSeq, continuedCallIds };
        // Never truncate a candidate set into a misleading complete-empty answer.
        if (Buffer.byteLength(JSON.stringify(result)) > INTERACTION_HEADS_LIMITS.maxBytes) result.heads[index] = unknown(id, createdAt);
        else admitted.push({ index, id, session, header, seq });
      } catch { result.heads[index] = unknown(id, createdAt); }
    }
    if (!current()) throw interactionRefusal('metadata-unavailable');
    for (const { index, id, session, header, seq } of admitted) {
      try { if (!live(session, id, header, seq)) result.heads[index] = unknown(id); }
      catch { result.heads[index] = unknown(id); }
    }
    signal?.throwIfAborted();
    if (!current()) throw interactionRefusal('metadata-unavailable');
    return parseInteractionHeadsOutput(result);
  }
  return Object.freeze({ current, read, close() { revoked = true; } });
}
