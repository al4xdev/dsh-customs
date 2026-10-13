import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Model catalogs are public build inputs, not provider credential/config stores.
export function exportCatalog(source, output) {
  if (!path.isAbsolute(source) || !path.isAbsolute(output) || fs.existsSync(output)) throw Error('Require absolute source and absent output');
  const files = fs.readdirSync(source).filter(name => name.endsWith('.json') && name !== '.manifest.json').sort();
  const prepared = files.map(name => {
    const file = path.join(source, name);
    if (!fs.lstatSync(file).isFile()) throw Error('Unexpected catalog entry');
    const bytes = fs.readFileSync(file);
    function check(value, key = '') {
      if (/^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)$/i.test(key)) throw Error('Credential-like catalog field; publication refused');
      if (typeof value === 'string' && /https?:\/\/(?:[^/]*@|localhost\b|127\.|10\.|192\.168\.)/i.test(value)) throw Error('Private endpoint in catalog; publication refused');
      if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) check(v, k);
    }
    check(JSON.parse(bytes));
    return { name, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  fs.mkdirSync(output, { mode: 0o755 });
  for (const file of prepared) fs.writeFileSync(path.join(output, file.name), file.bytes, { flag: 'wx' });
  return { kind: 'public-model-catalog-source', files: prepared.map(({ name, sha256 }) => ({ name, sha256 })) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw Error('Usage: export-catalog.mjs ABS_SOURCE ABS_OUTPUT');
  console.log(JSON.stringify(exportCatalog(process.argv[2], process.argv[3]), null, 2));
}
