import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { BrowserError } from './errors.mjs';

export const runtimeRequire = createRequire(new URL('./runtime/package.json', import.meta.url));
export const RUNTIME_PINS = Object.freeze({
  '@modelcontextprotocol/client': '2.3.1', '@modelcontextprotocol/server': '2.3.1',
  ajv: '8.17.1', playwright: '1.64.0', yaml: '2.9.1', 'playwright-core': '1.64.0',
});
const loaded = new Map();
const packageName = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];

async function installedVersion(name) {
  const expected = RUNTIME_PINS[name];
  if (!expected) throw new Error('Unknown runtime package');
  // Installation metadata is data, not a private Playwright implementation import.
  const document = JSON.parse(await readFile(new URL(`./runtime/node_modules/${name}/package.json`, import.meta.url), 'utf8'));
  return { name, expected, actual: document.version, available: document.name === name && document.version === expected };
}

/** Runtime libraries belong to this checkout, never to the private DSH/Claude dependency graph. */
export async function loadRuntime(name) {
  if (!loaded.has(name)) {
    const task = Promise.resolve().then(async () => {
      const root = packageName(name);
      const checks = await Promise.all((root === 'playwright' ? [root, 'playwright-core'] : [root]).map(installedVersion));
      if (checks.some(item => !item.available)) throw new Error('Runtime pin drift');
      return import(runtimeRequire.resolve(name));
    }).catch(() => {
      loaded.delete(name);
      throw new BrowserError('BACKEND_UNAVAILABLE', 'Browser runtime dependencies are missing or incompatible. Run the documented browser provisioner in the dsh-customs checkout.');
    });
    loaded.set(name, task);
  }
  return loaded.get(name);
}

export async function dependencyStatus() {
  try {
    const document = JSON.parse(await readFile(new URL('./runtime/package.json', import.meta.url), 'utf8'));
    const direct = Object.entries(RUNTIME_PINS).filter(([name]) => name !== 'playwright-core');
    const manifestMatched = !document.overrides && !document.resolutions && !document.devDependencies && Object.keys(document.dependencies ?? {}).length === direct.length && direct.every(([name, expected]) => document.dependencies[name] === expected);
    const dependencies = await Promise.all(Object.keys(RUNTIME_PINS).map(async name => {
      try { const result = await installedVersion(name); runtimeRequire.resolve(name); return result; }
      catch { return { name, expected: RUNTIME_PINS[name], available: false }; }
    }));
    return { available: manifestMatched && dependencies.every(item => item.available), manifestMatched, dependencies };
  } catch {
    return { available: false, dependencies: [], reason: 'Runtime manifest unavailable' };
  }
}
