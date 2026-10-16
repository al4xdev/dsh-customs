// Pure part of the prompt audit: turn one capture (capture.mjs) into labelled parts,
// check the denylist, and render the reviewable baseline text. No I/O here, so the
// rules are unit-tested without a runtime (audit.test.mjs).
//
// Every part carries an origin:
// - harness: text the harness, its plugins or presets generated — denylist-checked
//   and written to the baseline;
// - owner: AGENTS/CLAUDE file bodies and personal skills — only a placeholder is kept
//   (the repo is public and these are not harness regressions);
// - probe: the audit's own user message.
import { createHash } from 'node:crypto';
import { dirname, basename } from 'node:path';

export const PROBE_TEXT = 'prompt-audit probe: reply with OK.';

// Phrases that must never appear in harness-generated text. Each was found steering
// the model on 2026-10-16; `fix` names the knob that removed it. Never weaken this list
// to make the audit pass: a hit is a regression to fix at its source.
export const DENYLIST = Object.freeze([
  { phrase: 'playful', source: 'dsh-working-activity status-line narration contract', fix: 'profile row `working-activity` config `narrate: false` (restate `publish`/`publishIntervalMs`: a config patch replaces the whole block)' },
  { phrase: '[Status line]', source: 'dsh-working-activity status-line narration contract', fix: 'profile row `working-activity` config `narrate: false`' },
  { phrase: 'powered by DeepSeek Harness', source: 'dsh-system-prompt harness identity section', fix: 'profile row `system-prompt` config `includeHarnessIdentity: false`' },
  { phrase: 'You are an AI agent', source: 'dsh-system-prompt harness identity section', fix: 'profile row `system-prompt` config `includeHarnessIdentity: false`' },
  { phrase: 'coding agent powered by', source: 'preset persona `{{model}}` prefix', fix: "every preset's `persona` row (`@deepseek-ai/dsh-persona`) config `prefix: ''`" },
  { phrase: 'You are a coding agent', source: 'dsh-tui bundle persona (DSH_TUI_PERSONA default) or a preset persona', fix: "profile row `system-prompt` config `personaPrefix: ''` and preset `persona` rows `prefix: ''`" },
  { phrase: 'Use them as guidance', source: 'dsh-agent-instructions wrapper around the owner AGENTS files', fix: 'reapply the hash-guarded SDK patch: `node tools/clean-install/agent-instructions.mjs --apply ~/.local/share/dsh-cli` (update its hashes for a new SDK build)' },
  { phrase: 'do not override system, developer', source: 'dsh-agent-instructions wrapper around the owner AGENTS files', fix: 'same SDK patch: `tools/clean-install/agent-instructions.mjs`' },
]);

const sha = text => createHash('sha256').update(text).digest('hex');
const squash = text => text.replace(/\s+/g, ' ').toLowerCase();

/** Stable JSON: object keys sorted, so digests do not depend on insertion order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Split `text` into the ordered named sections it was joined from (sections joined
 * with blank lines, as dsh-system-prompt renders). Text no section accounts for
 * becomes an `<unattributed>` part, so nothing can hide between labels.
 */
export function attribute(text, sections) {
  const parts = [];
  const empty = [];
  let cursor = 0;
  const gap = end => {
    const between = text.slice(cursor, end).replace(/^\n+|\n+$/g, '');
    if (between.length > 0) parts.push({ name: '<unattributed>', text: between });
  };
  for (const section of sections) {
    if (section.text.length === 0) { empty.push(section.name); continue; }
    const at = text.indexOf(section.text, cursor);
    if (at < 0) continue; // filtered or rewritten later in the pipeline: the gap shows the final text
    gap(at);
    parts.push({ name: section.name, text: section.text });
    cursor = at + section.text.length;
  }
  gap(text.length);
  return { parts, empty };
}

const INSTRUCTION_HEADER = /^(?:Updated instructions from|Additional instructions from|Instructions from): (.+)$/gim;

/**
 * Replace each instruction file body inside an agent-instructions message with
 * `<instructions: <display path>>`; wrapper text stays verbatim. Sizes and counts
 * are left out on purpose so editing an owner file never moves the baseline.
 * Headers are the renderer's `Instructions from: <displayPath>` lines; when the
 * message source lists its files, only those display paths count as headers, so an
 * owner file quoting such a line cannot split itself.
 */
