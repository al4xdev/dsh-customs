import { readFile } from 'node:fs/promises';

// Compatibility for the opt-in runner only. Never migrate or refresh this grant.
export async function useLegacyCodex(credentials, key, filename, now = Date.now(), read = readFile) {
  if (await credentials.readRecord(key)) return () => {};
  let grant;
  try {
    grant = JSON.parse(await read(filename, 'utf8')).providers?.['openai-codex'];
  } catch (error) {
    if (error.code === 'ENOENT') return () => {};
    throw Object.assign(new Error('Cannot load legacy Codex credentials.'), { code: 'LEGACY_CODEX_INVALID_FILE' });
  }
  if (!grant) return () => {};
  if (grant.type !== 'oauth' || !['access', 'refresh', 'accountId'].every((field) => typeof grant[field] === 'string' && grant[field])) {
    throw Object.assign(new Error('Invalid legacy Codex OAuth credential.'), { code: 'LEGACY_CODEX_INVALID_GRANT' });
  }
  if (!Number.isFinite(grant.expires) || grant.expires <= now + 300_000) {
    throw Object.assign(new Error('Legacy Codex OAuth expires soon; refresh it in your normal DSH login before testing.'), { code: 'LEGACY_CODEX_EXPIRED' });
  }
  const record = { kind: 'grant', payload: grant };
  const original = {
    readRecord: credentials.readRecord,
    modifyRecord: credentials.modifyRecord,
    deleteRecord: credentials.deleteRecord,
  };
  credentials.readRecord = async (address) => address === key
    ? structuredClone(record) : original.readRecord.call(credentials, address);
  credentials.modifyRecord = async (address, mutate) => {
    if (address === key) throw new Error('Legacy Codex OAuth is read-only in the grammar test.');
    return original.modifyRecord.call(credentials, address, mutate);
  };
  credentials.deleteRecord = async (address) => {
    if (address === key) throw new Error('Legacy Codex OAuth is read-only in the grammar test.');
    return original.deleteRecord.call(credentials, address);
  };
  return () => Object.assign(credentials, original);
}
