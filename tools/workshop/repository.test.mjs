import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectRecipe, validateManifest } from './core.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const json = path => JSON.parse(readFileSync(join(repo, path), 'utf8'));

test('the shipped workshop manifest and patch bytes agree, not only mock recipes', () => {
  const manifest = validateManifest(json('tools/workshop/manifest.json'));
  const inspection = inspectRecipe({ repo, manifest });
  assert.equal(inspection.ready, true, inspection.issues.join('; '));
  const recipe = json('tools/task10-frontend/recipe.json');
  const tui = manifest.components.find(component => component.id === 'tui');
  assert.equal(tui.repository, recipe.url);
  assert.equal(tui.commit, recipe.base);
  assert.equal(tui.package, recipe.package);
  assert.equal(tui.version, recipe.version);
  assert.equal(tui.packageManager.version, recipe.pnpm);
  assert.equal(tui.patch.sha256, recipe.patchSha256);
  assert.equal(tui.submodules[0].commit, recipe.vendorDshStd);
});

test('repository activation and MCP dependencies are locally pinned in the lock', () => {
  const pkg = json('package.json'), lock = json('package-lock.json');
  // A fresh clone must not need the old profile/npx tree to supply YAML.
  for (const [name, version] of [['yaml', '2.9.1'], ['@modelcontextprotocol/server', '2.3.1']]) {
    assert.equal(pkg.dependencies[name], version);
    assert.equal(lock.packages[''].dependencies[name], version);
    const entry = lock.packages['node_modules/' + name];
    assert.equal(entry.version, version);
    assert.match(entry.integrity, /^sha512-/);
  }
});