export function sanitizeInstructions(text, displayPaths) {
  const known = displayPaths?.length ? new Set(displayPaths) : undefined;
  const headers = [...text.matchAll(INSTRUCTION_HEADER)].filter(match => !known || known.has(match[1]));
  if (headers.length === 0) return { text, files: [] };
  const close = text.lastIndexOf('\n</system-reminder>');
  const files = [];
  let out = '';
  let cursor = 0;
  // Layout (dsh-agent-instructions render): `<header>\n\n<body>` per file, files joined
  // by a blank line, the last body followed by `\n</system-reminder>`.
  headers.forEach((header, index) => {
    const last = index === headers.length - 1;
    const bodyStart = header.index + header[0].length;
    const next = last ? (close > bodyStart ? close : text.length) : headers[index + 1].index;
    let body = text.slice(bodyStart, next);
    const lead = body.startsWith('\n\n') ? '\n\n' : '';
    const trail = !last && body.endsWith('\n\n') ? '\n\n' : '';
    body = body.slice(lead.length, body.length - trail.length);
    const bytes = Buffer.byteLength(body, 'utf8');
    files.push({ path: header[1], bytes });
    out += text.slice(cursor, bodyStart) + lead + `<instructions: ${header[1]}>` + trail;
    cursor = next;
  });
  return { text: out + text.slice(cursor), files };
}

/** Where a skill came from: shipped with the runtime or this repo, or owned by the user. */
export function skillOrigin(skill, { runtime, repo }) {
  if (!skill) return 'owner';
  if (['bundled', 'runtime'].includes(skill.source)) return 'harness';
  const path = skill.path ?? '';
  if ((runtime && path.startsWith(`${runtime}/`)) || (repo && path.startsWith(`${repo}/`))) return 'harness';
  return 'owner';
}

const skillRoot = path => (basename(path) === 'SKILL.md' ? dirname(dirname(path)) : dirname(path));

/**
 * Collapse owner skill lines (`- \`name\`: description`) of a catalog into one
 * `<owner skills: <root>>` line per root; harness skills stay verbatim.
 */
