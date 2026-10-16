import { randomBytes } from 'node:crypto';

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_TICKETS = 4;
export const TTL_MS = 5 * 60 * 1000;
export const PREFIX = '/companion-download';
export const TICKET = /^[A-Za-z0-9_-]{43}$/;
const MESSAGES = Object.freeze({
  'too-large': 'Arquivo acima do limite de 20 MiB; nenhum link foi criado.',
  busy: 'Downloads ocupados: no máximo quatro snapshots e duas transferências. Tente novamente manualmente.',
  'consent-required': 'Compartilhamento não autorizado; nenhuma cópia para download foi criada.',
  'read-refused': 'Não foi possível ler o arquivo com as permissões atuais; nenhum link foi criado.',
  'file-changed': 'O arquivo mudou durante a preparação; nenhum link foi criado.',
  'protected-file': 'Credenciais, perfis privados e arquivos especiais não podem ser compartilhados por esta ferramenta.',
  cancelled: 'Preparação cancelada; nenhum link foi criado.',
});
export function refuse(code) {
  const error = new Error(`companion-files/${code}${MESSAGES[code] ? `: ${MESSAGES[code]}` : ''}`);
  error.code = `companion-files/${code}`;
  throw error;
}
export function safeName(raw) {
  let name = String(raw ?? 'arquivo').split(/[\\/]/).at(-1)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/[<>:"|?*\[\]()`]/gu, '_').trim().replace(/[. ]+$/u, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = `_${name}`;
  while (Buffer.byteLength(name) > 180) name = [...name].slice(0, -1).join('');
  return !name || name === '.' || name === '..' ? 'arquivo' : name;
}
export function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) refuse('invalid-origin');
  return value;
}

/** Four reservations include snapshots in preparation, revoked leases and active writes. */
export function createSnapshotRegistry({ origin, now = Date.now, checkOwner = () => {} }) {
  httpsOrigin(origin);
  const slots = new Set(), tickets = new Map();
  let closed = false, active = 0;
  const idle = new Set();
  const settleIdle = () => { if (slots.size === 0) { for (const resolve of idle) resolve(); idle.clear(); } };
  let windowStart = now(), requests = 0;
  function disposeBytes(row) {
    if (!row.revoked || row.active || row.preparing) return;
    row.bytes?.fill(0);
    row.bytes = undefined;
    slots.delete(row); settleIdle();
  }
  function revoke(row) {
    if (row.revoked) return;
    row.revoked = true;
    clearTimeout(row.timer);
    if (row.token) tickets.delete(row.token);
    row.abort.abort();
    disposeBytes(row);
  }
  function assert(row) {
    if (closed || row.revoked || now() >= row.expires) { revoke(row); refuse('expired'); }
    try { checkOwner(); row.valid(); } catch { revoke(row); refuse('source-changed'); }
  }
  async function verifyCurrent(row) {
    assert(row);
    try { await row.verify(); assert(row); }
    catch { revoke(row); refuse('source-changed'); }
  }
  function sweep() { for (const row of slots) if (now() >= row.expires) revoke(row); }
  return Object.freeze({
    reserve(valid, verify = async () => {}, scope) {
      if (closed) refuse('closed');
      checkOwner(); sweep();
      if (slots.size >= MAX_TICKETS) refuse('busy');
      const row = { valid, verify, scope, abort: new AbortController(), expires: now() + TTL_MS, active: false, preparing: true, revoked: false, attempts: 0, heads: 0 };
      slots.add(row);
      row.timer = setTimeout(() => revoke(row), TTL_MS); row.timer.unref?.();
      let committed = false;
      return Object.freeze({
        signal: row.abort.signal,
        commit(bytes, name) {
          if (committed) refuse('already-committed');
          assert(row);
          if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) refuse('too-large');
          // The SDK read result is owned by this reservation; do not copy another 20MiB.
          row.bytes = bytes; row.name = safeName(name); row.preparing = false; committed = true;
          row.token = randomBytes(32).toString('base64url'); tickets.set(row.token, row);
          return Object.freeze({ url: `${origin}${PREFIX}/${row.token}`, displayName: row.name, bytes: bytes.byteLength, expiresAt: row.expires });
        },
        cancel() { row.preparing = false; revoke(row); disposeBytes(row); },
      });
    },
    acquire(token, head = false) {
      sweep(); checkOwner();
      if (now() - windowStart >= 60_000) { windowStart = now(); requests = 0; }
      if (++requests > 64) refuse('rate-limited');
      const row = tickets.get(token);
      if (!row || !TICKET.test(token)) refuse('not-found');
      assert(row);
      if (head) {
        if (++row.heads > 8) refuse('rate-limited');
        return Object.freeze({ name: row.name, size: row.bytes.byteLength, verify: () => verifyCurrent(row) });
      }
      if (row.active || active >= 2) refuse('busy');
      if (++row.attempts > 3) { revoke(row); refuse('attempt-limit'); }
      row.active = true; active++;
      let released = false;
      return Object.freeze({
        name: row.name, size: row.bytes.byteLength, signal: row.abort.signal,
        chunk(offset, length) {
          assert(row);
          if (released) refuse('released');
          return row.bytes.subarray(offset, Math.min(offset + length, row.bytes.byteLength));
        },
        assert: () => assert(row),
        verify: () => verifyCurrent(row),
        release(success) {
          if (released) return;
          released = true; row.active = false; active--;
          if (success) revoke(row);
          disposeBytes(row); settleIdle();
        },
      });
    },
    revokeScope(scope) { if (scope !== undefined) for (const row of slots) if (row.scope === scope) revoke(row); },
    close() {
      closed = true; for (const row of slots) revoke(row);
      return slots.size === 0 ? Promise.resolve() : new Promise(resolve => idle.add(resolve));
    },
    // Counts only: never expose snapshot buffers, names, ticket values or local paths.
    status() { sweep(); return Object.freeze({ slots: slots.size, tickets: tickets.size, active, closed }); },
  });
}
