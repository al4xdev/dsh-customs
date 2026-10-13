import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig } from './config.mjs';
import { OPERATIONS, CATALOG_REVISION, getOperation, helpCatalog, describeOperation } from './manifest.mjs';

const owner = { ownerId: 'contract-owner' };
test('manifest is immutable, exact and has a single stable hash for the public contract', async () => {
  assert.ok(Array.isArray(OPERATIONS)); assert.ok(Object.isFrozen(OPERATIONS));
  assert.equal(new Set(OPERATIONS.map(item => item.operation)).size, OPERATIONS.length);
  assert.match(CATALOG_REVISION, /^bc_[a-f0-9]{32}$/);
  const independent = await import('./manifest.mjs?hash-check');
  assert.equal(independent.CATALOG_REVISION, CATALOG_REVISION);
  for (const item of OPERATIONS) {
    assert.ok(Object.isFrozen(item)); assert.ok(Object.isFrozen(item.inputSchema));
    for (const key of ['operation', 'inputSchema', 'outputSchema', 'effects', 'defaults', 'requiresSession', 'usesPage', 'availability', 'adapter']) assert.ok(Object.hasOwn(item, key), `${item.operation}: ${key}`);
    assert.ok(Array.isArray(item.effects));
  }
  assert.equal(getOperation('browser_click'), undefined);
  assert.equal(getOperation('interact.Click'), undefined);
  assert.equal(getOperation('run_code_unsafe'), undefined);
});

test('help is bounded immediate-child navigation, not a dump of every leaf/schema', () => {
  const root = helpCatalog({}, DEFAULT_CONFIG, owner);
  assert.ok(root.items.every(item => !item.operation.includes('.')));
  assert.ok(root.items.some(item => item.operation === 'media'));
  assert.ok(root.items.every(item => item.inputSchema === undefined));
  const media = helpCatalog({ path: 'media' }, DEFAULT_CONFIG, owner);
  assert.deepEqual(media.items.map(item => item.operation), ['media.screenshot', 'media.trace', 'media.video']);
  assert.deepEqual(helpCatalog({ path: 'media.video' }, DEFAULT_CONFIG, owner).items.map(item => item.operation), ['media.video.start', 'media.video.status', 'media.video.stop']);
  assert.ok(Buffer.byteLength(JSON.stringify(root)) <= 8192);
  assert.ok(Buffer.byteLength(JSON.stringify(media)) <= 8192);
});

test('help cursor is signed and bound to owner/path/query/revision/config', () => {
  const first = helpCatalog({ limit: 2 }, DEFAULT_CONFIG, owner);
  assert.equal(first.items.length, 2); assert.equal(first.hasMore, true); assert.ok(first.cursor);
  const next = helpCatalog({ limit: 2, cursor: first.cursor }, DEFAULT_CONFIG, owner);
  assert.equal(next.items.length, 2); assert.notEqual(first.items[0].operation, next.items[0].operation);
  for (const [options, config, context] of [
    [{ limit: 2, cursor: `${first.cursor}x` }, DEFAULT_CONFIG, owner],
    [{ limit: 2, cursor: first.cursor, path: 'media' }, DEFAULT_CONFIG, owner],
    [{ limit: 2, cursor: first.cursor, query: 'video' }, DEFAULT_CONFIG, owner],
    [{ limit: 2, cursor: first.cursor }, DEFAULT_CONFIG, { ownerId: 'different-owner' }],
    [{ limit: 2, cursor: first.cursor }, normalizeConfig({ enabled: false }), owner],
  ]) assert.throws(() => helpCatalog(options, config, context), { code: 'INVALID_CURSOR' });
});

test('catalog filters only curated operations and reports disabled extras honestly', () => {
  const disabled = helpCatalog({ path: 'advanced', availability: 'disabled' });
  assert.ok(disabled.items.length > 0); assert.ok(disabled.items.every(item => item.availability === 'disabled'));
  const media = helpCatalog({ path: 'media', query: 'video' });
  assert.deepEqual(media.items.map(item => item.operation), ['media.video']);
  assert.equal(describeOperation('advanced.auth.import').availability, 'disabled');
  assert.equal(describeOperation('media.trace.start', normalizeConfig({ sensitiveOps: 'disabled' })).availability, 'disabled');
  assert.equal(describeOperation('session.open', normalizeConfig({ enabled: false })).availability, 'disabled');
  assert.equal(describeOperation('help', normalizeConfig({ enabled: false })).availability, 'verified');
});

test('describe is complete, bounded and local; every descriptor can be described', () => {
  for (const item of OPERATIONS) {
    const described = describeOperation(item.operation);
    assert.equal(described.operation, item.operation);
    assert.equal(described.catalogRevision, CATALOG_REVISION);
    assert.deepEqual(described.inputSchema, item.inputSchema);
    assert.deepEqual(described.effects, item.effects);
    assert.ok(Buffer.byteLength(JSON.stringify(described)) <= 16384);
    assert.match(described.schemaHash, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => describeOperation('media'), { code: 'UNKNOWN_OPERATION' });
  assert.throws(() => helpCatalog({ path: 'madeup' }), { code: 'UNKNOWN_OPERATION' });
  assert.throws(() => helpCatalog({ path: '../secrets' }), { code: 'INVALID_ARGS' });
  assert.throws(() => helpCatalog({ limit: 31 }), { code: 'INVALID_ARGS' });
});
