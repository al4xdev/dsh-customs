import test from 'node:test';
import assert from 'node:assert/strict';
import { admitImages } from './render.mjs';
import { BrowserError } from './errors.mjs';

function fixture() {
  const counts = { reads: 0, saves: 0 };
  const ctx = { get: name => name === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: ['image'] }) } : { saveImages: async () => { counts.saves++; return [{ attachmentId: 'fixture' }]; } } };
  const exec = { agent: { session: { requestHeader: () => ({ config: { provider: 'offline', model: 'fixture' } }) } }, signal: new AbortController().signal };
  const record = { config: { limits: { pixels: 16000000 } } };
  const value = { artifacts: [{ kind: 'screenshot', mime: 'image/png', state: 'finalized', name: 'fixture.png' }], warnings: [], imageRefs: [] };
  const files = { readArtifact: async () => { counts.reads++; return Buffer.from('fixture'); } };
  return { ctx, exec, record, value, files, counts };
}

test('host delivery fence after model metadata denies reads and native attachment writes', async () => {
  const f = fixture();
  const fence = async () => { throw new BrowserError('POLICY_CHANGED', 'Fixture authority revoked.'); };
  await assert.rejects(admitImages(f.ctx, f.exec, f.value, f.record, f.files, fence), { code: 'POLICY_CHANGED' });
  assert.deepEqual(f.counts, { reads: 0, saves: 0 });
});

test('host delivery fence after byte reads prevents a late native attachment write', async () => {
  const f = fixture(); let allowed = true;
  f.files.readArtifact = async () => { f.counts.reads++; allowed = false; return Buffer.from('fixture'); };
  const fence = async () => { if (!allowed) throw new BrowserError('POLICY_CHANGED', 'Fixture authority revoked.'); };
  await assert.rejects(admitImages(f.ctx, f.exec, f.value, f.record, f.files, fence), { code: 'POLICY_CHANGED' });
  assert.deepEqual(f.counts, { reads: 1, saves: 0 });
});
