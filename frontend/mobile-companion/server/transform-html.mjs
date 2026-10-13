import { readFile, writeFile, mkdir, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptNativeChat } from './native-adaptations.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 24);
const pkg = name => `@deepseek-ai/${name}`;
const workspaceId = pkg('dsh-client-ui-workspace');
const roots = ['dsh-client-modules', 'dsh-client-ui-layout', 'dsh-client-ui-chat', 'dsh-client-ui-conversation', 'dsh-client-ui-approval', 'dsh-client-ui-user-questions', 'dsh-client-ui-tool', 'dsh-client-ui-jobs', 'dsh-client-ui-attachment'];
const cache = new Map();
const bootPattern = /((?:globalThis|window)\s*(?:\[\s*["']__DSH_BOOT__["']\s*\]|\.__DSH_BOOT__)\s*=\s*)(\{[^]*?\})(\s*;?\s*(?=<\/script>))/;

export function readBootGraph(html) {
  const match = html.match(bootPattern);
  if (!match) throw Error('The backend did not provide the supported DSH Web bootstrap');
  const graph = JSON.parse(match[2]);
  if (!Array.isArray(graph.entries) || !Array.isArray(graph.batches)) throw Error('Unsupported DSH boot graph');
  return graph;
}

export function composeMobileGraph(graph, manifest) {
  const byId = new Map(graph.entries.map(entry => [entry.id, entry]));
  if (!byId.has(workspaceId)) throw Error('Missing supported Web workspace module');
  byId.set(workspaceId, manifest.workspace);
  const kept = new Set();
  function retain(id) {
    if (kept.has(id)) return;
    const entry = byId.get(id);
    // Non-graph ids are baseline runtime seeds (React, store and primitives).
    if (!entry) return;
    kept.add(id);
    for (const dependency of [...(entry.inject ?? []), ...(entry.external ?? [])]) retain(dependency);
  }
  for (const name of roots) {
    if (!byId.has(pkg(name))) throw Error(`Missing required renderer module ${name}`);
    retain(pkg(name));
  }
  const entries = graph.entries.filter(entry => kept.has(entry.id)).map(entry => entry.id === workspaceId ? { ...manifest.workspace } : { ...entry });
  entries.push({ ...manifest.mobile });
  return { rev: hash(`${graph.rev}:${manifest.mobile.rev}:${manifest.workspace.rev}`), entries, batches: [] };
}

async function publish(dist, filename, code) {
  // Publish complete bytes atomically and never replace an immutable revision.
  // Concurrent HTML requests must not observe another request's partial write.
  const directory = resolve(dist);
  const destination = resolve(directory, filename);
  const temporary = resolve(directory, `.publish-${randomUUID()}.tmp`);
  if (dirname(destination) !== directory || dirname(temporary) !== directory) throw Error('Invalid asset destination');
  await writeFile(temporary, code, { flag: 'wx', mode: 0o600 });
  try {
    try { await link(temporary, destination); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Existing files are only trusted if they are the same immutable generation.
    if (await readFile(destination, 'utf8') !== code) throw Error('Runtime asset integrity mismatch');
  } finally { await unlink(temporary); }
  return `/mobile-assets/${filename}`;
}

export async function transformHtml(html, options = {}) {
  const dist = options.distDirectory ?? join(project, 'dist');
  const manifest = options.manifest ?? JSON.parse(await readFile(join(dist, 'asset-manifest.json'), 'utf8'));
  const original = readBootGraph(html);
  const key = `${dist}:${original.rev}:${manifest.workspace.rev}:${manifest.mobile.rev}`;
  let graph = cache.get(key);
  if (!graph) {
    graph = composeMobileGraph(original, manifest);
    await mkdir(dist, { recursive: true });
    const sources = new Map();
    for (const entry of graph.entries) {
      let code;
      if (entry.id === workspaceId) code = await readFile(join(dist, 'workspace.js'), 'utf8');
      else if (entry.id === manifest.mobile.id) code = await readFile(join(dist, 'mobile.js'), 'utf8');
      else {
        if (!/^@deepseek-ai\/[a-z0-9-]+$/.test(entry.id)) throw Error('Unsupported module namespace');
        const directory = join(manifest.runtimeDirectory, entry.id);
        const info = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (info.version !== manifest.runtimeVersion) throw Error('Renderer runtime version mismatch');
        code = await readFile(join(directory, 'lib/client.js'), 'utf8');
        if (entry.id === pkg('dsh-client-ui-chat')) code = adaptNativeChat(code);
      }
      sources.set(entry.id, code);
      entry.url = await publish(dist, `runtime-${hash(code)}.js`, code);
      entry.rev = hash(code);
    }
    for (const phase of ['bootstrap', 'application']) {
      const entries = graph.entries.filter(entry => (entry.id === pkg('dsh-client-modules')) === (phase === 'bootstrap'));
      const code = entries.map(entry => sources.get(entry.id)).join('\n;\n');
      const url = await publish(dist, `runtime-${hash(code)}.js`, code);
      graph.batches.push({ phase, url, rev: hash(code), entries: entries.map(entry => entry.id) });
    }
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(key, graph);
  }
  // Original application combos register the original workspace factory, even
  // when its row URL is changed. Replace every preload/bootstrap combo as well
  // as the graph; the desktop restoreSelection code must never execute here.
  const oldBatches = new Set(original.batches.map(batch => batch.url));
  let output = html.replace(/<(script|link)\b[^>]*>/gi, tag => {
    const url = tag.match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1];
    if (!oldBatches.has(url)) return tag;
    const phase = original.batches.find(batch => batch.url === url).phase;
    if (phase === 'bootstrap') return tag.replace(url, graph.batches.find(batch => batch.phase === phase).url);
    return ''; // Replaced by a single application preload below.
  });
  output = output.replace(bootPattern, (...[, prefix, , suffix]) => `${prefix}${JSON.stringify(graph).replace(/</g, '\\u003c')}${suffix}`);
  const application = graph.batches.find(batch => batch.phase === 'application');
  output = output.replace('</head>', `<link rel="preload" as="script" href="${application.url}"><link rel="stylesheet" href="${manifest.stylesheet}"></head>`);
  output = output.replace(/<html\b[^>]*>/i, '<html lang="pt-BR">').replace(/<title>[^]*?<\/title>/i, '<title>Companion</title>');
  output = output.replace(/<link\b[^>]*rel="manifest"[^>]*>/i, '<link rel="manifest" href="/mobile-assets/mobile.webmanifest">');
  output = output.replace(/<link\b[^>]*rel="icon"[^>]*>/gi, '');
  output = output.replace('</head>', '<link rel="icon" type="image/svg+xml" href="/mobile-assets/icon.svg"></head>');
  output = output.replace(/content="width=device-width, initial-scale=1"/, 'content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"');
  return output;
}
