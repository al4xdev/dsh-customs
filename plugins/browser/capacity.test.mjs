import test from 'node:test';
import assert from 'node:assert/strict';
import { HostCapacity } from './capacity.mjs';
import { BrowserError } from './errors.mjs';

const defaults = { workers: 4, contexts: 8, ownerBytes: 2147483648 };
const config = (sessions = 1, ownerBytes = 1) => ({ limits: { sessions, ownerBytes } });
const exhausted = resource => error => error instanceof BrowserError && error.code === 'LIMIT_EXCEEDED' && error.details.resource === resource;

test('snapshot is finite plain JSON with curated defaults and detached aggregates', () => {
  const pool = new HostCapacity();
  const before = pool.snapshot();
  assert.deepEqual(before, { defaults, max: defaults, reserved: { workers: 0, contexts: 0, ownerBytes: 0 } });
  assert.deepEqual(JSON.parse(JSON.stringify(before)), before);
  for (const group of Object.values(before)) {
    assert.equal(Object.getPrototypeOf(group), Object.prototype);
    for (const value of Object.values(group)) assert.ok(Number.isSafeInteger(value) && value >= 0);
  }
  before.defaults.workers = 99;
  before.max.contexts = 99;
  before.reserved.ownerBytes = 99;
  assert.deepEqual(pool.snapshot().defaults, defaults);
  assert.deepEqual(pool.snapshot().max, defaults);
  assert.equal(pool.snapshot().reserved.ownerBytes, 0);
});

test('four worker ceiling is independent of contexts and bytes', () => {
  const pool = new HostCapacity();
  for (let i = 0; i < 4; i++) pool.reserve(config());
  const before = pool.snapshot();
  assert.deepEqual(before.reserved, { workers: 4, contexts: 4, ownerBytes: 4 });
  assert.throws(() => pool.reserve(config()), exhausted('workers'));
  assert.deepEqual(pool.snapshot(), before);
});

test('eight contexts reserve prospective sessions upfront independently of worker ceiling', () => {
  const pool = new HostCapacity();
  pool.reserve(config(8));
  const before = pool.snapshot();
  assert.deepEqual(before.reserved, { workers: 1, contexts: 8, ownerBytes: 1 });
  assert.throws(() => pool.reserve(config()), exhausted('contexts'));
  assert.deepEqual(pool.snapshot(), before);
});

test('2 GiB active owner bytes ceiling is independent of worker/context ceilings', () => {
  const pool = new HostCapacity();
  pool.reserve(config(1, 2147483648));
  const before = pool.snapshot();
  assert.deepEqual(before.reserved, { workers: 1, contexts: 1, ownerBytes: 2147483648 });
  assert.throws(() => pool.reserve(config()), exhausted('ownerBytes'));
  assert.deepEqual(pool.snapshot(), before);
});

test('only exact owned tokens release reservations; duplicate release is harmless', () => {
  const pool = new HostCapacity();
  const other = new HostCapacity();
  const token = pool.reserve(config(8, 2147483648));
  const otherToken = other.reserve(config());
  assert.equal(typeof token, 'object');
  assert.ok(Object.isFrozen(token));
  assert.deepEqual(Reflect.ownKeys(token), []);
  const before = pool.snapshot();
  for (const forged of [{}, Object.create(null), { ...token }, otherToken, null, undefined, 'token', 1]) {
    assert.equal(pool.release(forged), false);
    assert.deepEqual(pool.snapshot(), before);
  }
  assert.equal(other.release(token), false);
  assert.equal(pool.release(token), true);
  assert.equal(pool.release(token), false);
  assert.deepEqual(pool.snapshot().reserved, { workers: 0, contexts: 0, ownerBytes: 0 });
  const replacement = pool.reserve(config(8, 2147483648));
  assert.notEqual(replacement, token);
  assert.equal(pool.release(token), false);
  assert.equal(pool.release(replacement), true);
});