export function sanitizeCatalog(text, skills, roots) {
  const byName = new Map(skills.map(skill => [skill.name, skill]));
  const lines = text.split('\n');
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const match = /^- `([^`]+)`: /.exec(line);
    const skill = match && byName.get(match[1]);
    if (!match || skillOrigin(skill, roots) === 'harness') { out.push(line); continue; }
    const root = skill?.path ? skillRoot(skill.path) : '<unknown root>';
    if (!seen.has(root)) { seen.add(root); out.push({ root }); }
  }
  return out.map(line => (typeof line === 'string' ? line : `<owner skills: ${line.root}>`)).join('\n');
}

const textOf = message => message.content.map(block => (block.type === 'text' ? block.text : `<${block.type} block>`)).join('\n');

/** Labelled parts of one capture; see the module comment for origins. */
export function buildDocument(capture, roots = {}) {
  const request = capture.request;
  if (!request) throw new Error('capture holds no model request');
  const messages = request.messages.map((message, position) => {
    const source = message.source ?? {};
    const kind = source.kind ?? message.role;
    const text = textOf(message);
    const header = { index: position + 1, role: message.role, kind, form: source.form ?? null };
    if (message.role === 'system') {
      const { parts, empty } = attribute(text, capture.systemSections ?? []);
      return { ...header, empty, parts: parts.map(part => ({ label: part.name === '<unattributed>' ? part.name : `section ${part.name}`, origin: 'harness', text: part.text })) };
    }
    if (kind === 'user' && text === PROBE_TEXT) return { ...header, parts: [{ label: 'probe', origin: 'probe', text: '<probe>' }] };
    if (kind === 'agent-instructions') {
      const paths = (source.changes ?? []).map(change => change.path).filter(Boolean);
      const sanitized = sanitizeInstructions(text, paths);
      return { ...header, files: sanitized.files, parts: [{ label: 'wrapper + placeholders', origin: 'harness', text: sanitized.text }] };
    }
    if (kind === 'skill-catalog') {
      return { ...header, parts: [{ label: 'catalog', origin: 'harness', text: sanitizeCatalog(text, capture.skills ?? [], roots) }] };
    }
    if (Array.isArray(source.sections)) {
      const { parts } = attribute(text, source.sections);
      return { ...header, parts: parts.map(part => ({ label: part.name === '<unattributed>' ? 'wrapper' : `section ${part.name}`, origin: 'harness', text: part.text })) };
    }
    return { ...header, parts: [{ label: 'text', origin: 'harness', text }] };
  });
  const tools = (request.tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? {},
    deferLoading: tool.deferLoading === true,
    digest: sha(canonicalJson({ description: tool.description, parameters: tool.parameters, deferLoading: tool.deferLoading })).slice(0, 12),
  }));
  return {
    profile: capture.profile,
    bundles: capture.bundles ?? [],
    preset: capture.preset,
    presets: capture.presets ?? [],
    route: { provider: request.provider, model: request.model },
    messages,
    tools,
    toolOrder: tools.map(tool => tool.name),
  };
}

/** Every denylisted phrase in harness text, with the exact place it was found. */
export function findDenylisted(document, denylist = DENYLIST) {
  const places = [];
  for (const message of document.messages) {
    for (const part of message.parts) {
      if (part.origin === 'harness') places.push({ where: `message ${message.index} (${message.role}/${message.kind}) › ${part.label}`, text: part.text });
    }
  }
  for (const tool of document.tools) {
    places.push({ where: `tool ${tool.name} › description`, text: tool.description });
    places.push({ where: `tool ${tool.name} › parameters`, text: JSON.stringify(tool.parameters) });
  }
  const hits = [];
  for (const entry of denylist) {
    const needle = squash(entry.phrase);
    for (const place of places) {
      const collapsed = place.text.replace(/\s+/g, ' ');
      const haystack = squash(place.text);
      const at = haystack.indexOf(needle);
      if (at < 0) continue;
      // Lower-casing keeps positions for all but a few exotic code points.
      const shown = haystack.length === collapsed.length ? collapsed : haystack;
      hits.push({ ...entry, where: place.where, excerpt: shown.slice(Math.max(0, at - 60), at + needle.length + 60) });
    }
  }
  return hits;
}

/**
 * Fail-closed privacy check: lines (40+ characters; shorter wrapped tails such as
 * "authorize execution." also occur in harness text) of owner files that appear in the
 * rendered text. The sanitizers above work on the renderer's known layouts; this scan
 * catches any layout they do not know before a baseline reaches the public repo.
 */
export function findOwnerLeaks(rendered, ownerFiles) {
  const leaks = [];
  for (const { path, text } of ownerFiles) {
    const line = text.split('\n').map(item => item.trim()).find(item => item.length >= 40 && rendered.includes(item));
    if (line !== undefined) leaks.push(path);
  }
  return leaks;
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Normalize machine- and run-specific values so the baseline is comparable across
 * runs and machines. `paths` is an ordered list of [absolute path, token]; longer
 * paths are replaced first so nested locations keep their most specific token.
 */
export function normalize(text, paths = []) {
  let out = text;
  for (const [path, token] of [...paths].filter(([path]) => path).sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`${escapeRegExp(path)}(?=$|[/"'\`\\s),:;.?*\\]}>])`, 'g'), token);
  }
  return out
    .replace(/\/[^\s"'`]*\/dsh-prompt-audit-[A-Za-z0-9]+/g, '<temp>')
    .replace(/\/(?:home|Users)\/[A-Za-z0-9._-]+(?=$|[/"'`\s),:;\]}>])/g, '~')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, '<date>')
    .replace(/\b(127\.0\.0\.1|localhost):\d{2,5}\b/g, '$1:<port>');
}

function schemaType(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) return `${schema.type ?? 'enum'} one of ${schema.enum.map(value => JSON.stringify(value)).join('|')}`;
  if ('const' in schema) return `const ${JSON.stringify(schema.const)}`;
  for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[key])) return `${key} ${schema[key].map(schemaType).join(' | ')}`;
  if (schema.type === 'array') return `array of ${schemaType(schema.items)}`;
  return Array.isArray(schema.type) ? schema.type.join('|') : schema.type ?? 'any';
}

/** Model-facing text of a JSON schema as an indented property list. */
export function renderSchema(schema, indent = '  ') {
  const lines = [];
  const walk = (node, pad) => {
    const target = node?.type === 'array' ? node.items : node;
    const properties = target?.properties;
    if (!properties || typeof properties !== 'object') return;
    const required = new Set(target.required ?? []);
    for (const name of Object.keys(properties)) {
      const property = properties[name] ?? {};
      const flags = [schemaType(property), required.has(name) ? 'required' : null, 'default' in property ? `default ${JSON.stringify(property.default)}` : null].filter(Boolean).join(', ');
      const description = property.description ? `: ${property.description.replaceAll('\n', `\n${pad}    `)}` : '';
      lines.push(`${pad}- ${name} (${flags})${description}`);
      walk(property, `${pad}  `);
    }
  };
  if (schema?.description) lines.push(`${indent}${schema.description}`);
  walk(schema, indent);
  return lines;
}

export const BASELINE_HEADER = [
  '# DSH prompt audit baseline. Harness-generated text of the first model request,',
  '# composed offline by tools/prompt-audit/audit.mjs. Owner AGENTS/CLAUDE files and',
  '# personal skills appear only as placeholders. Do not edit by hand: review a diff',
  "# line by line and accept it with --update only with the owner's explicit OK.",
];

/**
 * The reviewable text of one document. `full` adds the raw JSON schema of every tool,
 * for local review only (never the committed baseline).
 */
export function renderDocument(document, { paths = [], full = false } = {}) {
  const n = text => normalize(text, paths);
  const lines = [...BASELINE_HEADER, ''];
  lines.push(`profile: ${document.profile}`);
  lines.push(`bundles: ${document.bundles.join(', ') || '(none)'}`);
  lines.push(`preset: ${document.preset ?? '(none: host composition)'}`);
  lines.push(`presets: ${[...document.presets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(row => (row.broken ? `${row.id} [broken: ${n(row.broken)}]` : row.id)).join(', ') || '(none)'}`);
  lines.push(`messages: ${document.messages.map(message => `${message.role}/${message.kind}`).join(', ')}`);
  lines.push(`tool order: ${document.toolOrder.join(', ')}`);
  for (const message of document.messages) {
    lines.push('', `==== message ${message.index}: ${message.role}/${message.kind}${message.form ? ` (${message.form})` : ''}`);
    if (message.empty?.length) lines.push(`(empty sections: ${message.empty.join(', ')})`);
    for (const part of message.parts) {
      if (message.parts.length > 1 || part.label.startsWith('section')) lines.push(`---- ${part.label}`);
      lines.push(n(part.text));
    }
  }
  lines.push('', `==== tools (${document.tools.length}, sorted by name)`);
  for (const tool of [...document.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    lines.push('', `---- tool ${tool.name} [sha256 ${tool.digest}]${tool.deferLoading ? ' [deferLoading]' : ''}`);
    lines.push(n(tool.description));
    const schema = renderSchema(tool.parameters).map(n);
    if (schema.length) lines.push('parameters:', ...schema);
    if (full) lines.push('raw parameters:', n(JSON.stringify(tool.parameters, null, 2)));
  }
  return `${lines.join('\n').replace(/[ \t]+$/gm, '')}\n`;
}

/** Unified line diff (3 lines of context), or '' when equal. LCS over lines. */
export function unifiedDiff(before, after, { from = 'baseline', to = 'current', context = 3 } = {}) {
  if (before === after) return '';
  // One trailing newline ends the last line; it is not an extra empty line.
  const lines = text => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const a = lines(before), b = lines(after);
  const cols = b.length + 1;
  if ((a.length + 1) * cols > 40_000_000) return `--- ${from}\n+++ ${to}\n(too large for an inline diff: compare the files with git diff --no-index)\n`;
  const table = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  // ops: [mark, line, index in a, index in b] at the moment the op is emitted.
  const ops = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push([' ', a[i], i, j]); i += 1; j += 1; }
    else if (i < a.length && (j === b.length || table[(i + 1) * cols + j] >= table[i * cols + j + 1])) { ops.push(['-', a[i], i, j]); i += 1; }
    else { ops.push(['+', b[j], i, j]); j += 1; }
  }
  const changed = ops.flatMap((op, index) => (op[0] === ' ' ? [] : [index]));
  const out = [`--- ${from}`, `+++ ${to}`];
  for (let g = 0; g < changed.length;) {
    let h = g;
    // Changes separated by at most 2*context unchanged lines share one hunk.
    while (h + 1 < changed.length && changed[h + 1] - changed[h] <= 2 * context + 1) h += 1;
    const hunk = ops.slice(Math.max(0, changed[g] - context), Math.min(ops.length, changed[h] + context + 1));
    const oldCount = hunk.filter(op => op[0] !== '+').length, newCount = hunk.filter(op => op[0] !== '-').length;
    out.push(`@@ -${hunk[0][2] + (oldCount ? 1 : 0)},${oldCount} +${hunk[0][3] + (newCount ? 1 : 0)},${newCount} @@`, ...hunk.map(op => op[0] + op[1]));
    g = h + 1;
  }
  return `${out.join('\n')}\n`;
}
