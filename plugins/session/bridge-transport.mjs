import net from 'node:net';
import { MAX_FRAME, SIDE_OPERATIONS, failure, sameIdentity, validateRecord, validId } from './bridge-security.mjs';

// Server-side socket budget for ask/recap: the 120s model deadline plus slack;
// clients wait a little longer than the server so they see its timeout result.
export const SIDE_SOCKET_MS = 130_000;
export const SIDE_CLIENT_MS = 135_000;
const text = (value, max) => value === undefined || typeof value === 'string' && value.length <= max;
function validSideAnswer(answer, request) {
  if (!answer || typeof answer !== 'object' || answer.kind !== request.operation || typeof answer.truncated !== 'boolean') return false;
  return request.operation === 'ask' ? typeof answer.text === 'string' && answer.text.length > 0 && answer.text.length <= 8000 : typeof answer.summary === 'string' && answer.summary.length <= 8000 && text(answer.title, 8000);
}

export async function exchange(record, request, signal, { timeoutMs = 3000 } = {}) {
  try { signal?.throwIfAborted(); await validateRecord(record); signal?.throwIfAborted(); }
  catch (error) { return failure(signal?.aborted ? 'cancelled' : 'bridge_unavailable', error.message, { retrySafe: true }); }
  return new Promise(resolve => {
    let sent = false, finished = false, data = Buffer.alloc(0);
    const socket = net.createConnection(record.socketPath);
    const timer = setTimeout(() => finishFailure('bridge_timeout'), Math.max(1, Math.min(timeoutMs, SIDE_CLIENT_MS)));
    timer.unref();
    const abort = () => finishFailure('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    function finish(result) {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); resolve(result);
    }
    function finishFailure(code) {
      const uncertain = sent && ['send', 'create-session'].includes(request.operation);
      const unknownCode = request.operation === 'create-session' ? 'creation_unknown' : 'delivery_unknown';
      finish(failure(uncertain ? unknownCode : code, uncertain ? 'The approved effect may have occurred; do not automatically retry.' : code, { retrySafe: !uncertain, requestId: request.requestId }));
    }
    socket.once('connect', () => {
      if (signal?.aborted) return abort();
      const frame = JSON.stringify({ ...request, identity: { bridgeId: record.bridgeId, pid: record.pid, startTime: record.startTime } }) + '\n';
      if (Buffer.byteLength(frame) > MAX_FRAME) return finishFailure('frame_too_large');
      sent = true; socket.write(frame);
    });
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_FRAME) return finishFailure('invalid_response');
      const end = data.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(data.subarray(0, end).toString('utf8'));
        if (!sameIdentity(response.identity, record) || typeof response.ok !== 'boolean' || (request.operation === 'send' && response.ok && (response.ack?.requestId !== request.requestId || response.ack?.sessionId !== request.sessionId || response.ack?.accepted !== true || response.ack?.boundary !== 'next-turn'))) return finishFailure('identity_mismatch');
        const validAgent = agent => validId(agent?.sessionId) && validId(agent?.agentIdentity) && agent.state === 'live-confirmed';
        if ((response.ok && request.operation === 'list' && (!Array.isArray(response.agents) || response.agents.length > 128 || !response.agents.every(validAgent))) || (response.ok && request.operation === 'inspect' && (!validAgent(response.agent) || response.agent.sessionId !== request.sessionId)) || (response.ok && SIDE_OPERATIONS.includes(request.operation) && !validSideAnswer(response.answer, request)) || (!response.ok && typeof response.error?.code !== 'string')) return finishFailure('invalid_response');
        finish(response);
      } catch { finishFailure('invalid_response'); }
    });
    socket.once('error', () => finishFailure('bridge_unavailable'));
    socket.once('close', () => { if (!finished) finishFailure('bridge_closed'); });
  });
}

export function attachProtocol(server, handler) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    let data = Buffer.alloc(0), handled = false;
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return socket.destroy();
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_FRAME) return socket.destroy();
      const end = data.indexOf(10);
      if (end < 0) return;
      handled = true;
      if (end !== data.length - 1) return socket.destroy();
      let request;
      try { request = JSON.parse(data.subarray(0, end).toString('utf8')); } catch { return socket.destroy(); }
      const budgetMs = SIDE_OPERATIONS.includes(request?.operation) ? SIDE_SOCKET_MS : ['prepare-create', 'create-session'].includes(request?.operation) ? 30000 : 3000;
      if (budgetMs !== 3000) socket.setTimeout(budgetMs);
      // Same budget as the client's exchange timeout. A request that waits in the
      // host queue past it, or whose socket already closed, must not take effect:
      // its client has reported the outcome as unknown and moved on.
      const deadline = Date.now() + budgetMs;
      const current = () => !socket.destroyed && Date.now() < deadline;
      // Side queries are long model calls: a client that hangs up stops paying for them.
      const gone = new AbortController();
      socket.once('close', () => gone.abort());
      Promise.resolve().then(() => handler(request, { current, signal: gone.signal })).then(response => {
        const frame = JSON.stringify(response) + '\n';
        if (Buffer.byteLength(frame) > MAX_FRAME) socket.destroy(); else socket.end(frame);
      }).catch(() => socket.destroy());
    });
  });
  return () => { for (const socket of sockets) socket.destroy(); };
}