test('trusted constructor inputs only narrow known finite positive ceilings without mutation', () => {
  const limits = { workers: 2, contexts: 3, ownerBytes: 10 };
  const pool = new HostCapacity(limits);
  assert.deepEqual(limits, { workers: 2, contexts: 3, ownerBytes: 10 });
  limits.workers = 1;
  assert.equal(pool.snapshot().max.workers, 2);
  const token = pool.reserve(config(3, 10));
  assert.throws(() => pool.reserve(config()), exhausted('contexts'));
  assert.equal(pool.release(token), true);
  pool.reserve(config(3, 10));
  for (const invalid of [null, [], '4', 4, new Map(), { arbitrary: 1 }, { [Symbol('workers')]: 1 }]) {
    assert.throws(() => new HostCapacity(invalid), { code: 'BROWSER_CONFIG_INVALID' });
  }
  for (const key of Object.keys(defaults)) {
    for (const value of [0, -1, NaN, Infinity, -Infinity, 1.5, '1', null, true, 1n, {}, [], Number.MAX_SAFE_INTEGER + 1, defaults[key] + 1]) {
      assert.throws(() => new HostCapacity({ [key]: value }), { code: 'BROWSER_CONFIG_INVALID' });
    }
  }
  assert.throws(() => new HostCapacity({ get workers() { throw new Error('must not run'); } }), { code: 'BROWSER_CONFIG_INVALID' });
});

test('invalid admission data never mutates state or executes field getters', () => {
  const pool = new HostCapacity();
  pool.reserve(config());
  const before = pool.snapshot();
  const invalid = [null, [], {}, { limits: null }, { limits: [] }, { limits: {} }, { limits: { sessions: 1 } }];
  for (const key of ['sessions', 'ownerBytes']) {
    for (const value of [undefined, 0, -1, NaN, Infinity, -Infinity, 1.5, '1', null, true, 1n, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
      invalid.push({ limits: { sessions: 1, ownerBytes: 1, [key]: value } });
    }
  }
  invalid.push({ get limits() { throw new Error('must not run'); } });
  invalid.push({ limits: { ownerBytes: 1, get sessions() { throw new Error('must not run'); } } });
  invalid.push({ limits: { sessions: 1, get ownerBytes() { throw new Error('must not run'); } } });
  for (const value of invalid) {
    assert.throws(() => pool.reserve(value), { code: 'BROWSER_CONFIG_INVALID' });
    assert.deepEqual(pool.snapshot(), before);
  }
  for (const value of [config(9), config(1, 2147483649), config(Number.MAX_SAFE_INTEGER)]) {
    assert.throws(() => pool.reserve(value), { code: 'LIMIT_EXCEEDED' });
    assert.deepEqual(pool.snapshot(), before);
  }
});

test('normalized config fields do not act as host capacity overrides', () => {
  const pool = new HostCapacity();
  const input = Object.freeze({ workers: 99, contexts: 99, enabled: true, limits: Object.freeze({ sessions: 2, ownerBytes: 524288000, tabs: 4, workers: 99 }) });
  const token = pool.reserve(input);
  assert.deepEqual(pool.snapshot().max, defaults);
  assert.deepEqual(pool.snapshot().reserved, { workers: 1, contexts: 2, ownerBytes: 524288000 });
  assert.equal(pool.release(token), true);
});

test('same-event-loop concurrent admissions cannot oversubscribe before bootstrap', async () => {
  const pool = new HostCapacity();
  let bootstraps = 0;
  const admissions = await Promise.allSettled(Array.from({ length: 20 }, () => Promise.resolve().then(() => {
    const token = pool.reserve(config(2, 536870912));
    assert.equal(typeof token.then, 'undefined');
    bootstraps++;
    return token;
  })));
  assert.equal(bootstraps, 4);
  assert.equal(admissions.filter(result => result.status === 'fulfilled').length, 4);
  for (const result of admissions.filter(result => result.status === 'rejected')) {
    assert.ok(result.reason instanceof BrowserError);
    assert.equal(result.reason.code, 'LIMIT_EXCEEDED');
  }
  assert.deepEqual(pool.snapshot().reserved, { workers: 4, contexts: 8, ownerBytes: 2147483648 });
  for (const result of admissions.filter(result => result.status === 'fulfilled')) pool.release(result.value);
  assert.deepEqual(pool.snapshot().reserved, { workers: 0, contexts: 0, ownerBytes: 0 });
  assert.ok(pool.reserve(config(2, 536870912)));
});
