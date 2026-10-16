import net from 'node:net';
import { MAX_FRAME, failure, sameIdentity, validateRecord, validId } from './bridge-security.mjs';

export async function exchange(record, request, signal, { timeoutMs = 3000 } = {}) {
  try { signal?.throwIfAborted(); await validateRecord(record); signal?.throwIfAborted(); }
  catch (error) { return failure(signal?.aborted ? 'cancelled' : 'bridge_unavailable', error.message, { retrySafe: true }); }
  return new Promise(resolve => {
    let sent = false, finished = false, data = Buffer.alloc(0);
    const socket = net.createConnection(record.socketPath);
    const timer = setTimeout(() => finishFailure('bridge_timeout'), Math.max(1, Math.min(timeoutMs, 30000)));
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
        if ((response.ok && request.operation === 'list' && (!Array.isArray(response.agents) || response.agents.length > 128 || !response.agents.every(validAgent))) || (response.ok && request.operation === 'inspect' && (!validAgent(response.agent) || response.agent.sessionId !== request.sessionId)) || (!response.ok && typeof response.error?.code !== 'string')) return finishFailure('invalid_response');
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
      if (['prepare-create', 'create-session'].includes(request?.operation)) socket.setTimeout(30000);
      Promise.resolve().then(() => handler(request)).then(response => {
        const frame = JSON.stringify(response) + '\n';
        if (Buffer.byteLength(frame) > MAX_FRAME) socket.destroy(); else socket.end(frame);
      }).catch(() => socket.destroy());
    });
  });
  return () => { for (const socket of sockets) socket.destroy(); };
}
