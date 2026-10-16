import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotRegistry, MAX_BYTES, MAX_TICKETS, TTL_MS, safeName } from './registry.mjs';

const ORIGIN = 'https://dsh.tail37b3d7.ts.net:8443';
function fixture(t) {
  let clock = 1_000_000;
  const registry = createSnapshotRegistry({ origin: ORIGIN, now: () => clock });
  t.after(() => registry.close());
  const ticketOf = link => link.url.slice(`${ORIGIN}/companion-download/`.length);
  const publish = (bytes = Buffer.from('payload'), name = 'file.txt') => registry.reserve(() => {}, async () => {}, 'scope').commit(bytes, name);
  return { registry, publish, ticketOf, advance: ms => { clock += ms; }, now: () => clock };
}

test('a committed snapshot is a one-success bearer link with bounded content', async t => {
  const f = fixture(t);
  const link = f.publish(Buffer.from('0123456789'), 'notes\u202E.txt');
  assert.match(link.url, /^https:\/\/dsh\.tail37b3d7\.ts\.net:8443\/companion-download\/[A-Za-z0-9_-]{43}$/);
  assert.equal(link.displayName, 'notes.txt', 'bidi controls never reach the download name');
  const head = f.registry.acquire(f.ticketOf(link), true); assert.equal(head.size, 10);
  const lease = f.registry.acquire(f.ticketOf(link));
  assert.equal(Buffer.from(lease.chunk(0, 4)).toString(), '0123'); await lease.verify();
  lease.release(true);
  assert.throws(() => f.registry.acquire(f.ticketOf(link)), { code: 'companion-files/not-found' });
  assert.equal(f.registry.status().slots, 0);
});

test('link TTL starts at commit: a slow approval does not eat the five minutes', t => {
  const f = fixture(t);
  const reservation = f.registry.reserve(() => {}, async () => {}, 'scope');
  f.advance(4 * 60_000); // owner approval took four minutes
  const link = reservation.commit(Buffer.from('x'), 'a.txt');
  assert.equal(link.expiresAt, f.now() + TTL_MS);
  f.advance(TTL_MS - 1000);
  assert.equal(f.registry.acquire(f.ticketOf(link), true).size, 1);
  f.advance(1000);
  assert.throws(() => f.registry.acquire(f.ticketOf(link), true), { code: 'companion-files/not-found' });
});

test('an unapproved reservation still expires TTL after reserve', t => {
  const f = fixture(t);
  const reservation = f.registry.reserve(() => {}, async () => {}, 'scope');
  f.advance(TTL_MS);
  assert.throws(() => reservation.commit(Buffer.from('x'), 'a.txt'), { code: 'companion-files/expired' });
  assert.equal(reservation.signal.aborted, true, 'preparation is cancelled');
  reservation.cancel(); // host.prepare always cancels on failure
});

test('guessed tickets cost nothing: a flood cannot rate-limit a real link', t => {
  const f = fixture(t);
  const link = f.publish();
  for (let index = 0; index < 1000; index++) {
    assert.throws(() => f.registry.acquire(String(index).padStart(43, 'A')), { code: 'companion-files/not-found' });
    assert.throws(() => f.registry.acquire('../etc/passwd'), { code: 'companion-files/not-found' });
  }
  assert.equal(f.registry.acquire(f.ticketOf(link), true).size, 7);
  // Valid tickets keep their own bounds.
  for (let index = 1; index < 8; index++) f.registry.acquire(f.ticketOf(link), true);
  assert.throws(() => f.registry.acquire(f.ticketOf(link), true), { code: 'companion-files/rate-limited' });
});

test('capacity, size, attempts, concurrency and scope revocation fail closed', async t => {
  const f = fixture(t);
  const links = Array.from({ length: MAX_TICKETS }, () => f.publish());
  assert.throws(() => f.registry.reserve(() => {}), { code: 'companion-files/busy' });
  f.registry.revokeScope('scope');
  assert.equal(f.registry.status().tickets, 0);
  for (const link of links) assert.throws(() => f.registry.acquire(f.ticketOf(link)), { code: 'companion-files/not-found' });
  const oversized = f.registry.reserve(() => {});
  assert.throws(() => oversized.commit(new Uint8Array(MAX_BYTES + 1), 'big'), { code: 'companion-files/too-large' });
  oversized.cancel();
  const link = f.publish();
  for (let attempt = 0; attempt < 3; attempt++) f.registry.acquire(f.ticketOf(link)).release(false);
  assert.throws(() => f.registry.acquire(f.ticketOf(link)), { code: 'companion-files/attempt-limit' });
  const a = f.publish(), b = f.publish();
  const first = f.registry.acquire(f.ticketOf(a));
  assert.throws(() => f.registry.acquire(f.ticketOf(a)), { code: 'companion-files/busy' }, 'one transfer per ticket');
  const second = f.registry.acquire(f.ticketOf(b));
  first.release(false); second.release(false);
});

test('a changed actor revokes its snapshot; close waits for active transfers', async t => {
  const f = fixture(t);
  let current = true;
  const link = f.registry.reserve(() => { if (!current) throw new Error('changed'); }, async () => {}, 'scope').commit(Buffer.from('abc'), 'a');
  const lease = f.registry.acquire(f.ticketOf(link));
  let closed = false; const closing = f.registry.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, 'bytes stay alive while a transfer holds them');
  lease.release(false); await closing;
  current = false;
  assert.throws(() => f.registry.acquire(f.ticketOf(link)));
});

test('download names are single safe leaves', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('con.txt'), '_con.txt');
  assert.equal(safeName('a<b>|c?.txt'), 'a_b__c_.txt');
  assert.equal(safeName(''), 'arquivo');
  assert.ok(Buffer.byteLength(safeName('é'.repeat(200))) <= 180);
});
