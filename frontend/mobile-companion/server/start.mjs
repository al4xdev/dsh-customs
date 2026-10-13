import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMobileServer } from './index.mjs';
import { transformHtml } from './transform-html.mjs';

// Production exposes only listening options: no target, profile, auth seam,
// credential, or session-root override can be supplied by HTTP or CLI.
function parseOptions(args) {
  const options = { port: 3082, host: '127.0.0.1' };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!['--port', '--host'].includes(key) || seen.has(key) || value === undefined) throw new Error('Invalid arguments');
    seen.add(key);
    if (key === '--host') options.host = value;
    else {
      if (!/^\d+$/.test(value)) throw new Error('Invalid port');
      options.port = Number(value);
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid port');
    }
  }
  return options;
}
let app;
try {
  const { port, host } = parseOptions(process.argv.slice(2));
  const distDirectory = resolve(import.meta.dirname, '../dist');
  const manifest = JSON.parse(await readFile(resolve(distDirectory, 'asset-manifest.json'), 'utf8'));
  app = createMobileServer({ port, host, distDirectory, transformHtml: (html, options) => transformHtml(html, { ...options, manifest, distDirectory }) });
  await app.listen();
  // Never print startup URLs, cookies, boot data, or upstream errors.
  process.stdout.write(`Mobile companion listening on ${host}:${port}.\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await app.close(); }
    catch { process.exitCode = 1; }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch {
  process.stderr.write('Mobile companion startup failed. Build assets and verify the host and port.\n');
  process.exitCode = 1;
  await app?.close();
}
