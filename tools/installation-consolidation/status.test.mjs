import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { status } from './status.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-status-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = { cli: path.join(root, 'cli'), profiles: path.join(root, 'profiles') };
  const shared = path.join(layout.profiles, 'node_modules');
  const adapter = '@deepseek-ai/dsh-llm-pi-ai';
  const target = path.join(layout.cli, 'node_modules', adapter);
  const link = path.join(layout.profiles, 'dsh-tui/node_modules', adapter);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: adapter, version: 'fixture' }));
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
  fs.mkdirSync(path.join(shared, '@deepseek-ai/dsh-llm-llamacpp'), { recursive: true });
  return { layout, target, link, root, options: { links: 1, regular: 1, proofs: {} } };
}
test('post-cut status needs no legacy roots, service or TUI stop', t => {
  const f = fixture(t);
  const before = fs.readdirSync(f.root);
  const result = status(f.layout, f.options);
  assert.equal(result.state, 'complete');
  assert.equal(result.retiredRootsRequired, false);
  assert.deepEqual(fs.readdirSync(f.root), before);
});
test('noncanonical adapter link fails closed', t => {
  const f = fixture(t); fs.unlinkSync(f.link); fs.symlinkSync(f.root, f.link);
  assert.equal(status(f.layout, f.options).state, 'needs-attention');
});
test('canonical public manifest name mismatch is reported', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.target, 'package.json'), '{"name":"wrong"}');
  assert.match(status(f.layout, f.options).blockers.join('\n'), /name mismatch/);
});
test('code hash drift is reported without executing package code', t => {
  const f = fixture(t);
  const result = status(f.layout, { ...f.options, proofs: { 'node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json': '0'.repeat(64) } });
  assert.match(result.blockers.join('\n'), /fingerprint mismatch/);
});
