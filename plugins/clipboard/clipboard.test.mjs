import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipboardEnvironment, copyText } from './index.mjs';

const scratch = resolve(dirname(fileURLToPath(import.meta.url)), '../../.dumps');

async function fixture(t, mode = 'success') {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'clipboard-test-'));
  t.after(async () => {
    // Only remove the absolute directory allocated by this test, never an environment path.
    assert.equal(dirname(root), scratch);
    assert.ok(basename(root).startsWith('clipboard-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const record = join(root, 'record.json');
  if (mode !== 'missing') {
    await writeFile(join(root, 'wl-copy'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { text += chunk; });
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), text }));
  if (${JSON.stringify(mode)} === 'fail') {
    process.stderr.write('fixture failure\\n');
    process.exitCode = 7;
  } else if (${JSON.stringify(mode)} === 'hang') {
    setInterval(() => {}, 1000);
  }
});
`, { mode: 0o700 });
  }
  // No inherited PATH or session variables: even a missing stub cannot run real wl-copy.
  const env = { PATH: root, XDG_RUNTIME_DIR: root, WAYLAND_DISPLAY: 'fixture-display' };
  return { root, env, record: async () => JSON.parse(await readFile(record, 'utf8')) };
}

test('copies Unicode and newlines verbatim with the text MIME type', async t => {
  const f = await fixture(t);
  const text = 'Olá 👋\n第二行\n';
  assert.equal(await copyText(text, undefined, { env: f.env }), 'Text copied to clipboard.');
  assert.deepEqual(await f.record(), { args: ['--type', 'text/plain;charset=utf-8'], text });
});

test('empty text invokes --clear', async t => {
  const f = await fixture(t);
  assert.equal(await copyText('', undefined, { env: f.env }), 'Clipboard cleared.');
  assert.deepEqual(await f.record(), { args: ['--clear'], text: '' });
});

test('reports a failing executable and its stderr', async t => {
  const f = await fixture(t, 'fail');
  await assert.rejects(copyText('text', undefined, { env: f.env }), /exited with code 7: fixture failure/);
});

test('missing executable reports wl-clipboard prerequisite without PATH fallback', async t => {
  const f = await fixture(t, 'missing');
  await assert.rejects(copyText('text', undefined, { env: f.env }), /wl-copy was not found on PATH; install wl-clipboard/);
});

test('pre-cancelled request preserves the reason and does not start the stub', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const reason = new Error('fixture cancelled');
  controller.abort(reason);
  await assert.rejects(copyText('text', controller.signal, { env: f.env }), error => error === reason);
  await assert.rejects(f.record(), { code: 'ENOENT' });
});

test('cancellation rejects an in-flight fake executable with the original reason', async t => {
  const f = await fixture(t, 'hang');
  const controller = new AbortController();
  const reason = new Error('fixture cancelled in flight');
  const pending = copyText('text', controller.signal, { env: f.env });
  const timer = setTimeout(() => controller.abort(reason), 100);
  try {
    await assert.rejects(pending, error => error === reason);
  } finally {
    clearTimeout(timer);
  }
});

test('timeout rejects a stalled fake executable', async t => {
  const f = await fixture(t, 'hang');
  await assert.rejects(copyText('text', undefined, { env: f.env, timeoutMs: 200 }), /timed out after 200 ms; wl-copy was stopped/);
});

test('discovers only Unix Wayland sockets and requires an explicit choice when ambiguous', async t => {
  const f = await fixture(t, 'missing');
  const env = { PATH: f.root, XDG_RUNTIME_DIR: f.root };
  await writeFile(join(f.root, 'wayland-file'), 'not a socket');
  await writeFile(join(f.root, 'wayland-0.lock'), 'not a display');
  await assert.rejects(clipboardEnvironment(env), /No Wayland display socket found/);
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map(server => new Promise((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
    })));
  });
  for (const name of ['wayland-0', 'wayland-1']) {
    const server = createServer();
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(join(f.root, name), resolveListen);
    });
    servers.push(server);
    if (servers.length === 1) assert.equal((await clipboardEnvironment(env)).WAYLAND_DISPLAY, name);
  }
  await assert.rejects(clipboardEnvironment(env), /Found 2 Wayland displays/);
  assert.equal((await clipboardEnvironment({ ...env, WAYLAND_DISPLAY: 'fixture-display' })).WAYLAND_DISPLAY, 'fixture-display');
});
