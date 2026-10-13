import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exportCatalog } from './export-catalog.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-public-catalog-'));
  t.after(() => { assert.equal(fs.realpathSync(root), root); fs.rmSync(root, { recursive: true }); });
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  return { source, output: path.join(root, 'output') };
}
test('exports public model bytes without copying stale catalog stamps', t => {
  const { source, output } = fixture(t);
  fs.writeFileSync(path.join(source, 'openai.json'), '{"model":{"baseUrl":"https://api.openai.com/v1"}}');
  fs.writeFileSync(path.join(source, '.manifest.json'), '{}');
  const result = exportCatalog(source, output);
  assert.equal(result.files.length, 1);
  assert.deepEqual(fs.readdirSync(output), ['openai.json']);
  assert.equal(result.files[0].sha256.length, 64);
  assert.throws(() => exportCatalog(source, output), /absent output/);
});
test('credential-like fields refuse the entire export before any output is created', t => {
  const { source, output } = fixture(t);
  fs.writeFileSync(path.join(source, 'test.json'), '{"model":{"apiKey":"fixture-not-a-credential"}}');
  assert.throws(() => exportCatalog(source, output), /publication refused/);
  assert.equal(fs.existsSync(output), false);
});
test('private endpoints cannot be silently published as public catalog inputs', t => {
  const { source, output } = fixture(t);
  fs.writeFileSync(path.join(source, 'test.json'), '{"baseUrl":"http://127.0.0.1:9999"}');
  assert.throws(() => exportCatalog(source, output), /publication refused/);
  assert.equal(fs.existsSync(output), false);
});
